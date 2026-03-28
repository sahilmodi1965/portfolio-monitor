import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './types.js';

const ROOT = resolve(import.meta.dirname, '..');

/** Loads config.json from project root. */
export function loadConfig(): Config {
  const raw = readFileSync(resolve(ROOT, 'config.json'), 'utf-8');
  return JSON.parse(raw) as Config;
}

export const PROJECT_ROOT = ROOT;
