/**
 * The six Deal Score factors (docs/mvp/02-deal-score.md §3).
 *
 * Each returns a sub-score on 0–100 plus availability. A factor that cannot be
 * computed reports UNAVAILABLE rather than substituting a neutral 50 — a
 * neutral substitute would drag every score toward the middle and hide the
 * missing data.
 */

import type { ScoringConfig } from '../config/defaults.js';
import {
  clamp,
  median,
  percentileRank,
  percentileRankFromLadder,
  theilSenSlope,
  toScore,
} from '../stats.js';
import type {
  BaselineDistribution,
  BenefitValue,
  ComparableRate,
  CurrentRate,
  DemandInput,
  FactorResult,
  FactorUnavailableReason,
  Minor,
  SeasonalityInput,
  SeriesPoint,
  StayQuery,
} from '../types.js';

function unavailable(
  code: FactorResult['code'],
  name: string,
  weight: number,
  reason: FactorUnavailableReason,
): FactorResult {
  return {
    code,
    name,
    available: false,
    subScore: null,
    rawValue: null,
    unit: null,
    weight,
    weightApplied: 0,
    unavailableReason: reason,
  };
}

// ── F1 · Historical Price Percentile ──────────────────────────────────────

export interface F1Result {
  readonly factor: FactorResult;
  /** Empirical percentile rank of the current rate within the baseline, 0–1. */
  readonly percentileRank: number | null;
  readonly pctBelowTypical: number | null;
}

