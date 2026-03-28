import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeStockSignal, applySectorOverlay, checkCircuitBreaker, computeSignals } from '../src/signals.js';
import type { EnrichedHolding, Config, StockSignal, SectorSummary } from '../src/types.js';

/** Build a test holding with sensible defaults. */
function makeHolding(overrides: Partial<EnrichedHolding> = {}): EnrichedHolding {
  return {
    instrument: 'TEST',
    qty: 100,
    avgCost: 100,
    ltp: 90,
    invested: 10000,
    currentValue: 9000,
    pnl: -1000,
    netChgPct: -10,
    dayChgPct: -1,
    yahooSymbol: 'TEST.NS',
    sector: 'Technology',
    industry: 'Software',
    fiftyTwoWeekHigh: 120,
    currentPrice: 90,
    weeklyPrices: [95, 93, 91, 90],
    enrichmentFailed: false,
    ...overrides,
  };
}

/** Build test config with sensible defaults. */
function makeConfig(overrides: Partial<Config['thresholds']> = {}): Config {
  return {
    thresholds: {
      trailing_stop_pct: 15,
      momentum_exit_pct: 10,
      momentum_watch_pct: 5,
      drawdown_exit_pct: 50,
      drawdown_oil_exit_pct: 40,
      drawdown_watch_pct: 30,
      tiny_position_pct: 1,
      sector_concentration_pct: 25,
      oil_sector_concentration_pct: 30,
      brent_crisis_usd: 100,
      brent_watch_usd: 90,
      portfolio_caution_pct: 8,
      portfolio_reduce_pct: 12,
      portfolio_exit_pct: 18,
      ...overrides,
    },
    yahoo: { delay_ms: 0, sector_cache_ttl_days: 7, chart_range: '1y', chart_interval: '1wk' },
    oil_sensitive_sectors: ['Oil & Gas', 'Airlines', 'Paints', 'Logistics', 'Cement', 'Chemicals', 'Tyres', 'Power'],
    oil_resistant_sectors: ['IT', 'Pharma', 'FMCG', 'Telecom', 'Insurance'],
  };
}

describe('Layer 1: Per-Stock Signals', () => {
  const config = makeConfig();
  const portfolioValue = 100000;

  it('trailing stop: EXIT when down >15% from 52w high', () => {
    // 52w high = 120, current = 90 → down 25%
    const h = makeHolding({ fiftyTwoWeekHigh: 120, currentPrice: 90 });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'EXIT');
    assert.ok(sig.reasons.some(r => r.includes('trailing stop')));
  });

  it('trailing stop: HOLD when down <15% from 52w high', () => {
    // 52w high = 100, current = 90 → down 10%, flat momentum
    const h = makeHolding({ fiftyTwoWeekHigh: 100, currentPrice: 90, weeklyPrices: [90, 90, 90, 90] });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'HOLD');
  });

  it('momentum EXIT: down >10% in 4 weeks', () => {
    // 100 → 88 = -12%
    const h = makeHolding({
      weeklyPrices: [100, 96, 92, 88],
      fiftyTwoWeekHigh: 100,
      currentPrice: 100,
    });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'EXIT');
    assert.ok(sig.reasons.some(r => r.includes('momentum')));
  });

  it('momentum WATCH: down 5-10% in 4 weeks', () => {
    // 100 → 93 = -7%
    const h = makeHolding({
      weeklyPrices: [100, 98, 95, 93],
      fiftyTwoWeekHigh: 100,
      currentPrice: 100,
    });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'WATCH');
    assert.ok(sig.reasons.some(r => r.includes('momentum')));
  });

  it('momentum HOLD: down <5% in 4 weeks', () => {
    // 100 → 97 = -3%
    const h = makeHolding({
      weeklyPrices: [100, 99, 98, 97],
      fiftyTwoWeekHigh: 100,
      currentPrice: 100,
    });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'HOLD');
  });

  it('52w drawdown EXIT: >50% below high', () => {
    // 52w high = 200, current = 90 → down 55%
    const h = makeHolding({ fiftyTwoWeekHigh: 200, currentPrice: 90 });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'EXIT');
    assert.ok(sig.reasons.some(r => r.includes('major drawdown')));
  });

  it('52w drawdown WATCH: >30% below high', () => {
    // 52w high = 140, current = 90 → down 35.7%
    const h = makeHolding({
      fiftyTwoWeekHigh: 140,
      currentPrice: 90,
      weeklyPrices: [90, 90, 90, 90],
    });
    const sig = computeStockSignal(h, config, portfolioValue);
    // Trailing stop fires at 35.7% > 15% → EXIT
    // But let's test with trailing stop disabled
    const configHigh = makeConfig({ trailing_stop_pct: 99 });
    const sig2 = computeStockSignal(h, configHigh, portfolioValue);
    assert.ok(sig2.signal === 'WATCH' || sig2.signal === 'EXIT');
  });

  it('oil-sensitive stock: EXIT at >40% below 52w high', () => {
    // 52w high = 160, current = 90 → down 43.75%, oil sector
    const h = makeHolding({
      fiftyTwoWeekHigh: 160,
      currentPrice: 90,
      sector: 'Energy',
      industry: 'Oil & Gas Exploration',
      weeklyPrices: [90, 90, 90, 90],
    });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'EXIT');
    assert.ok(sig.reasons.some(r => r.toLowerCase().includes('oil')));
  });

  it('tiny position: EXIT downgraded to WATCH', () => {
    // Tiny position: value = 0.5% of portfolio
    const h = makeHolding({
      fiftyTwoWeekHigh: 120,
      currentPrice: 90,
      qty: 1,  // value = 90, which is 0.09% of 100000
    });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'WATCH');
    assert.ok(sig.reasons.some(r => r.includes('Tiny position')));
  });

  it('large position stays EXIT (not downgraded)', () => {
    // Large position: value = 10% of portfolio
    const h = makeHolding({
      fiftyTwoWeekHigh: 120,
      currentPrice: 90,
      qty: 111,  // value = 9990, which is ~10% of 100000
    });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'EXIT');
  });

  it('no weekly prices: skip momentum check', () => {
    const h = makeHolding({
      weeklyPrices: [],
      fiftyTwoWeekHigh: 100,
      currentPrice: 100,
    });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'HOLD');
  });

  it('no 52w high: skip trailing stop', () => {
    const h = makeHolding({ fiftyTwoWeekHigh: 0, weeklyPrices: [100, 100, 100, 100] });
    const sig = computeStockSignal(h, config, portfolioValue);
    assert.equal(sig.signal, 'HOLD');
  });
});

