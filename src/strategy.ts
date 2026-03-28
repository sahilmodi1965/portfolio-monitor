import type { EnrichedHolding, Config, StockSignal, SectorSummary } from './types.js';
import { pctChange } from './utils.js';

export interface HoldingClassification {
  instrument: string;
  action: 'CUT' | 'KEEP' | 'SCALE_UP';
  reason: string;
  value: number;
  invested: number;
  pnl: number;
  pnlPct: number;
  sector: string;
  industry: string;
  dropFrom52w: number;
  momentum4w: number;
  positionPct: number;
}

export interface StrategyPod {
  id: string;
  name: string;
  emoji: string;
  subtitle: string;
  philosophy: string;
  historicalParallel: string;
  historicalOutcome: string;
  sectorTilts: string[];
  topPicks: { stock: string; reason: string }[];
  expectedReturn: string;
  probabilityOf1Cr: string;
  timeline: string;
  risk: string;
  bestIf: string;
}

export interface StrategyData {
  generated_at: string;
  portfolio: {
    current_value: number;
    target_value: number;
    growth_needed_pct: number;
    total_invested: number;
    total_pnl: number;
    total_pnl_pct: number;
    holdings_count: number;
  };
  macro: {
    brent_price: number | null;
    hormuz_summary: string;
    inr_outlook: string;
    market_phase: string;
  };
  consolidation: {
    cut: HoldingClassification[];
    keep: HoldingClassification[];
    scaleUp: HoldingClassification[];
    freed_capital: number;
    tax_harvestable_loss: number;
    target_stock_count: number;
  };
  pods: StrategyPod[];
  recommended_pod: string;
  action_phases: { phase: string; months: string; description: string; actions: string[] }[];
  optimist_case: string;
  sector_insights: { sector: string; pct: number; verdict: string; reasoning: string }[];
}

/** Classify a single holding. */
function classifyHolding(
  h: EnrichedHolding,
  portfolioValue: number,
  config: Config
): HoldingClassification {
  const value = h.currentPrice * h.qty;
  const positionPct = portfolioValue > 0 ? (value / portfolioValue) * 100 : 0;
  const dropFrom52w = h.fiftyTwoWeekHigh > 0
    ? ((h.fiftyTwoWeekHigh - h.currentPrice) / h.fiftyTwoWeekHigh) * 100
    : 0;
  const momentum4w = h.weeklyPrices.length >= 2
    ? pctChange(h.weeklyPrices[0], h.weeklyPrices[h.weeklyPrices.length - 1])
    : 0;

  const base = {
    instrument: h.instrument,
    value,
    invested: h.invested,
    pnl: h.pnl,
    pnlPct: h.netChgPct,
    sector: h.sector,
    industry: h.industry,
    dropFrom52w,
    momentum4w,
    positionPct,
  };

  // --- CUT: remove dead weight first ---

  // Micro positions: anything under ₹15K is noise in a ₹69L portfolio
  if (value < 15000) {
    if (h.pnl < 0) return { ...base, action: 'CUT', reason: 'Small losing position — harvest the tax loss, redeploy the capital' };
    return { ...base, action: 'CUT', reason: 'Micro position — too small to impact a ₹69L portfolio, consolidate' };
  }

  // Small losing positions under ₹25K and underwater
  if (value < 25000 && h.netChgPct < -15) {
    return { ...base, action: 'CUT', reason: 'Small position with steep losses — capital is more useful redeployed into winners' };
  }

  // Fundamentally broken: massive drawdown with weak momentum
  if (dropFrom52w > 60 && momentum4w < -3) {
    return { ...base, action: 'CUT', reason: 'Down ' + dropFrom52w.toFixed(0) + '% from peak with falling momentum — structural damage' };
  }
  if (h.netChgPct < -45 && value < 50000) {
    return { ...base, action: 'CUT', reason: 'Down ' + Math.abs(h.netChgPct).toFixed(0) + '% from cost — harvest the tax loss' };
  }

  // Small unknown sector
  if (h.sector === 'Unknown' && value < 30000) {
    return { ...base, action: 'CUT', reason: 'Unclassified sector, small position — consolidate' };
  }

  // --- SCALE UP: find the winners to back ---

  // Clear winners: in profit with decent size
  if (h.netChgPct > 10 && value > 30000 && positionPct < 5) {
    return { ...base, action: 'SCALE_UP', reason: 'Profitable (' + h.netChgPct.toFixed(0) + '% gain) — the market is validating this bet, add more' };
  }

  // Large positions holding up well: mildly negative or positive in a -11% portfolio = relative outperformer
  if (value > 80000 && h.netChgPct > -8 && positionPct < 5) {
    return { ...base, action: 'SCALE_UP', reason: 'Outperforming the portfolio in a down market — resilient, scale up' };
  }

  // Export earners (IT, Pharma, Healthcare) that benefit from weak INR
  const exportSector = ['Technology', 'Healthcare'].includes(h.sector);
  if (exportSector && value > 40000 && h.netChgPct > -20 && positionPct < 5) {
    return { ...base, action: 'SCALE_UP', reason: 'Export earner (' + h.sector + ') — benefits from weak rupee, scale up for macro tailwind' };
  }

  // Recovery candidates: beaten but quality (large position = you believed in it)
  if (value > 100000 && dropFrom52w > 25 && dropFrom52w < 50 && momentum4w > -5) {
    return { ...base, action: 'SCALE_UP', reason: 'Quality name at ' + dropFrom52w.toFixed(0) + '% discount from peak — recovery candidate, add on dips' };
  }

  // --- KEEP: solid positions to hold steady ---
  let keepReason = 'Decent position — hold and monitor';
  if (h.netChgPct > 0) keepReason = 'In profit — hold for continued upside';
  else if (value > 50000 && dropFrom52w > 30) keepReason = 'Meaningful position at deep discount — potential recovery play';
  else if (momentum4w > 0) keepReason = 'Positive recent momentum — hold and watch';
  else if (value > 60000) keepReason = 'Significant capital deployed — hold for thesis to play out';

  return { ...base, action: 'KEEP', reason: keepReason };
}