export function computeF1(
  current: CurrentRate,
  baseline: BaselineDistribution | null,
  config: ScoringConfig,
): F1Result {
  const weight = config.score.weight.f1Historical;
  const name = 'Historical price';

  if (!baseline) {
    return {
      factor: unavailable('F1', name, weight, 'NO_BASELINE'),
      percentileRank: null,
      pctBelowTypical: null,
    };
  }
  if (baseline.nObservations < config.baseline.minObsAbs) {
    return {
      factor: unavailable('F1', name, weight, 'INSUFFICIENT_OBSERVATIONS'),
      percentileRank: null,
      pctBelowTypical: null,
    };
  }

  // Prefer the raw distribution when we have it; fall back to interpolating the
  // rollup ladder, which is what production actually stores.
  const rank =
    baseline.values && baseline.values.length > 0
      ? percentileRank(baseline.values, current.nightlyMinor)
      : percentileRankFromLadder(baseline, current.nightlyMinor);

  const subScore = toScore(100 * (1 - rank));
  const pctBelowTypical =
    baseline.p50 === 0 ? 0 : ((baseline.p50 - current.nightlyMinor) / baseline.p50) * 100;

  return {
    factor: {
      code: 'F1',
      name,
      available: true,
      subScore,
      rawValue: rank * 100,
      unit: 'PERCENTILE',
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    percentileRank: rank,
    pctBelowTypical,
  };
}

// ── F2 · Market / Comp-Set Position ───────────────────────────────────────

export interface F2Result {
  readonly factor: FactorResult;
  /** Raw median comparison for display — not the scoring input. */
  readonly pctVsCompMedian: number | null;
  readonly compCount: number;
  readonly compMedianNightlyMinor: Minor | null;
  readonly subjectIndex: number | null;
  readonly marketIndex: number | null;
}

const NO_F2: Omit<F2Result, 'factor'> = {
  pctVsCompMedian: null,
  compCount: 0,
  compMedianNightlyMinor: null,
  subjectIndex: null,
  marketIndex: null,
};

export function computeF2(
  current: CurrentRate,
  baseline: BaselineDistribution | null,
  comparables: readonly ComparableRate[],
  config: ScoringConfig,
): F2Result {
  const weight = config.score.weight.f2Market;
  const name = 'Market comparison';

  const usable = comparables.filter((c) => c.baselineMedianMinor > 0 && c.currentNightlyMinor > 0);

  if (!baseline || baseline.p50 <= 0) {
    return { factor: unavailable('F2', name, weight, 'NO_BASELINE'), ...NO_F2 };
  }
  if (usable.length < config.score.market.minComps) {
    return {
      factor: unavailable('F2', name, weight, 'INSUFFICIENT_COMPARABLES'),
      ...NO_F2,
      compCount: usable.length,
    };
  }

  // Compare how far each hotel is discounting relative to its OWN norm.
  // Comparing raw prices would merely report that premium hotels cost more,
  // permanently suppressing their scores. See docs/mvp/02 §3, F2.
  const subjectIndex = current.nightlyMinor / baseline.p50;
  const compIndices = usable.map((c) => c.currentNightlyMinor / c.baselineMedianMinor);
  const marketIndex = median(compIndices);

  const rank = percentileRank([...compIndices, subjectIndex], subjectIndex);
  const subScore = toScore(100 * (1 - rank));

  const compMedian = median(usable.map((c) => c.currentNightlyMinor));
  const pctVsCompMedian =
    compMedian === 0 ? 0 : ((compMedian - current.nightlyMinor) / compMedian) * 100;

  return {
    factor: {
      code: 'F2',
      name,
      available: true,
      subScore,
      rawValue: pctVsCompMedian,
      unit: 'PERCENT',
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    pctVsCompMedian,
    compCount: usable.length,
    compMedianNightlyMinor: Math.round(compMedian),
    subjectIndex,
    marketIndex,
  };
}

// ── F3 · Recent Price Movement ────────────────────────────────────────────

export interface F3Result {
  readonly factor: FactorResult;
  /** Fractional change across the window (0.09 = +9%). */
  readonly deltaFraction: number | null;
  readonly deltaPct: number | null;
  readonly windowStartNightlyMinor: Minor | null;
  readonly pointsUsed: number;
}

const NO_F3: Omit<F3Result, 'factor'> = {
  deltaFraction: null,
  deltaPct: null,
  windowStartNightlyMinor: null,
  pointsUsed: 0,
};

export function computeF3(
  series: readonly SeriesPoint[],
  now: Date,
  config: ScoringConfig,
  windowDaysOverride?: number,
): F3Result {
  const weight = config.score.weight.f3Trend;
  const name = 'Recent movement';
  const windowDays = windowDaysOverride ?? config.score.trend.windowDays;

  const cutoff = now.getTime() - windowDays * 86_400_000;
  const inWindow = series
    .map((p) => ({ t: Date.parse(p.observedAt), y: p.nightlyMinor }))
    .filter((p) => Number.isFinite(p.t) && p.t >= cutoff)
    .sort((a, b) => a.t - b.t);

  if (inWindow.length < config.score.trend.minSeriesPoints) {
    return {
      factor: unavailable('F3', name, weight, 'INSUFFICIENT_SERIES_POINTS'),
      ...NO_F3,
      pointsUsed: inWindow.length,
    };
  }

  const first = inWindow[0];
  if (!first || first.y <= 0) {
    return { factor: unavailable('F3', name, weight, 'INSUFFICIENT_SERIES_POINTS'), ...NO_F3 };
  }

  // Theil–Sen over (days, price): resistant to a single spurious capture, which
  // would dominate a least-squares fit over 4–10 points.
  const slopePerDay = theilSenSlope(
    inWindow.map((p) => ({ x: (p.t - first.t) / 86_400_000, y: p.y })),
  );
  const deltaFraction = (slopePerDay * windowDays) / first.y;

  // Rising price → higher score: the rate in front of the customer is better
  // than what is coming. Flagged for calibration review (docs/mvp/02, D7).
  const subScore = toScore(50 + deltaFraction * config.score.trend.gain);

  return {
    factor: {
      code: 'F3',
      name,
      available: true,
      subScore,
      rawValue: deltaFraction * 100,
      unit: 'PERCENT',
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    deltaFraction,
    deltaPct: deltaFraction * 100,
    windowStartNightlyMinor: first.y,
    pointsUsed: inWindow.length,
  };
}

// ── F4 · Seasonality ──────────────────────────────────────────────────────

export function computeF4(
  seasonality: SeasonalityInput | null | undefined,
  config: ScoringConfig,
): FactorResult {
  const weight = config.score.weight.f4Seasonality;
  const name = 'Seasonality';

  // At MVP launch this is expected to be UNAVAILABLE until a full year of
  // history accrues. Its weight redistributes. See docs/mvp/02 §3, F4.
  if (!seasonality) return unavailable('F4', name, weight, 'INSUFFICIENT_HISTORY');
  if (seasonality.historyDays < config.score.season.minHistoryDays) {
    return unavailable('F4', name, weight, 'INSUFFICIENT_HISTORY');
  }

  const subScore = toScore(50 + (1 - seasonality.seasonalIndex) * config.score.season.gain);

  return {
    code: 'F4',
    name,
    available: true,
    subScore,
    rawValue: seasonality.seasonalIndex,
    unit: 'RATIO',
    weight,
    weightApplied: 0,
    unavailableReason: null,
  };
}

// ── F5 · Demand / Events ──────────────────────────────────────────────────

const SCARCITY_NORMAL = 10;

export interface F5Result {
  readonly factor: FactorResult;
  /** Normalized demand pressure 0–1. Also feeds the never-WAIT guards. */
  readonly demandPressure: number;
  readonly hasSignal: boolean;
  readonly events: readonly string[];
}

export function computeF5(
  demand: DemandInput | null | undefined,
  percentileRankValue: number | null,
  config: ScoringConfig,
): F5Result {
  const weight = config.score.weight.f5Demand;
  const name = 'Demand';

  const signals: number[] = [];
  const events: string[] = [];

  if (demand) {
    if (demand.events && demand.events.length > 0) {
      const total = demand.events.reduce((sum, e) => sum + e.impactScore, 0);
      signals.push(clamp(total, 0, 1));
      for (const e of demand.events) events.push(e.name);
    }
    if (demand.roomsLeft !== null && demand.roomsLeft !== undefined) {
      signals.push(1 - clamp(demand.roomsLeft / SCARCITY_NORMAL, 0, 1));
    }
    if (demand.compSoldOutShare !== null && demand.compSoldOutShare !== undefined) {
      signals.push(clamp(demand.compSoldOutShare, 0, 1));
    }
    if (
      demand.bookingVelocityPercentile !== null &&
      demand.bookingVelocityPercentile !== undefined
    ) {
      signals.push(clamp(demand.bookingVelocityPercentile, 0, 1));
    }
  }

  const hasSignal = signals.length > 0;
  const demandPressure = hasSignal ? Math.max(...signals) : 0;

  if (!hasSignal || percentileRankValue === null) {
    return {
      factor: unavailable('F5', name, weight, 'NO_DEMAND_SIGNAL'),
      demandPressure,
      hasSignal,
      events,
    };
  }

  // High demand amplifies whatever F1 already says: a rate held low against
  // pressure is a better deal; one marked up into it is worse.
  const subScore = toScore(50 + demandPressure * 50 * (1 - 2 * percentileRankValue));

  return {
    factor: {
      code: 'F5',
      name,
      available: true,
      subScore,
      rawValue: demandPressure,
      unit: 'RATIO',
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    demandPressure,
    hasSignal,
    events,
  };
}

// ── F6 · Effective Value (Benefits) ───────────────────────────────────────

export interface F6Result {
  readonly factor: FactorResult;
  readonly benefitValuePerNightMinor: Minor;
  readonly effectiveNightlyMinor: Minor | null;
  readonly valueRatio: number | null;
  readonly benefitNames: readonly string[];
  readonly wasCapped: boolean;
}

export function computeF6(
  current: CurrentRate,
  query: StayQuery,
  benefits: readonly BenefitValue[],
  config: ScoringConfig,
): F6Result {
  const weight = config.score.weight.f6Value;
  const name = 'Included value';

  if (benefits.length === 0) {
    return {
      factor: unavailable('F6', name, weight, 'NO_BENEFITS'),
      benefitValuePerNightMinor: 0,
      effectiveNightlyMinor: null,
      valueRatio: null,
      benefitNames: [],
      wasCapped: false,
    };
  }

  let perNightTotal = 0;
  for (const b of benefits) {
    // Realization discounts are deliberate: a benefit that might materialize is
    // not worth face value. See docs/mvp/02 §3, F6.
    const realized = b.valueMinor * b.realizationFactor;
    perNightTotal += b.basis === 'PER_NIGHT' ? realized : realized / query.nights;
  }

  const cap = current.nightlyMinor * config.score.value.benefitCapPct;
  const wasCapped = perNightTotal > cap;
  const capped = Math.round(Math.min(perNightTotal, cap));

  const valueRatio = current.nightlyMinor === 0 ? 0 : capped / current.nightlyMinor;
  const subScore = toScore(50 + valueRatio * config.score.value.gain);

  return {
    factor: {
      code: 'F6',
      name,
      available: true,
      subScore,
      rawValue: capped,
      unit: 'CURRENCY_MINOR',
      weight,
      weightApplied: 0,
      unavailableReason: null,
    },
    benefitValuePerNightMinor: capped,
    effectiveNightlyMinor: current.nightlyMinor - capped,
    valueRatio,
    benefitNames: benefits.map((b) => b.displayName),
    wasCapped,
  };
}
