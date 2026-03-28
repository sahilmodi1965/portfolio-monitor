import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCSVLine, parseHoldingsCSV } from '../src/csv-parser.js';

describe('parseCSVLine', () => {
  it('parses basic quoted fields', () => {
    const result = parseCSVLine('"AARTIIND",1,457.18,417.4,457.18,417.4,-39.78,-8.7,-3.21,""');
    assert.equal(result[0], 'AARTIIND');
    assert.equal(result[1], '1');
    assert.equal(result[6], '-39.78');
    assert.equal(result[9], '');
  });

  it('handles ampersands in quoted fields', () => {
    const result = parseCSVLine('"M&M",1,3400,3041.3,3400,3041.3,-358.7,-10.55,-2.77,""');
    assert.equal(result[0], 'M&M');
  });

  it('handles P&L header field', () => {
    const result = parseCSVLine('"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""');
    assert.equal(result[0], 'Instrument');
    assert.equal(result[6], 'P&L');
    assert.equal(result.length, 10);
  });

  it('handles escaped quotes', () => {
    const result = parseCSVLine('"test""value",123');
    assert.equal(result[0], 'test"value');
    assert.equal(result[1], '123');
  });

  it('returns empty array fields for empty line with commas', () => {
    const result = parseCSVLine(',,');
    assert.equal(result.length, 3);
    assert.equal(result[0], '');
  });
});

describe('parseHoldingsCSV', () => {
  const tmpDir = resolve(import.meta.dirname, '..', 'tmp-test');
  const tmpCSV = resolve(tmpDir, 'test-holdings.csv');

  function writeCSV(content: string) {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpCSV, content);
  }

  function cleanup() {
    try { unlinkSync(tmpCSV); } catch {}
  }

  it('parses a valid CSV with 3 holdings', () => {
    writeCSV([
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"AARTIIND",1,457.18,417.4,457.18,417.4,-39.78,-8.7,-3.21,""',
      '"M&M",1,3400,3041.3,3400,3041.3,-358.7,-10.55,-2.77,""',
      '"ADANIPORTS",1,1050.55,1337.8,1050.55,1337.8,287.25,27.34,-2.77,""',
    ].join('\n'));

    const holdings = parseHoldingsCSV(tmpCSV);
    assert.equal(holdings.length, 3);
    assert.equal(holdings[0].instrument, 'AARTIIND');
    assert.equal(holdings[0].qty, 1);
    assert.equal(holdings[0].avgCost, 457.18);
    assert.equal(holdings[0].pnl, -39.78);
    assert.equal(holdings[1].instrument, 'M&M');
    assert.equal(holdings[2].pnl, 287.25);
    cleanup();
  });

  it('handles empty CSV (header only)', () => {
    writeCSV('"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""');
    const holdings = parseHoldingsCSV(tmpCSV);
    assert.equal(holdings.length, 0);
    cleanup();
  });

  it('skips malformed rows with too few fields', () => {
    writeCSV([
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"AARTIIND",1,457.18',
      '"VALID",1,100,100,100,100,0,0,0,""',
    ].join('\n'));

    const holdings = parseHoldingsCSV(tmpCSV);
    assert.equal(holdings.length, 1);
    assert.equal(holdings[0].instrument, 'VALID');
    cleanup();
  });

  it('handles negative P&L correctly', () => {
    writeCSV([
      '"Instrument","Qty.","Avg. cost","LTP","Invested","Cur. val","P&L","Net chg.","Day chg.",""',
      '"ABFRL",1103,70.93,57.05,78230.67,62926.15,-15304.52,-19.56,-3.06,""',
    ].join('\n'));

    const holdings = parseHoldingsCSV(tmpCSV);
    assert.equal(holdings[0].instrument, 'ABFRL');
    assert.equal(holdings[0].qty, 1103);
    assert.equal(holdings[0].pnl, -15304.52);
    assert.equal(holdings[0].netChgPct, -19.56);
    cleanup();
  });

  it('parses real holdings.csv without crashing', () => {
    const realPath = resolve(import.meta.dirname, '..', 'holdings.csv');
    const holdings = parseHoldingsCSV(realPath);
    assert.ok(holdings.length > 300, `Expected 300+ holdings, got ${holdings.length}`);
    // Every holding should have a non-empty instrument
    for (const h of holdings) {
      assert.ok(h.instrument.length > 0, 'Empty instrument found');
      assert.ok(typeof h.qty === 'number', `qty not a number for ${h.instrument}`);
      assert.ok(typeof h.pnl === 'number', `pnl not a number for ${h.instrument}`);
    }
  });
});
