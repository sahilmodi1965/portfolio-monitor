export interface Holding {
  instrument: string;
  qty: number;
  avgCost: number;
  ltp: number;
  invested: number;
  currentValue: number;
  pnl: number;
  netChgPct: number;
  dayChgPct: number;
}

export interface EnrichedHolding extends Holding {
  yahooSymbol: string;
  sector: string;
  industry: string;
  fiftyTwoWeekHigh: number;
  currentPrice: number;
  weeklyPrices: number[];
  enrichmentFailed: boolean;
}

export interface SectorCacheEntry {
  sector: string;
  industry: string;
  cachedAt: string;
}

export type SectorCache = Record<string, SectorCacheEntry>;

export type Signal = 'EXIT' | 'WATCH' | 'HOLD';

export interface StockSignal {
  instrument: string;
  signal: Signal;
  reasons: string[];
}

export interface SectorSummary {
  count: number;
  value: number;
  pct: number;
  isOilSensitive: boolean;
}

export interface DashboardData {
  generated_at: string;
  portfolio: {
    total_invested: number;
    current_value: number;
    total_pnl: number;
    total_pnl_pct: number;
    holdings_count: number;
  };
  holdings: EnrichedHolding[];
  signals: Record<string, StockSignal>;
  sectors: Record<string, SectorSummary>;
  top_winners: EnrichedHolding[];
  top_bleeders: EnrichedHolding[];
  brent_price: number | null;
  circuit_breaker: string | null;
}

export interface Config {
  thresholds: {
    trailing_stop_pct: number;
    momentum_exit_pct: number;
    momentum_watch_pct: number;
    drawdown_exit_pct: number;
    drawdown_oil_exit_pct: number;
    drawdown_watch_pct: number;
    tiny_position_pct: number;
    sector_concentration_pct: number;
    oil_sector_concentration_pct: number;
    brent_crisis_usd: number;
    brent_watch_usd: number;
    portfolio_caution_pct: number;
    portfolio_reduce_pct: number;
    portfolio_exit_pct: number;
  };
  yahoo: {
    delay_ms: number;
    sector_cache_ttl_days: number;
    chart_range: string;
    chart_interval: string;
  };
  oil_sensitive_sectors: string[];
  oil_resistant_sectors: string[];
}
