import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHoldingsCSV } from './csv-parser.js';
import { enrichHoldings } from './enricher.js';
import { computeSignals } from './signals.js';
import { computeStrategy } from './strategy.js';
import { computeDailyActions } from './actions.js';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { log, err, formatINR } from './utils.js';
import type { DashboardData, EnrichedHolding, StockSignal, SectorSummary } from './types.js';

/** Build sector summary from enriched holdings. */
function buildSectorSummary(
  holdings: EnrichedHolding[],
  totalValue: number,
  oilSensitiveSectors: string[]
): Record<string, SectorSummary> {
  const sectors: Record<string, SectorSummary> = {};

  for (const h of holdings) {
    const key = h.sector || 'Unknown';
    if (!sectors[key]) {
      sectors[key] = { count: 0, value: 0, pct: 0, isOilSensitive: false };
    }
    sectors[key].count++;
    sectors[key].value += h.currentPrice * h.qty;
    // Check both sector and industry against oil-sensitive keywords
    if (!sectors[key].isOilSensitive) {
      const combined = (key + ' ' + (h.industry || '')).toLowerCase();
      sectors[key].isOilSensitive = oilSensitiveSectors.some(
        s => combined.includes(s.toLowerCase())
      );
    }
  }

  // Compute percentages
  for (const key of Object.keys(sectors)) {
    sectors[key].pct = totalValue > 0 ? (sectors[key].value / totalValue) * 100 : 0;
  }

  return sectors;
}

/** Log signal changes to data/signal-history.json. */
function updateSignalHistory(signals: Record<string, StockSignal>): void {
  const historyPath = resolve(PROJECT_ROOT, 'data', 'signal-history.json');
  let history: Array<{ date: string; signals: Record<string, string> }> = [];

  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(readFileSync(historyPath, 'utf-8'));
    } catch {
      history = [];
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const todaySignals: Record<string, string> = {};
  for (const [sym, sig] of Object.entries(signals)) {
    if (sig.signal !== 'HOLD') {
      todaySignals[sym] = sig.signal;
    }
  }

  // Replace today's entry if it exists, otherwise append
  const existing = history.findIndex(e => e.date === today);
  if (existing >= 0) {
    history[existing].signals = todaySignals;
  } else {
    history.push({ date: today, signals: todaySignals });
  }

  // Keep last 90 days
  if (history.length > 90) history = history.slice(-90);

  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

async function main() {
  const startTime = Date.now();
  log('=== Portfolio Monitor Pipeline ===');

  // Load config
  const config = loadConfig();
  log('Config loaded');

  // Parse CSV
  const csvPath = resolve(PROJECT_ROOT, 'holdings.csv');
  const holdings = parseHoldingsCSV(csvPath);
  log(`Parsed ${holdings.length} holdings from CSV`);

  if (holdings.length === 0) {
    err('No holdings found in CSV. Aborting.');
    process.exit(1);
  }

  // Enrich with Yahoo Finance
  const { enriched, brentPrice } = await enrichHoldings(holdings, config);

  // Compute portfolio totals
  const totalInvested = enriched.reduce((sum, h) => sum + h.invested, 0);
  const currentValue = enriched.reduce((sum, h) => sum + (h.currentPrice * h.qty), 0);
  const totalPnl = currentValue - totalInvested;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  // Build sector summary
  const sectors = buildSectorSummary(enriched, currentValue, config.oil_sensitive_sectors);

  // Compute signals (3 layers: per-stock, sector overlay, circuit breaker)
  const { signals, circuitBreaker } = computeSignals(enriched, config, brentPrice, sectors);

  // Log signal summary
  const exitCount = Object.values(signals).filter(s => s.signal === 'EXIT').length;
  const watchCount = Object.values(signals).filter(s => s.signal === 'WATCH').length;
  const holdCount = Object.values(signals).filter(s => s.signal === 'HOLD').length;
  log(`Signals: ${exitCount} EXIT, ${watchCount} WATCH, ${holdCount} HOLD`);
  if (circuitBreaker) log(`Circuit breaker: ${circuitBreaker}`);

  // Write signal history
  updateSignalHistory(signals);

  // Compute strategy
  const strategy = computeStrategy(enriched, config, brentPrice, sectors, signals);
  log(`Strategy: ${strategy.consolidation.cut.length} CUT, ${strategy.consolidation.keep.length} KEEP, ${strategy.consolidation.scaleUp.length} SCALE UP`);
  log(`Freed capital from consolidation: ${formatINR(strategy.consolidation.freed_capital)}`);

  // Top winners and bleeders
  const sorted = [...enriched].sort((a, b) => b.pnl - a.pnl);
  const topWinners = sorted.slice(0, 5);
  const topBleeders = sorted.slice(-5).reverse();

  // Build dashboard data
  const dashboardData: DashboardData = {
    generated_at: new Date().toISOString(),
    portfolio: {
      total_invested: totalInvested,
      current_value: currentValue,
      total_pnl: totalPnl,
      total_pnl_pct: totalPnlPct,
      holdings_count: enriched.length,
    },
    holdings: enriched,
    signals,
    sectors,
    top_winners: topWinners,
    top_bleeders: topBleeders,
    brent_price: brentPrice,
    circuit_breaker: circuitBreaker,
  };

  // Write to public/
  const publicDir = resolve(PROJECT_ROOT, 'public');
  mkdirSync(publicDir, { recursive: true });
  const outputPath = resolve(publicDir, 'dashboard-data.json');
  writeFileSync(outputPath, JSON.stringify(dashboardData, null, 2));

  // Write strategy data
  const strategyPath = resolve(publicDir, 'strategy-data.json');
  writeFileSync(strategyPath, JSON.stringify(strategy, null, 2));
  log('Strategy data written');

  // Compute and write daily actions
  const actions = computeDailyActions(enriched, strategy, brentPrice);
  const actionsPath = resolve(publicDir, 'actions-data.json');
  writeFileSync(actionsPath, JSON.stringify(actions, null, 2));
  log(`Daily actions: ${actions.todays_sells.length} sells, ${actions.todays_buys.length} buys, ${actions.watch_list.length} watch`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Dashboard data written to ${outputPath}`);
  log(`Portfolio: ${formatINR(currentValue)} (P&L: ${formatINR(totalPnl)})`);
  log(`Completed in ${elapsed}s`);
}

main().catch(e => {
  err(`Pipeline failed: ${e.message}`);
  process.exit(1);
});
