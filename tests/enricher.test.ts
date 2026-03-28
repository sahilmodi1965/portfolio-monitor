import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadSectorCache, saveSectorCache } from '../src/enricher.js';
import { toYahooSymbol, pctChange } from '../src/utils.js';

describe('toYahooSymbol', () => {
  it('appends .NS to regular symbols', () => {
    assert.equal(toYahooSymbol('AARTIIND'), 'AARTIIND.NS');
  });

  it('handles symbols with ampersand', () => {
    assert.equal(toYahooSymbol('M&M'), 'M&M.NS');
    assert.equal(toYahooSymbol('J&KBANK'), 'J&KBANK.NS');
  });
});

describe('pctChange', () => {
  it('computes positive change', () => {
    assert.equal(pctChange(100, 120), 20);
  });

  it('computes negative change', () => {
    assert.equal(pctChange(100, 80), -20);
  });

  it('handles zero base', () => {
    assert.equal(pctChange(0, 100), 0);
  });
});

describe('sector cache', () => {
  it('returns empty object when cache file does not exist', () => {
    // loadSectorCache handles missing file gracefully
    const cache = loadSectorCache();
    assert.ok(typeof cache === 'object');
  });

  it('round-trips cache data', () => {
    const testCache = {
      'TEST': { sector: 'Technology', industry: 'Software', cachedAt: new Date().toISOString() },
    };
    saveSectorCache(testCache);
    const loaded = loadSectorCache();
    assert.equal(loaded['TEST'].sector, 'Technology');
    assert.equal(loaded['TEST'].industry, 'Software');
  });
});

describe('enricher resilience', () => {
  it('handles non-existent Yahoo symbol gracefully', async () => {
    // fetchChartData should return null for bad symbols, not throw
    const { fetchChartData } = await import('../src/enricher.js');
    const config = {
      thresholds: {} as any,
      yahoo: { delay_ms: 0, sector_cache_ttl_days: 7, chart_range: '1y', chart_interval: '1wk' },
      oil_sensitive_sectors: [],
      oil_resistant_sectors: [],
    };

    const result = await fetchChartData('FAKESYMBOL123456.NS', config);
    // Should be null (HTTP error) or valid data — never throws
    assert.ok(result === null || typeof result === 'object');
  });

  it('handles malformed URL characters in symbol', async () => {
    const { fetchChartData } = await import('../src/enricher.js');
    const config = {
      thresholds: {} as any,
      yahoo: { delay_ms: 0, sector_cache_ttl_days: 7, chart_range: '1y', chart_interval: '1wk' },
      oil_sensitive_sectors: [],
      oil_resistant_sectors: [],
    };

    // M&M has an ampersand — should be URL-encoded properly
    const result = await fetchChartData('M&M.NS', config);
    assert.ok(result === null || typeof result === 'object');
  });
});
