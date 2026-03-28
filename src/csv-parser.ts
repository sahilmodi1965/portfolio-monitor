import { readFileSync } from 'node:fs';
import type { Holding } from './types.js';

/** Parse a single CSV line respecting quoted fields. */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Parse numeric value, returning 0 for unparseable input. */
function num(val: string): number {
  const n = parseFloat(val.replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

/** Parse holdings.csv into typed Holding array. */
export function parseHoldingsCSV(filePath: string): Holding[] {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);

  if (lines.length < 2) return [];

  // Skip header (line 0)
  const holdings: Holding[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 9) continue;

    const instrument = fields[0].trim();
    if (!instrument) continue;

    holdings.push({
      instrument,
      qty: num(fields[1]),
      avgCost: num(fields[2]),
      ltp: num(fields[3]),
      invested: num(fields[4]),
      currentValue: num(fields[5]),
      pnl: num(fields[6]),
      netChgPct: num(fields[7]),
      dayChgPct: num(fields[8]),
    });
  }

  return holdings;
}
