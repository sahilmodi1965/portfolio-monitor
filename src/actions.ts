import type { EnrichedHolding, Config, SectorSummary } from './types.js';
import type { HoldingClassification, StrategyData } from './strategy.js';
import { pctChange, formatINR } from './utils.js';

export interface DailyAction {
  type: 'SELL' | 'BUY' | 'WATCH' | 'HOLD';
  urgency: 'TODAY' | 'THIS_WEEK' | 'WHEN_READY';
  instrument: string;
  sector: string;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  instruction: string;
  reason: string;
}

export interface ActionsData {
  generated_at: string;
  date_display: string;
  weekday: string;
  phase: {
    number: number;
    name: string;
    description: string;
    progress_pct: number;
  };
  market_pulse: {
    portfolio_value: number;
    target_value: number;
    gap_pct: number;
    day_change_pct: number;
    brent_price: number | null;
    positions_total: number;
    positions_to_sell: number;
    capital_in_cuts: number;
  };
  todays_sells: DailyAction[];
  todays_buys: DailyAction[];
  watch_list: DailyAction[];
  hold_steady: { count: number; value: number };
  daily_briefing: string;
  tomorrow_preview: string;
  weekly_goal: string;
  sop_checklist: string[];
}

/** Detect which phase we're in based on portfolio state. */
function detectPhase(
  totalPositions: number,
  cutsRemaining: number,
  scaleUpCount: number,
  portfolioValue: number,
  targetValue: number
): { number: number; name: string; description: string; progress_pct: number } {
  const cutRatio = cutsRemaining / Math.max(totalPositions, 1);
  const gapPct = ((targetValue - portfolioValue) / targetValue) * 100;

  // Phase 1: Still have many positions to sell (>100 total or >30% are CUT)
  if (totalPositions > 100 || cutRatio > 0.3) {
    const progress = Math.round((1 - cutRatio) * 100);
    return {
      number: 1,
      name: 'The Great Consolidation',
      description: 'Selling micro positions and dead weight. Focus: free up capital, harvest tax losses, reduce from ' + totalPositions + ' to ~30 stocks.',
      progress_pct: Math.min(progress, 95),
    };
  }

  // Phase 2: Positions sold, now redeploying (60-100 positions, still underweight in SCALE_UP)
  if (totalPositions > 50) {
    return {
      number: 2,
      name: 'The Strategic Tilt',
      description: 'Capital freed up. Now redeploying into IT, Pharma, and proven winners. Building the export-earning, rupee-hedged core.',
      progress_pct: Math.round(((100 - totalPositions) / 50) * 100),
    };
  }

  // Phase 3: Concentrated, now scaling winners (30-50 positions)
  if (gapPct > 15) {
    return {
      number: 3,
      name: 'Scale the Winners',
      description: 'Portfolio is focused. Double down on what\'s working, trim what isn\'t. Monthly rebalancing.',
      progress_pct: Math.round((1 - gapPct / 45) * 100),
    };
  }

  // Phase 4: Near target
  return {
    number: 4,
    name: 'Harvest & Compound',
    description: 'Portfolio is concentrated and compounding. Quarterly reviews. Let winners run. Almost there.',
    progress_pct: Math.round((1 - gapPct / 15) * 100),
  };
}

