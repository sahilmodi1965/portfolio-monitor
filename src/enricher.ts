import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Holding, EnrichedHolding, SectorCache, Config } from './types.js';
import { toYahooSymbol, delay, log, warn } from './utils.js';
import { PROJECT_ROOT } from './config.js';

const SECTOR_CACHE_PATH = resolve(PROJECT_ROOT, 'data', 'sectors-cache.json');

const YAHOO_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/json',
};

// Yahoo Finance auth state — crumb + cookies for v10 endpoints
let yahooCrumb: string | null = null;
let yahooCookies: string | null = null;

/** Obtain Yahoo Finance crumb + cookies for authenticated endpoints. */
async function getYahooAuth(): Promise<boolean> {
  if (yahooCrumb && yahooCookies) return true;

  try {
    // Step 1: Hit fc.yahoo.com — returns 404 but sets the A3 cookie we need
    const cookieResp = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': YAHOO_HEADERS['User-Agent'] },
    });
    // Read body to completion even though we discard it
    await cookieResp.text();

    // Extract cookies from Set-Cookie headers
    const rawHeaders = cookieResp.headers;
    let cookies = '';

    // getSetCookie() is available in Node 20+ but may return empty — fallback to raw header
    const setCookieArr = rawHeaders.getSetCookie?.() || [];
    if (setCookieArr.length > 0) {
      cookies = setCookieArr.map(c => c.split(';')[0]).join('; ');
    } else {
      // Fallback: parse raw set-cookie header
      const raw = rawHeaders.get('set-cookie') || '';
      if (raw) {
        cookies = raw.split(',').map(c => c.trim().split(';')[0]).filter(c => c.includes('=')).join('; ');
      }
    }

    if (!cookies) {
      warn('Yahoo auth: no cookies received');
      return false;
    }

    // Step 2: Get crumb using cookies
    const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': YAHOO_HEADERS['User-Agent'], 'Cookie': cookies },
    });

    if (!crumbResp.ok) {
      warn(`Yahoo auth: crumb request failed HTTP ${crumbResp.status}`);
      return false;
    }

    const crumb = await crumbResp.text();
    if (!crumb || crumb.includes('<') || crumb.length > 50) {
      warn('Yahoo auth: invalid crumb response');
      return false;
    }

    yahooCrumb = crumb.trim();
    yahooCookies = cookies;
    log(`Yahoo Finance authenticated (crumb: ${yahooCrumb.substring(0, 6)}...)`);
    return true;
  } catch (e: any) {
    warn(`Yahoo auth failed: ${e.message}`);
    return false;
  }
}

/** Load sector cache from disk. */
export function loadSectorCache(): SectorCache {
  if (!existsSync(SECTOR_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SECTOR_CACHE_PATH, 'utf-8'));
  } catch {
    warn('Sector cache corrupted, starting fresh');
    return {};
  }
}

/** Save sector cache to disk. */
export function saveSectorCache(cache: SectorCache): void {
  writeFileSync(SECTOR_CACHE_PATH, JSON.stringify(cache, null, 2));
}

/** Check if a cache entry is still valid. */
function isCacheValid(cachedAt: string, ttlDays: number): boolean {
  const age = Date.now() - new Date(cachedAt).getTime();
  return age < ttlDays * 24 * 60 * 60 * 1000;
}

/** Fetch weekly chart data from Yahoo Finance. Returns null on failure. */
export async function fetchChartData(
  yahooSymbol: string,
  config: Config
): Promise<{ currentPrice: number; fiftyTwoWeekHigh: number; weeklyPrices: number[] } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${config.yahoo.chart_range}&interval=${config.yahoo.chart_interval}`;

  try {
    const resp = await fetch(url, { headers: YAHOO_HEADERS });
    if (!resp.ok) {
      warn(`Chart ${yahooSymbol}: HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) {
      warn(`Chart ${yahooSymbol}: no result in response`);
      return null;
    }

    const meta = result.meta || {};
    const closePrices: number[] = (result.indicators?.quote?.[0]?.close || [])
      .filter((p: any) => p != null) as number[];

    const currentPrice = meta.regularMarketPrice || closePrices[closePrices.length - 1] || 0;
    const allHighs: number[] = (result.indicators?.quote?.[0]?.high || [])
      .filter((p: any) => p != null) as number[];
    const fiftyTwoWeekHigh = allHighs.length > 0 ? Math.max(...allHighs) : meta.fiftyTwoWeekHigh || 0;

    // Last 4 weekly close prices for momentum
    const weeklyPrices = closePrices.slice(-4);

    return { currentPrice, fiftyTwoWeekHigh, weeklyPrices };
  } catch (e: any) {
    warn(`Chart ${yahooSymbol}: ${e.message}`);
    return null;
  }
}