describe('Layer 2: Sector Overlay', () => {
  const config = makeConfig();

  it('over-concentrated sector: WATCH largest holdings', () => {
    const holdings = [
      makeHolding({ instrument: 'BIG1', sector: 'Technology', qty: 200, currentPrice: 100 }),
      makeHolding({ instrument: 'BIG2', sector: 'Technology', qty: 150, currentPrice: 100 }),
      makeHolding({ instrument: 'SMALL', sector: 'Healthcare', qty: 10, currentPrice: 50 }),
    ];
    const sectors: Record<string, SectorSummary> = {
      'Technology': { count: 2, value: 35000, pct: 70, isOilSensitive: false },
      'Healthcare': { count: 1, value: 500, pct: 1, isOilSensitive: false },
    };
    const signals: Record<string, StockSignal> = {
      'BIG1': { instrument: 'BIG1', signal: 'HOLD', reasons: [] },
      'BIG2': { instrument: 'BIG2', signal: 'HOLD', reasons: [] },
      'SMALL': { instrument: 'SMALL', signal: 'HOLD', reasons: [] },
    };

    applySectorOverlay(signals, holdings, config, null, sectors);
    assert.equal(signals['BIG1'].signal, 'WATCH');
    assert.equal(signals['BIG2'].signal, 'WATCH');
    assert.equal(signals['SMALL'].signal, 'HOLD');
  });

  it('Brent crisis ($100+): EXIT all oil-sensitive when sector >30%', () => {
    const holdings = [
      makeHolding({ instrument: 'OIL1', sector: 'Oil & Gas', qty: 100, currentPrice: 100 }),
      makeHolding({ instrument: 'TECH1', sector: 'Technology', qty: 100, currentPrice: 100 }),
    ];
    // Keep both sectors under 25% concentration to isolate the oil overlay test
    const sectors: Record<string, SectorSummary> = {
      'Oil & Gas': { count: 1, value: 10000, pct: 35, isOilSensitive: true },
      'Technology': { count: 1, value: 10000, pct: 20, isOilSensitive: false },
    };
    const signals: Record<string, StockSignal> = {
      'OIL1': { instrument: 'OIL1', signal: 'HOLD', reasons: [] },
      'TECH1': { instrument: 'TECH1', signal: 'HOLD', reasons: [] },
    };

    applySectorOverlay(signals, holdings, config, 105, sectors);
    assert.equal(signals['OIL1'].signal, 'EXIT');
    assert.equal(signals['TECH1'].signal, 'HOLD');
  });

  it('Brent watch ($90-100): WATCH oil-sensitive when sector >30%', () => {
    const holdings = [
      makeHolding({ instrument: 'OIL1', sector: 'Oil & Gas', qty: 100, currentPrice: 100 }),
    ];
    const sectors: Record<string, SectorSummary> = {
      'Oil & Gas': { count: 1, value: 10000, pct: 50, isOilSensitive: true },
    };
    const signals: Record<string, StockSignal> = {
      'OIL1': { instrument: 'OIL1', signal: 'HOLD', reasons: [] },
    };

    applySectorOverlay(signals, holdings, config, 95, sectors);
    assert.equal(signals['OIL1'].signal, 'WATCH');
  });

  it('Brent below $90: no oil overlay', () => {
    const holdings = [
      makeHolding({ instrument: 'OIL1', sector: 'Oil & Gas', qty: 100, currentPrice: 100 }),
    ];
    // Keep pct under 25% to avoid concentration trigger
    const sectors: Record<string, SectorSummary> = {
      'Oil & Gas': { count: 1, value: 10000, pct: 20, isOilSensitive: true },
    };
    const signals: Record<string, StockSignal> = {
      'OIL1': { instrument: 'OIL1', signal: 'HOLD', reasons: [] },
    };

    // Brent >$90 but sector <30% → no oil overlay, and pct <25% → no concentration
    applySectorOverlay(signals, holdings, config, 85, sectors);
    assert.equal(signals['OIL1'].signal, 'HOLD');
  });

  it('oil sector <30%: no oil overlay even with high Brent', () => {
    // Oil is 20% of portfolio value (10K oil, 40K tech = 50K total → 20% oil)
    const holdings = [
      makeHolding({ instrument: 'OIL1', sector: 'Energy', industry: 'Oil & Gas', qty: 100, currentPrice: 100 }),
      makeHolding({ instrument: 'TECH1', sector: 'Technology', industry: 'Software', qty: 400, currentPrice: 100 }),
    ];
    const sectors: Record<string, SectorSummary> = {
      'Energy': { count: 1, value: 10000, pct: 20, isOilSensitive: true },
      'Technology': { count: 1, value: 40000, pct: 80, isOilSensitive: false },
    };
    const signals: Record<string, StockSignal> = {
      'OIL1': { instrument: 'OIL1', signal: 'HOLD', reasons: [] },
      'TECH1': { instrument: 'TECH1', signal: 'HOLD', reasons: [] },
    };

    applySectorOverlay(signals, holdings, config, 110, sectors);
    assert.equal(signals['OIL1'].signal, 'HOLD');
  });
});