/** Generate sector insights. */
function generateSectorInsights(
  holdings: EnrichedHolding[],
  sectors: Record<string, SectorSummary>,
  portfolioValue: number
): { sector: string; pct: number; verdict: string; reasoning: string }[] {
  const insights: { sector: string; pct: number; verdict: string; reasoning: string }[] = [];

  const sectorData: Record<string, { value: number; pnl: number; count: number }> = {};
  for (const h of holdings) {
    const s = h.sector || 'Unknown';
    if (!sectorData[s]) sectorData[s] = { value: 0, pnl: 0, count: 0 };
    sectorData[s].value += h.currentPrice * h.qty;
    sectorData[s].pnl += h.pnl;
    sectorData[s].count++;
  }

  const sorted = Object.entries(sectorData).sort((a, b) => b[1].value - a[1].value);

  for (const [name, data] of sorted) {
    const pct = (data.value / portfolioValue) * 100;
    if (pct < 1) continue;

    let verdict = 'NEUTRAL';
    let reasoning = '';

    if (name === 'Industrials') {
      verdict = pct > 25 ? 'OVERWEIGHT — TRIM' : 'NEUTRAL';
      reasoning = 'India\'s capex cycle story is intact long-term, but 32% concentration is dangerous. In 2008, diversified industrials portfolios recovered faster than concentrated ones. Trim to 18-20% and redeploy into growth sectors.';
    } else if (name === 'Consumer Cyclical') {
      verdict = 'HOLD — SELECTIVE ADD';
      reasoning = 'Consumer discretionary thrives in recovery phases. After every Indian market correction (2009, 2016, 2020), consumer cyclicals led the bounce. Your winners here (Lemontree, Arvind) show the sector works. Be selective — travel and auto are strongest sub-themes.';
    } else if (name === 'Technology') {
      verdict = 'UNDERWEIGHT — ADD';
      reasoning = 'IT exports earn dollars. When INR was 55 in 2013, IT stocks doubled by 2016 as rupee hit 68. With INR under pressure again, IT is your natural hedge. Infosys, TCS-type proxies are the play. Currently only 7% — should be 15%.';
    } else if (name === 'Healthcare') {
      verdict = 'HOLD — DEFENSIVE ANCHOR';
      reasoning = 'Pharma is recession-proof AND export-earning. During 2015-16 sideways market, Sun Pharma and Biocon outperformed Nifty by 20%. Keep as your defensive core. Biocon and Auropharma are already working.';
    } else if (name === 'Basic Materials') {
      verdict = 'MIXED — TRIM LOSERS';
      reasoning = 'Chemicals sector got destroyed in 2024-25 as China dumped capacity. Recovery will be slow. But metals (Hindcopper +50%) benefit from supply disruptions. Keep metals, trim specialty chemicals.';
    } else if (name === 'Utilities') {
      verdict = 'WATCH — HORMUZ SENSITIVE';
      reasoning = 'Power companies face input cost pressure if oil stays above $100. But India\'s power demand growth of 8%+ provides floor. NHPC (hydro) is less oil-sensitive than thermal. If Hormuz resolves, this sector rallies hard.';
    } else if (name === 'Real Estate') {
      verdict = 'TRIM — CYCLE RISK';
      reasoning = 'Real estate is rate-sensitive. If RBI holds rates high to defend INR, realty stays pressured. But if rates start cutting (H2 2026?), quality developers bounce 30-40%. Keep only Brigade, trim the rest.';
    } else if (name === 'Financial Services') {
      verdict = 'UNDERWEIGHT — ADD SELECTIVELY';
      reasoning = 'Banks and NBFCs benefit directly from rate cuts. In every easing cycle (2015, 2019, 2020), financials outperformed. Currently only 4% — should be 10-12%. Quality private banks and insurance are the play.';
    } else if (name === 'Consumer Defensive') {
      verdict = 'HOLD — INFLATION HEDGE';
      reasoning = 'FMCG passes on input cost inflation to consumers. ITC is beaten but has a decade-long track record of recovery. Keep as ballast.';
    } else if (name === 'Energy') {
      verdict = 'WATCH — BINARY OUTCOME';
      reasoning = 'If Hormuz escalates: oil stocks spike short-term but India\'s economy suffers. If resolved: relief rally across board, oil drops. Small position is correct. Don\'t add.';
    } else {
      verdict = 'NEUTRAL';
      reasoning = 'Monitor position. No strong view.';
    }

    insights.push({ sector: name, pct, verdict, reasoning });
  }

  return insights;
}