/** Fetch sector/industry from Yahoo Finance quoteSummary (requires crumb auth). Returns null on failure. */
export async function fetchSectorData(
  yahooSymbol: string
): Promise<{ sector: string; industry: string } | null> {
  // Need crumb auth for v10 endpoint
  if (!yahooCrumb || !yahooCookies) return null;

  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=assetProfile&crumb=${encodeURIComponent(yahooCrumb)}`;

  try {
    const resp = await fetch(url, {
      headers: { ...YAHOO_HEADERS, 'Cookie': yahooCookies },
    });
    if (!resp.ok) return null;

    const data = await resp.json() as any;
    const profile = data?.quoteSummary?.result?.[0]?.assetProfile;
    if (!profile) return null;

    return {
      sector: profile.sector || 'Unknown',
      industry: profile.industry || 'Unknown',
    };
  } catch {
    return null;
  }
}

/** Fetch Brent crude price (BZ=F). Returns null on failure. */
export async function fetchBrentPrice(config: Config): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/BZ%3DF?range=1d&interval=1d`;
  try {
    const resp = await fetch(url, { headers: YAHOO_HEADERS });
    if (!resp.ok) return null;

    const data = await resp.json() as any;
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof price === 'number' ? price : null;
  } catch {
    warn('Failed to fetch Brent crude price');
    return null;
  }
}

/** Enrich a single holding with Yahoo Finance data. */
async function enrichOne(
  holding: Holding,
  config: Config,
  sectorCache: SectorCache
): Promise<EnrichedHolding> {
  const yahooSymbol = toYahooSymbol(holding.instrument);

  // Fetch chart data (always, for fresh prices)
  const chart = await fetchChartData(yahooSymbol, config);

  // Sector: check cache first
  let sector = 'Unknown';
  let industry = 'Unknown';
  const cached = sectorCache[holding.instrument];
  if (cached && isCacheValid(cached.cachedAt, config.yahoo.sector_cache_ttl_days)) {
    sector = cached.sector;
    industry = cached.industry;
  } else {
    // Fetch from Yahoo (only if auth is available)
    await delay(config.yahoo.delay_ms);
    const sectorData = await fetchSectorData(yahooSymbol);
    if (sectorData) {
      sector = sectorData.sector;
      industry = sectorData.industry;
      sectorCache[holding.instrument] = {
        sector,
        industry,
        cachedAt: new Date().toISOString(),
      };
    } else if (cached) {
      // Use stale cache if fetch failed
      sector = cached.sector;
      industry = cached.industry;
    }
  }

  return {
    ...holding,
    yahooSymbol,
    sector,
    industry,
    currentPrice: chart?.currentPrice || holding.ltp,
    fiftyTwoWeekHigh: chart?.fiftyTwoWeekHigh || 0,
    weeklyPrices: chart?.weeklyPrices || [],
    enrichmentFailed: chart === null,
  };
}

/** Enrich all holdings. Batches requests with configured delay. */
export async function enrichHoldings(
  holdings: Holding[],
  config: Config
): Promise<{ enriched: EnrichedHolding[]; brentPrice: number | null }> {
  const sectorCache = loadSectorCache();

  // Authenticate with Yahoo Finance for sector data
  log('Authenticating with Yahoo Finance...');
  const authOk = await getYahooAuth();
  if (!authOk) {
    warn('Yahoo auth failed — sector data will use cache or show Unknown');
  }

  log('Fetching Brent crude price...');
  const brentPrice = await fetchBrentPrice(config);
  if (brentPrice !== null) {
    log(`Brent crude: $${brentPrice.toFixed(2)}`);
  } else {
    warn('Brent crude price unavailable');
  }

  log(`Enriching ${holdings.length} holdings (this may take a few minutes)...`);
  const enriched: EnrichedHolding[] = [];
  let successCount = 0;
  let failCount = 0;
  let sectorHits = 0;

  for (let i = 0; i < holdings.length; i++) {
    const holding = holdings[i];
    const result = await enrichOne(holding, config, sectorCache);
    enriched.push(result);

    if (result.enrichmentFailed) {
      failCount++;
    } else {
      successCount++;
    }
    if (result.sector !== 'Unknown') sectorHits++;

    // Progress every 50 stocks
    if ((i + 1) % 50 === 0 || i === holdings.length - 1) {
      log(`Progress: ${i + 1}/${holdings.length} (${successCount} ok, ${failCount} failed, ${sectorHits} sectors)`);
    }

    // Delay between requests to avoid rate limiting
    if (i < holdings.length - 1) {
      await delay(config.yahoo.delay_ms);
    }
  }

  saveSectorCache(sectorCache);
  log(`Enrichment complete. ${successCount} enriched, ${failCount} failed, ${sectorHits} sectors resolved.`);

  return { enriched, brentPrice };
}