/** Pick today's sell batch — prioritized by urgency. */
function pickTodaysSells(cuts: HoldingClassification[], batchSize: number): DailyAction[] {
  // Priority order: smallest first (quick wins), then biggest losers, then rest
  const sorted = [...cuts].sort((a, b) => {
    // Tier 1: dust positions under ₹5K (clear immediately)
    if (a.value < 5000 && b.value >= 5000) return -1;
    if (b.value < 5000 && a.value >= 5000) return 1;
    // Tier 2: under ₹10K
    if (a.value < 10000 && b.value >= 10000) return -1;
    if (b.value < 10000 && a.value >= 10000) return 1;
    // Within same tier: worst P&L% first (harvest the biggest tax loss)
    return a.pnlPct - b.pnlPct;
  });

  const batch = sorted.slice(0, batchSize);
  return batch.map((c, i) => {
    let urgency: 'TODAY' | 'THIS_WEEK' | 'WHEN_READY' = 'TODAY';
    if (i >= 7) urgency = 'THIS_WEEK';
    if (i >= 12) urgency = 'WHEN_READY';

    let instruction = 'Sell full position';
    if (c.value < 5000) instruction = 'Sell full position (dust — just clear it)';
    else if (c.pnl < -1000) instruction = 'Sell full position (book ₹' + Math.abs(c.pnl).toFixed(0) + ' tax loss)';
    else if (c.pnl > 0) instruction = 'Sell full position (lock in ₹' + c.pnl.toFixed(0) + ' profit)';

    return {
      type: 'SELL' as const,
      urgency,
      instrument: c.instrument,
      sector: c.sector,
      currentValue: c.value,
      pnl: c.pnl,
      pnlPct: c.pnlPct,
      instruction,
      reason: c.reason,
    };
  });
}

/** Pick today's buy recommendations. */
function pickTodaysBuys(
  scaleUps: HoldingClassification[],
  capitalAvailable: number,
  portfolioValue: number
): DailyAction[] {
  if (capitalAvailable < 10000) return []; // Not enough freed capital yet

  // Sort by: profitable first, then by how far below target weight
  const sorted = [...scaleUps].sort((a, b) => {
    if (a.pnlPct > 0 && b.pnlPct <= 0) return -1;
    if (b.pnlPct > 0 && a.pnlPct <= 0) return 1;
    return b.pnlPct - a.pnlPct;
  });

  const targetWeight = 3.5; // Target 3.5% per position
  return sorted.slice(0, 5).map(c => {
    const currentWeight = (c.value / portfolioValue) * 100;
    const gapPct = targetWeight - currentWeight;
    const gapValue = (gapPct / 100) * portfolioValue;
    const suggestedBuy = Math.min(gapValue, capitalAvailable * 0.15); // Max 15% of available capital per stock

    let instruction = 'Add ~' + formatINR(suggestedBuy) + ' to reach ' + targetWeight + '% weight';
    if (currentWeight >= targetWeight) {
      instruction = 'Already at target weight — hold, no action needed';
    }

    return {
      type: 'BUY' as const,
      urgency: 'THIS_WEEK' as const,
      instrument: c.instrument,
      sector: c.sector,
      currentValue: c.value,
      pnl: c.pnl,
      pnlPct: c.pnlPct,
      instruction,
      reason: c.reason,
    };
  });
}

/** Generate watch list — stocks with notable momentum shifts. */
function generateWatchList(
  holdings: EnrichedHolding[],
  keeps: HoldingClassification[]
): DailyAction[] {
  const watchItems: DailyAction[] = [];

  for (const h of holdings) {
    const value = h.currentPrice * h.qty;
    if (value < 30000) continue;

    // Big day movers
    if (Math.abs(h.dayChgPct) > 3) {
      const direction = h.dayChgPct > 0 ? 'up' : 'down';
      watchItems.push({
        type: 'WATCH',
        urgency: 'TODAY',
        instrument: h.instrument,
        sector: h.sector,
        currentValue: value,
        pnl: h.pnl,
        pnlPct: h.netChgPct,
        instruction: 'Monitor — moved ' + h.dayChgPct.toFixed(1) + '% today',
        reason: h.instrument + ' is ' + direction + ' ' + Math.abs(h.dayChgPct).toFixed(1) + '% today. ' +
          (h.dayChgPct > 3 ? 'Strong move — check if there\'s news driving this.' : 'Sharp drop — check if it\'s sector-wide or stock-specific.'),
      });
    }

    // Momentum reversals (4-week momentum diverges from overall P&L)
    if (h.weeklyPrices.length >= 2) {
      const momentum = pctChange(h.weeklyPrices[0], h.weeklyPrices[h.weeklyPrices.length - 1]);
      if (h.netChgPct < -15 && momentum > 3 && value > 50000) {
        watchItems.push({
          type: 'WATCH',
          urgency: 'THIS_WEEK',
          instrument: h.instrument,
          sector: h.sector,
          currentValue: value,
          pnl: h.pnl,
          pnlPct: h.netChgPct,
          instruction: 'Momentum reversal detected — may be starting to recover',
          reason: 'Down ' + Math.abs(h.netChgPct).toFixed(0) + '% overall but up ' + momentum.toFixed(1) + '% in last 4 weeks. Could be the turn. Watch for confirmation.',
        });
      }
    }
  }

  // Sort by urgency then by absolute day change
  return watchItems
    .sort((a, b) => {
      if (a.urgency === 'TODAY' && b.urgency !== 'TODAY') return -1;
      if (b.urgency === 'TODAY' && a.urgency !== 'TODAY') return 1;
      return Math.abs(b.pnlPct) - Math.abs(a.pnlPct);
    })
    .slice(0, 8);
}