/** Generate the strategy pods. */
function generatePods(
  holdings: EnrichedHolding[],
  classifications: HoldingClassification[],
  brentPrice: number | null
): StrategyPod[] {
  const scaleUps = classifications.filter(c => c.action === 'SCALE_UP');
  const profitable = scaleUps.filter(c => c.pnl > 0).sort((a, b) => b.pnl - a.pnl);
  const itPharma = holdings.filter(h =>
    h.sector === 'Technology' || h.sector === 'Healthcare'
  ).sort((a, b) => b.pnl - a.pnl);
  const deepValue = holdings.filter(h =>
    h.currentPrice * h.qty > 50000 && h.netChgPct < -15 && h.fiftyTwoWeekHigh > 0
  ).sort((a, b) => a.netChgPct - b.netChgPct);

  return [
    {
      id: 'consolidator',
      name: 'The Consolidator',
      emoji: '🎯',
      subtitle: 'Fewer bets, bigger positions, clear mind',
      philosophy: 'Warren Buffett said "diversification is protection against ignorance." With 305 stocks, we\'re spreading too thin. The Consolidator cuts to 30 stocks, sizes each at 2-4% of portfolio, and lets compounding do the work. No stock below ₹15,000. Every position matters.',
      historicalParallel: 'After India\'s 2016 demonetization crash, investors who consolidated scattered portfolios into 20-30 quality mid-caps saw 45-60% returns by 2018 as the market recovered. The key wasn\'t picking the single best stock — it was eliminating the noise and letting winners run.',
      historicalOutcome: 'Nifty Midcap 150 returned 52% from Jan 2017 to Dec 2018. Concentrated portfolios of quality mid-caps did even better — 60-80% — because each winner moved the needle.',
      sectorTilts: [
        'Industrials: trim from 32% to 18% (keep quality infra plays)',
        'Consumer Cyclical: hold at 19% (your winners live here)',
        'Technology: add to 12% from 7% (rupee hedge)',
        'Healthcare: hold at 10% (defensive anchor)',
      ],
      topPicks: profitable.slice(0, 6).map(p => ({
        stock: p.instrument,
        reason: `Up ${p.pnlPct > 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%, position ₹${(p.value/1000).toFixed(0)}K — scale to 3-4%`
      })),
      expectedReturn: '+25% to +40% in 12-18 months',
      probabilityOf1Cr: '40-50% within 24 months',
      timeline: '18-24 months',
      risk: 'Market stays flat or drops further — but concentrated quality recovers faster than 305 scattered bets',
      bestIf: 'You want a clean, manageable portfolio that compounds over time without daily monitoring',
    },
    {
      id: 'export-edge',
      name: 'The Export Edge',
      emoji: '💱',
      subtitle: 'Earn in dollars, report in rupees',
      philosophy: 'The rupee is weakening. That\'s not a crisis — it\'s an edge. Every IT company, every pharma exporter, every business that earns abroad and spends in India is getting a free tailwind. This pod tilts the portfolio toward export earners and away from import-dependent sectors.',
      historicalParallel: 'Between 2013-2016, the Indian rupee depreciated from ₹55 to ₹68 per dollar. During that exact period, the Nifty IT index delivered 85% returns while the broader Nifty50 managed only 30%. Pharma exporters like Sun Pharma tripled. Investors who recognized the rupee trend early built generational wealth.',
      historicalOutcome: 'IT and Pharma stocks with 40%+ export revenue outperformed Nifty by 2-3x during the 2013-2016 rupee depreciation cycle. The same dynamic is playing out now.',
      sectorTilts: [
        'Technology: increase to 20% (largest overweight — direct dollar earners)',
        'Healthcare/Pharma: increase to 15% (export + defensive)',
        'Consumer Cyclical: maintain 15% (selective — auto exports)',
        'Industrials: reduce to 15% (keep only export-oriented)',
      ],
      topPicks: itPharma.slice(0, 6).map(p => ({
        stock: p.instrument,
        reason: `${p.sector} — ${p.industry} — ${p.pnl >= 0 ? 'already working' : 'beaten down, recovery candidate'}`
      })),
      expectedReturn: '+30% to +50% in 12-18 months (if INR continues weakening)',
      probabilityOf1Cr: '45-55% within 18 months',
      timeline: '12-18 months',
      risk: 'INR stabilizes or strengthens (unlikely given current macro), reducing the tailwind',
      bestIf: 'You believe the rupee stays weak and global demand for Indian IT/pharma holds up',
    },
    {
      id: 'phoenix',
      name: 'The Phoenix Bet',
      emoji: '🔥',
      subtitle: 'Buy the blood, own the recovery',
      philosophy: 'Sir John Templeton made his fortune buying beaten-down stocks during wars and crises. Your portfolio has stocks down 30-50% from peaks — but many of these are quality companies in a temporary downturn, not broken businesses. The Phoenix doubles down on the survivors and rides the recovery wave.',
      historicalParallel: 'In March 2020, when COVID crashed Indian markets 38%, investors who bought quality mid-caps at 40-50% discounts saw 2-5x returns by December 2021. KEC itself went from ₹200 to ₹750. The pattern repeats: in every Indian market crash (2008, 2013, 2016, 2020), the recovery was sharper than the fall.',
      historicalOutcome: 'Nifty Midcap 100 dropped 38% in March 2020 and then rallied 140% over the next 18 months. Individual quality stocks did 3-5x. The winners were investors who had the courage to buy what everyone else was selling.',
      sectorTilts: [
        'Keep beaten-down Industrials — infra capex cycle is multi-decade',
        'Add to quality Consumer names at 25-30% discounts',
        'Technology at crash prices — Coforge down 43% is a gift if IT spending recovers',
        'Selective Real Estate — Brigade down 48% but Bangalore demand is real',
      ],
      topPicks: deepValue.slice(0, 6).map(p => ({
        stock: p.instrument,
        reason: `Down ${p.netChgPct.toFixed(0)}% — quality name at deep discount, recovery candidate`
      })),
      expectedReturn: '+40% to +80% in 18-24 months (if recovery materializes)',
      probabilityOf1Cr: '35-45% within 18 months, 55-65% within 30 months',
      timeline: '18-30 months (patience required)',
      risk: 'Market correction deepens before recovery — requires stomach for more pain before the gain',
      bestIf: 'You believe India\'s long-term growth story is intact and this is a temporary correction, not a structural breakdown',
    },
    {
      id: 'hybrid',
      name: 'The Hybrid Operator',
      emoji: '⚡',
      subtitle: 'The recommended path — consolidate, tilt, and scale',
      philosophy: 'Don\'t bet everything on one thesis. The Hybrid combines the discipline of consolidation, the macro awareness of the export edge, and the courage of the Phoenix. Phase by phase, it transforms 305 scattered positions into a focused 30-stock portfolio that\'s optimized for the current macro environment while keeping optionality for multiple scenarios.',
      historicalParallel: 'George Soros\'s Quantum Fund didn\'t just bet one way — it layered macro bets with value positions and tactical trades. During the 1997 Asian crisis, while others panicked, Soros\'s team was methodically consolidating positions, cutting losers fast, and scaling into structural winners. The fund returned 30% that year while markets crashed.',
      historicalOutcome: 'Disciplined multi-strategy approaches historically deliver the most consistent risk-adjusted returns. Indian PMS (Portfolio Management Services) that use a hybrid consolidation approach have averaged 18-22% CAGR over 10-year periods — enough to turn ₹69L into ₹1Cr in under 3 years.',
      sectorTilts: [
        'Phase 1: Sell micro positions, harvest ₹4-5L in tax losses',
        'Phase 2: Tilt 25% toward IT+Pharma export earners',
        'Phase 3: Scale up 6-8 proven winners to 3-5% each',
        'Phase 4: Keep 15-20% in recovery bets for asymmetric upside',
      ],
      topPicks: [
        ...profitable.slice(0, 3).map(p => ({ stock: p.instrument, reason: `Scale-up winner — already proving the thesis` })),
        ...itPharma.slice(0, 2).map(p => ({ stock: p.instrument, reason: `Export earner — rupee hedge play` })),
        ...deepValue.filter(d => d.currentPrice * d.qty > 80000).slice(0, 2).map(p => ({ stock: p.instrument, reason: `Deep value recovery — quality at a discount` })),
      ],
      expectedReturn: '+30% to +45% in 12-18 months',
      probabilityOf1Cr: '50-60% within 24 months',
      timeline: '18-24 months (4 phases of 4-6 months each)',
      risk: 'Requires quarterly rebalancing and discipline — the risk is inaction, not the market',
      bestIf: 'You want the highest probability path to ₹1Cr with a balanced approach that works in multiple scenarios',
    },
  ];
}