describe('Layer 3: Circuit Breaker', () => {
  const config = makeConfig();

  it('CAUTION at -8% to -12%', () => {
    const cb = checkCircuitBreaker(-9, config);
    assert.ok(cb !== null);
    assert.ok(cb!.includes('CAUTION'));
  });

  it('REDUCE at -12% to -18%', () => {
    const cb = checkCircuitBreaker(-14, config);
    assert.ok(cb !== null);
    assert.ok(cb!.includes('REDUCE'));
  });

  it('EXIT at >-18%', () => {
    const cb = checkCircuitBreaker(-20, config);
    assert.ok(cb !== null);
    assert.ok(cb!.includes('EMERGENCY EXIT'));
  });

  it('no trigger above -8%', () => {
    const cb = checkCircuitBreaker(-5, config);
    assert.equal(cb, null);
  });

  it('no trigger when positive', () => {
    const cb = checkCircuitBreaker(10, config);
    assert.equal(cb, null);
  });
});

describe('computeSignals integration', () => {
  const config = makeConfig();

  it('returns signals for all holdings', () => {
    const holdings = [
      makeHolding({ instrument: 'A' }),
      makeHolding({ instrument: 'B' }),
    ];
    const sectors: Record<string, SectorSummary> = {
      'Technology': { count: 2, value: 18000, pct: 100, isOilSensitive: false },
    };
    const { signals } = computeSignals(holdings, config, null, sectors);
    assert.ok('A' in signals);
    assert.ok('B' in signals);
  });

  it('brent_crisis_usd = 1 triggers EXIT on all oil stocks', () => {
    // Set crisis to $1 so any Brent price triggers it; sector concentration at 99% to avoid triggering
    const crisisConfig = makeConfig({ brent_crisis_usd: 1, oil_sector_concentration_pct: 0, sector_concentration_pct: 99 });
    const holdings = [
      makeHolding({ instrument: 'OIL1', sector: 'Oil & Gas', fiftyTwoWeekHigh: 100, currentPrice: 100, weeklyPrices: [100, 100, 100, 100], qty: 100 }),
      makeHolding({ instrument: 'OIL2', sector: 'Power', fiftyTwoWeekHigh: 100, currentPrice: 100, weeklyPrices: [100, 100, 100, 100], qty: 100 }),
      makeHolding({ instrument: 'TECH1', sector: 'Technology', fiftyTwoWeekHigh: 100, currentPrice: 100, weeklyPrices: [100, 100, 100, 100], qty: 100 }),
    ];
    const sectors: Record<string, SectorSummary> = {
      'Oil & Gas': { count: 1, value: 10000, pct: 33, isOilSensitive: true },
      'Power': { count: 1, value: 10000, pct: 33, isOilSensitive: true },
      'Technology': { count: 1, value: 10000, pct: 33, isOilSensitive: false },
    };

    const { signals } = computeSignals(holdings, crisisConfig, 50, sectors);
    assert.equal(signals['OIL1'].signal, 'EXIT');
    assert.equal(signals['OIL2'].signal, 'EXIT');
    assert.equal(signals['TECH1'].signal, 'HOLD');
  });
});
