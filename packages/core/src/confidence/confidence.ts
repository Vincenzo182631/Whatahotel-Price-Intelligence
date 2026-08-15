/**
 * Confidence Score — how much we trust the Deal Score, given the quantity,
 * freshness, consistency and cleanliness of the evidence.
 *
 * Combined as a WEIGHTED GEOMETRIC MEAN, not an arithmetic one. With an
 * arithmetic mean, data three weeks stale (f_freshness ≈ 0.05) alongside five
 * healthy factors still averages ≈ 0.76 — enough to confidently recommend
 * action on a price that no longer exists. Geometric gives ≈ 0.45 and the
 * recommendation engine correctly refuses.
 *
 * Confidence should be limited by its weakest evidence, not rescued by its
 * strongest. See docs/mvp/03-confidence-and-recommendation.md §3.
 */

import type { ScoringConfig } from '../config/defaults.js';
import { clamp, hoursBetween, weightedGeometricMean } from '../stats.js';
import type {
  BaselineDistribution,
  ConfidenceBand,
  ConfidenceFactorResult,
  ConfidenceResult,
  CurrentRate,
  MatchMethod,
} from '../types.js';
import { UNRESOLVED_CLASS } from '../types.js';

const MATCH_METHOD_WEIGHT: Record<MatchMethod, number> = {
  SOURCE_ID: 1.0,
  ALIAS_EXACT: 0.95,
  ALIAS_FUZZY: 0.75,
  ATTRIBUTE_INFERRED: 0.5,
  UNMATCHED: 0,
};

/** More observations → higher confidence, with diminishing returns. */
export function fVolume(n: number, config: ScoringConfig): number {
  const target = config.confidence.volumeTargetN;
  if (n <= 0) return 0;
  return clamp(Math.log(1 + n) / Math.log(1 + target), 0, 1);
}

/** Stale data collapses confidence quickly — a five-day-old price is not a price. */
export function fFreshness(ageHours: number, config: ScoringConfig): number {
  const { freshFullHours, freshZeroHours, freshFloor } = config.confidence;
  if (ageHours <= freshFullHours) return 1;
  if (ageHours > freshZeroHours) return freshFloor;
  const span = freshZeroHours - freshFullHours;
  const progressed = (ageHours - freshFullHours) / span;
  return clamp(1 - progressed * 0.8, 0.2, 1);
}

/** Sources disagreeing about the same rate means at least one is wrong. */
export function fConsistency(
  crossSourceCv: number | null | undefined,
  nSources: number,
  config: ScoringConfig,
): number {
  if (nSources <= 1 || crossSourceCv === null || crossSourceCv === undefined) {
    // Below 1.0 deliberately: one source means no corroboration. Not punitive,
    // because a single authoritative first-party source is legitimate at MVP.
    return config.confidence.singleSourceValue;
  }
  return clamp(1 - crossSourceCv / config.confidence.consistencyCvMax, 0, 1);
}

export function fCoverage(nFreshComps: number, config: ScoringConfig): number {
  return clamp(nFreshComps / config.confidence.coverageTargetComps, 0, 1);
}

/**
 * High volatility does not make a percentile meaningless — a rate at the 5th
 * percentile of a volatile distribution is still genuinely low. It makes the
 * judgement less durable, which is why there is a floor.
 */
export function fVolatility(cv: number, config: ScoringConfig): number {
  const raw = 1 - cv / config.confidence.volatilityCvMax;
  return Math.max(clamp(raw, 0, 1), config.confidence.volatilityFloor);
}

/** If we are not sure the historical rows describe the same room, nothing downstream is trustworthy. */
export function fMatch(
  current: CurrentRate,
  baseline: BaselineDistribution | null,
  config: ScoringConfig,
): number {
  const currentWeight = MATCH_METHOD_WEIGHT[current.matchMethod] * current.matchConfidence;
  const baselineWeight = baseline ? baseline.meanMatchConfidence : currentWeight;

  const n = baseline ? baseline.nObservations : 0;
  const combined = n > 0 ? (baselineWeight * n + currentWeight) / (n + 1) : currentWeight;

  let value = clamp(combined, 0, 1);
  if (current.comparabilityClass === UNRESOLVED_CLASS) {
    value *= config.confidence.unresolvedCurrentPenalty;
  }
  if (baseline && baseline.unresolvedShare > config.confidence.unresolvedShareMax) {
    value *= config.confidence.unresolvedBaselinePenalty;
  }
  return clamp(value, 0, 1);
}

