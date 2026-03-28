# Portfolio Monitor — CLAUDE.md

## What This Is
CSV-in → Yahoo Finance enrich → exit signals → static GitHub Pages dashboard.
305 Indian stock holdings from Zerodha Kite.

## Autonomy Tiers
- **Level 0**: Manual CSV export from Kite (human)
- **Level 1**: `npm run build` enriches + generates dashboard (agent-in-terminal)
- **Level 2**: GitHub Action auto-deploys on push (CI/CD automation)

## Architecture
```
holdings.csv → src/pipeline.ts → public/dashboard-data.json → public/index.html
```
- `src/` — TypeScript modules (csv-parser, enricher, signals, pipeline)
- `public/` — Static dashboard (index.html + generated dashboard-data.json)
- `data/` — Sector cache (7-day TTL)
- `config.json` — ALL thresholds, no hardcoded values

## Build
```bash
npm ci
npm run build    # runs pipeline, outputs public/dashboard-data.json
npm test         # node:test for all modules
```

## Signal Logic (3 layers)
1. **Per-Stock**: trailing stop, momentum, 52w drawdown (thresholds in config.json)
2. **Sector Overlay**: concentration limits, oil-sensitivity gate
3. **Circuit Breaker**: portfolio-level P&L thresholds

## Rules
- Static HTML only. No server, no SSE, no localhost assumptions.
- All thresholds in config.json. Zero hardcoded values.
- Tests alongside every module using node:test.
- Never crash on bad data. Cache fallback if Yahoo is down.
- No feature creep. Three phases only.
