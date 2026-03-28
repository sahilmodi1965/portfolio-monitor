/** Format number as Indian Rupee. */
export function formatINR(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${n.toFixed(2)}`;
}

/** Format percentage with sign. */
export function formatPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/** Sleep for ms. */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Console log with cyan prefix. */
export function log(msg: string): void {
  console.log(`\x1b[36m[portfolio]\x1b[0m ${msg}`);
}

/** Console warn with yellow prefix. */
export function warn(msg: string): void {
  console.warn(`\x1b[33m[portfolio]\x1b[0m ${msg}`);
}

/** Console error with red prefix. */
export function err(msg: string): void {
  console.error(`\x1b[31m[portfolio]\x1b[0m ${msg}`);
}

/** Convert NSE instrument name to Yahoo Finance symbol. */
export function toYahooSymbol(instrument: string): string {
  return `${instrument}.NS`;
}

/** Compute percentage change between two values. */
export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}