/** Generate the daily briefing narrative. */
function generateBriefing(
  phase: { number: number; name: string },
  sells: DailyAction[],
  buys: DailyAction[],
  cutsRemaining: number,
  capitalInCuts: number,
  dayChangePct: number,
  brentPrice: number | null
): string {
  const parts: string[] = [];

  // Phase context
  if (phase.number === 1) {
    parts.push('We\'re in Phase 1: clearing out the clutter. ' + cutsRemaining + ' positions still need to go, holding ' + formatINR(capitalInCuts) + ' in trapped capital.');
    if (sells.length > 0) {
      parts.push('Today\'s batch: ' + sells.filter(s => s.urgency === 'TODAY').length + ' stocks to sell.');
    }
  } else if (phase.number === 2) {
    parts.push('Phase 2 is active: redeploying capital into our strongest positions.');
    if (buys.length > 0) {
      parts.push(buys.length + ' stocks recommended for adding capital today.');
    }
  } else if (phase.number === 3) {
    parts.push('Phase 3: scaling winners and trimming non-performers. Stay disciplined.');
  } else {
    parts.push('Phase 4: the portfolio is working. Quarterly rebalance only. No daily action needed.');
  }

  // Market color
  if (Math.abs(dayChangePct) > 1) {
    if (dayChangePct > 1) {
      parts.push('Market was strong yesterday (+' + dayChangePct.toFixed(1) + '%). Good day to sell CUT positions into strength — buyers are active.');
    } else {
      parts.push('Market was weak yesterday (' + dayChangePct.toFixed(1) + '%). Don\'t panic sell. If anything, pause sells and wait for a green day.');
    }
  }

  // Brent
  if (brentPrice !== null && brentPrice > 100) {
    parts.push('Brent at $' + brentPrice.toFixed(0) + ' — oil-sensitive stocks under pressure. Favor IT and Pharma today.');
  }

  return parts.join(' ');
}

