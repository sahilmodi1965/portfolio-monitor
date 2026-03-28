import type { EnrichedHolding, Config, StockSignal, Signal, SectorSummary } from './types.js';
import { pctChange } from './utils.js';

/** Determine if a holding is oil-sensitive based on sector + industry against config keywords. */
function isOilSensitiveHolding(sector: string, industry: string, oilSensitiveSectors: string[]): boolean {
  const combined = (sector + ' ' + industry).toLowerCase();
  return oilSensitiveSectors.some(s => combined.includes(s.toLowerCase()));
}

/** Layer 1: Per-stock signals. Returns worst signal + reasons. */
export function computeStockSignal(
  holding: EnrichedHolding,
  config: Config,
  portfolioValue: number
): StockSignal {
  const t = config.thresholds;
  const reasons: string[] = [];
  let signal: Signal = 'HOLD';

  const positionPct = portfolioValue > 0 ? (holding.currentPrice * holding.qty / portfolioValue) * 100 : 0;
  const isTiny = positionPct < t.tiny_position_pct;
  const isOilSensitive = isOilSensitiveHolding(holding.sector, holding.industry, config.oil_sensitive_sectors);

  // Trailing stop: down >15% from 52w high
  if (holding.fiftyTwoWeekHigh > 0) {
    const dropFrom52w = ((holding.fiftyTwoWeekHigh - holding.currentPrice) / holding.fiftyTwoWeekHigh) * 100;

    if (dropFrom52w > t.trailing_stop_pct) {
      signal = 'EXIT';
      reasons.push(`Down ${dropFrom52w.toFixed(1)}% from 52-week high (trailing stop at ${t.trailing_stop_pct}%)`);
    }

    // 52w drawdown thresholds
    if (dropFrom52w > t.drawdown_exit_pct) {
      signal = 'EXIT';
      reasons.push(`Down ${dropFrom52w.toFixed(1)}% from 52w high — major drawdown`);
    } else if (isOilSensitive && dropFrom52w > t.drawdown_oil_exit_pct) {
      signal = 'EXIT';
      reasons.push(`Oil-sensitive stock down ${dropFrom52w.toFixed(1)}% from 52w high`);
    } else if (dropFrom52w > t.drawdown_watch_pct && signal !== 'EXIT') {
      signal = 'WATCH';
      reasons.push(`Down ${dropFrom52w.toFixed(1)}% from 52w high — significant drawdown`);
    }
  }

  // Momentum: 4-week price trend
  if (holding.weeklyPrices.length >= 2) {
    const oldest = holding.weeklyPrices[0];
    const newest = holding.weeklyPrices[holding.weeklyPrices.length - 1];
    const momentum = pctChange(oldest, newest);

    if (momentum < -t.momentum_exit_pct) {
      signal = 'EXIT';
      reasons.push(`4-week momentum ${momentum.toFixed(1)}% (exit at -${t.momentum_exit_pct}%)`);
    } else if (momentum < -t.momentum_watch_pct && signal !== 'EXIT') {
      signal = 'WATCH';
      reasons.push(`4-week momentum ${momentum.toFixed(1)}% (watch at -${t.momentum_watch_pct}%)`);
    }
  }

  // Tiny position downgrade: EXIT → WATCH
  if (signal === 'EXIT' && isTiny) {
    signal = 'WATCH';
    reasons.push(`Tiny position (${positionPct.toFixed(2)}% of portfolio) — downgraded from EXIT`);
  }

  if (reasons.length === 0) {
    reasons.push('No signal rules triggered');
  }

  return { instrument: holding.instrument, signal, reasons };
}