export function bandForConfidence(confidence: number, config: ScoringConfig): ConfidenceBand {
  const b = config.confidence.band;
  if (confidence >= b.highMin) return 'HIGH';
  if (confidence >= b.moderateMin) return 'MODERATE';
  if (confidence >= b.lowMin) return 'LOW';
  return 'INSUFFICIENT';
}

export interface ConfidenceInput {
  readonly current: CurrentRate;
  readonly baseline: BaselineDistribution | null;
  readonly nFreshComps: number;
  readonly marketFactorUsed: boolean;
  /** Σ(weights of available factors) ÷ Σ(all weights). */
  readonly weightCoverage: number;
  readonly now: Date;
}

export function computeConfidence(input: ConfidenceInput, config: ScoringConfig): ConfidenceResult {
  const { current, baseline, nFreshComps, marketFactorUsed, weightCoverage, now } = input;

  const ageHours = hoursBetween(new Date(current.observedAt), now);
  let freshness = fFreshness(ageHours, config);
  if (baseline) {
    const baselineAge = hoursBetween(new Date(baseline.computedAt), now);
    if (baselineAge > config.baseline.maxAgeHours) {
      freshness *= config.confidence.staleBaselinePenalty;
    }
  }

  const weights = config.confidence.weight;

  const factors: ConfidenceFactorResult[] = [
    {
      code: 'f_volume',
      name: 'Historical data volume',
      included: true,
      value: fVolume(baseline?.nObservations ?? 0, config),
      weight: weights.volume,
    },
    {
      code: 'f_freshness',
      name: 'Data freshness',
      included: true,
      value: clamp(freshness, 0, 1),
      weight: weights.freshness,
    },
    {
      code: 'f_match',
      name: 'Room and rate matching',
      included: true,
      value: fMatch(current, baseline, config),
      weight: weights.match,
    },
    {
      code: 'f_volatility',
      name: 'Price volatility',
      included: true,
      value: fVolatility(baseline?.cv ?? 0, config),
      weight: weights.volatility,
    },
    {
      code: 'f_consistency',
      name: 'Cross-source agreement',
      included: true,
      value: fConsistency(baseline?.crossSourceCv, baseline?.nSources ?? 1, config),
      weight: weights.consistency,
    },
    {
      // Only counted when F2 actually ran. Absence of a market comparison is
      // already penalized once through completeness; charging twice would
      // double-count. See docs/mvp/03 §2.4.
      code: 'f_coverage',
      name: 'Market coverage',
      included: marketFactorUsed,
      value: fCoverage(nFreshComps, config),
      weight: marketFactorUsed ? weights.coverage : 0,
    },
  ];

  const geometric = weightedGeometricMean(
    factors.filter((f) => f.included).map((f) => ({ value: f.value, weight: f.weight })),
  );

  const levelMultiplier = baseline
    ? config.baseline.levelMultiplier[baseline.level]
    : config.baseline.levelMultiplier.L4;

  // A Deal Score built from two of six factors deserves less trust than one
  // built from six. Without this, redistribution would let a thin score present
  // as confidently as a complete one.
  //
  // Scaled between a floor and 1.0 rather than applied raw: F4 and F5 are
  // expected to be unavailable at launch by design, and a raw multiplier would
  // permanently cap confidence for a planned gap rather than a quality problem.
  const floor = config.confidence.completenessFloor;
  const completeness = floor + (1 - floor) * clamp(weightCoverage, 0, 1);

  const confidence = Math.round(clamp(100 * geometric * levelMultiplier * completeness, 0, 100));

  return {
    confidence,
    band: bandForConfidence(confidence, config),
    factors,
    baselineLevelMultiplier: levelMultiplier,
    completeness,
  };
}