/** Main: compute today's daily actions. */
export function computeDailyActions(
  holdings: EnrichedHolding[],
  strategy: StrategyData,
  brentPrice: number | null
): ActionsData {
  const now = new Date();
  const dateDisplay = now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const weekday = now.toLocaleDateString('en-IN', { weekday: 'long' });

  const portfolioValue = holdings.reduce((s, h) => s + h.currentPrice * h.qty, 0);
  const targetValue = 10000000;
  const gapPct = ((targetValue - portfolioValue) / targetValue) * 100;

  // Average day change across portfolio
  const dayChangePct = holdings.length > 0
    ? holdings.reduce((s, h) => s + h.dayChgPct, 0) / holdings.length
    : 0;

  const cuts = strategy.consolidation.cut;
  const keeps = strategy.consolidation.keep;
  const scaleUps = strategy.consolidation.scaleUp;
  const capitalInCuts = cuts.reduce((s, c) => s + c.value, 0);

  // Detect phase
  const phase = detectPhase(holdings.length, cuts.length, scaleUps.length, portfolioValue, targetValue);

  // Calculate capital available for buying (estimate: assume some sells have been done)
  // In phase 1, suggest sells. In phase 2+, suggest buys if capital is available.
  const capitalAvailable = phase.number >= 2 ? capitalInCuts * 0.3 : 0;

  // Pick today's actions
  const dailySellBatch = phase.number <= 1 ? 10 : 5; // More aggressive selling in Phase 1
  const todays_sells = pickTodaysSells(cuts, dailySellBatch);
  const todays_buys = phase.number >= 2 ? pickTodaysBuys(scaleUps, capitalAvailable, portfolioValue) : [];
  const watch_list = generateWatchList(holdings, keeps);

  const holdCount = keeps.length + scaleUps.length - todays_buys.length;
  const holdValue = [...keeps, ...scaleUps].reduce((s, c) => s + c.value, 0);

  // Daily briefing
  const dailyBriefing = generateBriefing(phase, todays_sells, todays_buys, cuts.length, capitalInCuts, dayChangePct, brentPrice);

  // Tomorrow preview
  let tomorrowPreview = '';
  if (phase.number === 1) {
    const remaining = cuts.length - todays_sells.length;
    if (remaining > 0) {
      tomorrowPreview = 'Tomorrow: ' + Math.min(remaining, dailySellBatch) + ' more positions to sell. At this pace, Phase 1 completes in ~' + Math.ceil(remaining / dailySellBatch) + ' trading days (' + Math.ceil(remaining / dailySellBatch / 5) + ' weeks).';
    } else {
      tomorrowPreview = 'Tomorrow: Phase 1 is nearly complete! Start planning Phase 2 — redeploying capital into winners.';
    }
  } else if (phase.number === 2) {
    tomorrowPreview = 'Tomorrow: continue deploying capital into SCALE_UP positions. Watch for sector rotation signals.';
  } else {
    tomorrowPreview = 'Tomorrow: monitor positions. No major action expected unless a stock breaks its thesis.';
  }

  // Weekly goal
  const weeklySells = Math.min(cuts.length, dailySellBatch * 5);
  const weeklyCapital = todays_sells.reduce((s, a) => s + a.currentValue, 0) * 5;
  let weeklyGoal = '';
  if (phase.number === 1) {
    weeklyGoal = 'This week\'s goal: sell ' + weeklySells + ' positions, free up ~' + formatINR(weeklyCapital) + '. Keep selling into green days, pause on sharp red days.';
  } else if (phase.number === 2) {
    weeklyGoal = 'This week\'s goal: deploy capital into top 3 SCALE_UP picks. Target 3-4% weight for each.';
  } else {
    weeklyGoal = 'This week\'s goal: review all positions. Trim anything that\'s lost momentum for 3+ weeks.';
  }

  // SOP checklist
  const sop = [
    'Open this page and read today\'s briefing',
    'Review the SELL list — execute sells marked "TODAY" first',
    'Check the WATCH list — note any big movers or reversals',
    phase.number >= 2 ? 'Review BUY recommendations — add to winners if capital is available' : 'Park sale proceeds in liquid fund (will deploy in Phase 2)',
    'At market close: Sahil exports fresh holdings.csv from Zerodha',
    'Push to GitHub — tomorrow\'s actions auto-generate overnight',
  ];

  return {
    generated_at: now.toISOString(),
    date_display: dateDisplay,
    weekday,
    phase,
    market_pulse: {
      portfolio_value: portfolioValue,
      target_value: targetValue,
      gap_pct: gapPct,
      day_change_pct: dayChangePct,
      brent_price: brentPrice,
      positions_total: holdings.length,
      positions_to_sell: cuts.length,
      capital_in_cuts: capitalInCuts,
    },
    todays_sells,
    todays_buys,
    watch_list,
    hold_steady: { count: holdCount, value: holdValue },
    daily_briefing: dailyBriefing,
    tomorrow_preview: tomorrowPreview,
    weekly_goal: weeklyGoal,
    sop_checklist: sop,
  };
}