/** Layer 2: Sector overlay. Modifies signals in-place based on sector concentration and oil sensitivity. */
export function applySectorOverlay(
  signals: Record<string, StockSignal>,
  holdings: EnrichedHolding[],
  config: Config,
  brentPrice: number | null,
  sectors: Record<string, SectorSummary>
): void {
  const t = config.thresholds;

  // Check sector concentration: any sector >25% → WATCH largest holdings
  for (const [sectorName, summary] of Object.entries(sectors)) {
    if (summary.pct > t.sector_concentration_pct) {
      const sectorHoldings = holdings
        .filter(h => h.sector === sectorName)
        .sort((a, b) => (b.currentPrice * b.qty) - (a.currentPrice * a.qty));

      // WATCH the top 3 largest holdings in over-concentrated sector
      for (const h of sectorHoldings.slice(0, 3)) {
        const sig = signals[h.instrument];
        if (sig && sig.signal === 'HOLD') {
          sig.signal = 'WATCH';
          sig.reasons.push(`Sector "${sectorName}" is ${summary.pct.toFixed(1)}% of portfolio (limit: ${t.sector_concentration_pct}%)`);
        }
      }
    }
  }

  // Oil sensitivity gate — compute oil concentration directly from holdings
  if (brentPrice !== null) {
    const portfolioValue = holdings.reduce((sum, h) => sum + h.currentPrice * h.qty, 0);
    const oilHoldings = holdings.filter(h =>
      isOilSensitiveHolding(h.sector, h.industry, config.oil_sensitive_sectors)
    );
    const oilValue = oilHoldings.reduce((sum, h) => sum + h.currentPrice * h.qty, 0);
    const totalOilPct = portfolioValue > 0 ? (oilValue / portfolioValue) * 100 : 0;

    if (totalOilPct > t.oil_sector_concentration_pct && brentPrice > t.brent_crisis_usd) {
      // Brent crisis: EXIT all oil-sensitive
      for (const h of oilHoldings) {
        const sig = signals[h.instrument];
        if (sig) {
          sig.signal = 'EXIT';
          sig.reasons.push(`Oil sector ${totalOilPct.toFixed(1)}% of portfolio + Brent $${brentPrice.toFixed(0)} > $${t.brent_crisis_usd} crisis threshold`);
        }
      }
    } else if (totalOilPct > t.oil_sector_concentration_pct && brentPrice > t.brent_watch_usd) {
      // Brent watch: WATCH all oil-sensitive
      for (const h of oilHoldings) {
        const sig = signals[h.instrument];
        if (sig && sig.signal === 'HOLD') {
          sig.signal = 'WATCH';
          sig.reasons.push(`Oil sector ${totalOilPct.toFixed(1)}% + Brent $${brentPrice.toFixed(0)} > $${t.brent_watch_usd} watch threshold`);
        }
      }
    }
  }
}

/** Layer 3: Portfolio circuit breaker. Returns status string if triggered, null otherwise. */
export function checkCircuitBreaker(
  totalPnlPct: number,
  config: Config
): string | null {
  const t = config.thresholds;

  if (totalPnlPct < -t.portfolio_exit_pct) {
    return `EMERGENCY EXIT — Portfolio down ${Math.abs(totalPnlPct).toFixed(1)}% (threshold: ${t.portfolio_exit_pct}%). Consider reducing all positions.`;
  }
  if (totalPnlPct < -t.portfolio_reduce_pct) {
    return `REDUCE — Portfolio down ${Math.abs(totalPnlPct).toFixed(1)}% (threshold: ${t.portfolio_reduce_pct}%). Consider trimming losing positions.`;
  }
  if (totalPnlPct < -t.portfolio_caution_pct) {
    return `CAUTION — Portfolio down ${Math.abs(totalPnlPct).toFixed(1)}% (threshold: ${t.portfolio_caution_pct}%). Review EXIT and WATCH signals carefully.`;
  }

  return null;
}

/** Compute all signals for all holdings (3 layers). */
export function computeSignals(
  holdings: EnrichedHolding[],
  config: Config,
  brentPrice: number | null,
  sectors: Record<string, SectorSummary>
): { signals: Record<string, StockSignal>; circuitBreaker: string | null } {
  const portfolioValue = holdings.reduce((sum, h) => sum + h.currentPrice * h.qty, 0);
  const totalInvested = holdings.reduce((sum, h) => sum + h.invested, 0);
  const totalPnlPct = totalInvested > 0 ? ((portfolioValue - totalInvested) / totalInvested) * 100 : 0;

  // Layer 1: Per-stock signals
  const signals: Record<string, StockSignal> = {};
  for (const h of holdings) {
    signals[h.instrument] = computeStockSignal(h, config, portfolioValue);
  }

  // Layer 2: Sector overlay
  applySectorOverlay(signals, holdings, config, brentPrice, sectors);

  // Layer 3: Circuit breaker
  const circuitBreaker = checkCircuitBreaker(totalPnlPct, config);

  return { signals, circuitBreaker };
}