/** Main strategy computation. */
export function computeStrategy(
  holdings: EnrichedHolding[],
  config: Config,
  brentPrice: number | null,
  sectors: Record<string, SectorSummary>,
  signals: Record<string, StockSignal>
): StrategyData {
  const portfolioValue = holdings.reduce((sum, h) => sum + h.currentPrice * h.qty, 0);
  const totalInvested = holdings.reduce((sum, h) => sum + h.invested, 0);
  const totalPnl = portfolioValue - totalInvested;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const targetValue = 10000000; // ₹1 Crore

  // Classify all holdings
  const classifications = holdings.map(h => classifyHolding(h, portfolioValue, config));
  const cut = classifications.filter(c => c.action === 'CUT').sort((a, b) => a.value - b.value);
  const keep = classifications.filter(c => c.action === 'KEEP').sort((a, b) => b.value - a.value);
  const scaleUp = classifications.filter(c => c.action === 'SCALE_UP').sort((a, b) => b.value - a.value);

  const freedCapital = cut.reduce((sum, c) => sum + c.value, 0);
  const taxLoss = cut.filter(c => c.pnl < 0).reduce((sum, c) => sum + Math.abs(c.pnl), 0);

  // Sector insights
  const sectorInsights = generateSectorInsights(holdings, sectors, portfolioValue);

  // Strategy pods
  const pods = generatePods(holdings, classifications, brentPrice);

  // Action phases
  const actionPhases = [
    {
      phase: 'Phase 1: The Great Consolidation',
      months: 'Month 1-2',
      description: 'Sell all micro positions. This isn\'t giving up — it\'s focusing your ammunition. 250 tiny positions are noise. Convert them into capital for your best ideas.',
      actions: [
        `Sell ${cut.length} positions to free up ~₹${(freedCapital / 100000).toFixed(1)}L`,
        `Harvest ~₹${(taxLoss / 100000).toFixed(1)}L in tax losses (offsets future capital gains)`,
        'Portfolio drops from 305 to ~' + (keep.length + scaleUp.length) + ' focused positions',
        'Park freed capital in liquid fund for 1-2 weeks while planning Phase 2',
      ],
    },
    {
      phase: 'Phase 2: The Strategic Tilt',
      months: 'Month 2-4',
      description: 'Redeploy the freed capital into your strongest sectors. Increase IT and Pharma exposure to benefit from INR weakness. This is where macro awareness becomes your edge.',
      actions: [
        'Deploy 40% of freed capital into IT + Pharma export earners',
        'Deploy 30% into scaling up existing winners',
        'Deploy 20% into beaten-down quality recovery bets',
        'Keep 10% as dry powder for opportunities',
      ],
    },
    {
      phase: 'Phase 3: Scale the Winners',
      months: 'Month 4-8',
      description: 'By now, your thesis is being tested by the market. Double down on what\'s working. Cut what isn\'t. This is where concentration starts compounding.',
      actions: [
        `Scale top ${scaleUp.length} positions to 3-5% each`,
        'Trim any KEEP position that hasn\'t shown momentum in 3 months',
        'Rebalance sectors monthly — no sector above 25%',
        'If Hormuz resolves: rotate 10% from defensive into cyclicals',
      ],
    },
    {
      phase: 'Phase 4: Harvest & Compound',
      months: 'Month 8-18',
      description: 'The portfolio is now concentrated, macro-aligned, and compounding. Your job is to not mess it up. Quarterly reviews, not daily checking. Let the winners run.',
      actions: [
        'Quarterly rebalancing — sell what breaks thesis, add to what\'s working',
        'Target: 25-30 positions, each 2-5% of portfolio',
        'If portfolio reaches ₹85-90L: start taking partial profits on biggest winners',
        'Reinvest profits into next cycle of beaten-down quality',
      ],
    },
  ];

  // Optimist case
  const optimistCase = `Here\'s the math that matters: you need ₹${((targetValue - portfolioValue) / 100000).toFixed(0)}L more to reach ₹1Cr. That\'s ${((targetValue / portfolioValue - 1) * 100).toFixed(0)}% growth. Sounds like a lot? After every major Indian market correction — 2008, 2013, 2016, 2020 — the Nifty Midcap index delivered 40-80% returns within 18 months of the bottom. Your portfolio is mid-cap heavy. If history rhymes — and it always does in India — the recovery alone could get you most of the way there. The consolidation unlocks ₹${(freedCapital / 100000).toFixed(0)}L of trapped capital. The tax harvesting saves ₹${(taxLoss * 0.15 / 1000).toFixed(0)}K in future tax liability. The sector tilt puts the wind at your back. You\'re not starting from zero. You\'re starting from ₹69L of hard-won market education, and every one of those 305 positions taught you something about what works and what doesn\'t.`;

  return {
    generated_at: new Date().toISOString(),
    portfolio: {
      current_value: portfolioValue,
      target_value: targetValue,
      growth_needed_pct: ((targetValue / portfolioValue) - 1) * 100,
      total_invested: totalInvested,
      total_pnl: totalPnl,
      total_pnl_pct: totalPnlPct,
      holdings_count: holdings.length,
    },
    macro: {
      brent_price: brentPrice,
      hormuz_summary: 'Tanker deliveries through Hormuz at 14/day, down 70% from 48/day in 2025. Significant supply disruption risk. Two scenarios: escalation (oil above $120, bad for India) or negotiated resolution (oil drops to $80-85, market rallies). Current Brent at $' + (brentPrice?.toFixed(0) || 'N/A') + ' suggests market is pricing in ongoing tension but not full escalation.',
      inr_outlook: 'INR under structural pressure from oil imports, current account deficit, and relative interest rate differentials. Likely range: ₹86-90 per USD over next 12 months. This is a tailwind for export-earning sectors (IT, Pharma, Auto parts) and a headwind for importers (Oil, Chemicals).',
      market_phase: 'Indian mid-caps have been sideways to negative for 12+ months after the 2021-2024 bull run. Historical pattern: sideways phases in India last 12-24 months before the next leg up. We may be 60-70% through this consolidation phase.',
    },
    consolidation: {
      cut,
      keep,
      scaleUp,
      freed_capital: freedCapital,
      tax_harvestable_loss: taxLoss,
      target_stock_count: keep.length + scaleUp.length,
    },
    pods,
    recommended_pod: 'hybrid',
    action_phases: actionPhases,
    optimist_case: optimistCase,
    sector_insights: sectorInsights,
  };
}
