/**
 * Configuration sweep — coordinate descent over the Deal Score weights.
 *
 * Produces a RANKED SUGGESTION, never an applied change. Activating a config is
 * a reviewed decision with evidence attached (docs/mvp/10 §11), and a search
 * that can silently move the weights would defeat the point of versioning them.
 *
 * Two guards against overfitting, both of which matter more than the search
 * itself:
 *   - candidates are scored on a HOLDOUT split the search never sees;
 *   - a candidate must beat the incumbent by a margin, or the incumbent wins.
 *     Weights that are merely different are not better.
 */

import { withConfig, type DeepPartial, type ScoringConfig } from '@wahpi/core';

import { allMetrics, type MetricResult } from './metrics.js';
import { evaluate, type ReplaySample } from './runbook.js';

export interface WeightVector {
  readonly f1Historical: number;
  readonly f2Market: number;
  readonly f3Trend: number;
  readonly f4Seasonality: number;
  readonly f6Value: number;
}

export interface Candidate {
  readonly weights: WeightVector;
  readonly loss: number;
  readonly trainLoss: number;
  /** Metric terms that contributed to the holdout loss. Few terms, weak signal. */
  readonly lossTerms: number;
  readonly countedMetrics: readonly string[];
  readonly metrics: readonly MetricResult[];
}

export interface SweepOptions {
  /** Weight step per coordinate move. */
  readonly step: number;
  readonly iterations: number;
  /** Fraction of the sample held out from the search. */
  readonly holdoutShare: number;
  /** Required improvement over the incumbent before a change is suggested. */
  readonly minImprovement: number;
  readonly onProgress?: (iteration: number, loss: number) => void;
}

export const DEFAULT_SWEEP_OPTIONS: SweepOptions = {
  step: 0.05,
  iterations: 12,
  holdoutShare: 0.3,
  minImprovement: 0.02,
};

const KEYS: ReadonlyArray<keyof WeightVector> = [
  'f1Historical',
  'f2Market',
  'f3Trend',
  'f4Seasonality',
  'f6Value',
];

export function normalize(weights: WeightVector): WeightVector {
  const clamped = KEYS.map((k) => Math.max(0, weights[k]));
  const total = clamped.reduce((a, b) => a + b, 0);
  if (total === 0) {
    const even = 1 / KEYS.length;
    return Object.fromEntries(KEYS.map((k) => [k, even])) as unknown as WeightVector;
  }
  // Round to 4dp and push the residue onto the largest weight so the vector
  // sums to exactly 1.0 — validateConfig rejects anything else.
  const scaled = clamped.map((v) => Math.round((v / total) * 10_000) / 10_000);
  const drift = Math.round((1 - scaled.reduce((a, b) => a + b, 0)) * 10_000) / 10_000;
  let maxIndex = 0;
  for (let i = 1; i < scaled.length; i += 1) {
    if ((scaled[i] as number) > (scaled[maxIndex] as number)) maxIndex = i;
  }
  scaled[maxIndex] = Math.round(((scaled[maxIndex] as number) + drift) * 10_000) / 10_000;

  return Object.fromEntries(KEYS.map((k, i) => [k, scaled[i]])) as unknown as WeightVector;
}

export function configFor(base: ScoringConfig, weights: WeightVector): ScoringConfig {
  return withConfig({
    ...structuredClone(base),
    score: { weight: weights },
  } as DeepPartial<ScoringConfig>);
}

export interface Loss {
  readonly value: number;
  /** How many metric terms actually contributed. */
  readonly terms: number;
  readonly counted: readonly string[];
}

/**
 * Loss, lower is better. Each term is normalized so no single metric dominates
 * by unit alone, and each is only counted when its metric had enough evidence
 * to judge — an unmeasurable metric must not silently read as a perfect score.
 *
 * `terms` is returned rather than hidden because a loss computed from one
 * surviving term is not comparable to one computed from five, and a sweep that
 * cannot say how much it measured is a sweep that should not be trusted.
 */
export function computeLoss(metrics: readonly MetricResult[], config: ScoringConfig): Loss {
  const by = new Map(metrics.map((m) => [m.key, m]));
  let loss = 0;
  let terms = 0;
  const counted: string[] = [];

  /**
   * A metric counts only if it is PRESENT, has a value, and had enough evidence
   * to judge. The absent case is easy to get wrong: `undefined?.value !== null`
   * is true, so an optional-chained check silently scores metrics that were
   * never computed against whatever fallback the expression supplies.
   */
  const judged = (key: string): number | null => {
    const metric = by.get(key);
    if (metric === undefined) return null;
    if (metric.value === null) return null;
    if (metric.status === 'INSUFFICIENT_SAMPLE') return null;
    return metric.value;
  };

  const add = (key: string, penalty: number, weight = 1): void => {
    loss += weight * Math.min(1, Math.max(0, penalty));
    terms += weight;
    counted.push(key);
  };

  const distribution = judged('score_distribution');
  if (distribution !== null) {
    const drift = Math.abs(distribution - config.calibration.targetScoreMean);
    add('score_distribution', drift / (config.calibration.targetScoreMeanTolerance * 2));
  }

  const correlation = judged('factor_correlation');
  if (correlation !== null) {
    const excess = Math.max(0, Math.abs(correlation) - config.calibration.factorCorrelationMax);
    add('factor_correlation', excess / Math.max(0.01, 1 - config.calibration.factorCorrelationMax));
  }

  const regret = judged('book_now_regret');
  if (regret !== null) {
    // Weighted double: a wrong BOOK_NOW is the failure a customer actually feels.
    const excess = Math.max(0, regret - config.calibration.bookNowRegretRateMax);
    add('book_now_regret', excess / Math.max(0.01, 1 - config.calibration.bookNowRegretRateMax), 2);
  }

  const wait = judged('wait_success');
  if (wait !== null) {
    const shortfall = Math.max(0, config.calibration.waitSuccessRateMin - wait);
    add('wait_success', shortfall / Math.max(0.01, config.calibration.waitSuccessRateMin));
  }

  const cov = judged('coverage');
  if (cov !== null) {
    const excess = Math.max(0, cov - config.calibration.insufficientDataRateMax);
    add('coverage', excess / Math.max(0.01, 1 - config.calibration.insufficientDataRateMax));
  }

  return {
    value: terms === 0 ? Number.POSITIVE_INFINITY : loss / terms,
    terms,
    counted,
  };
}

export interface SweepResult {
  readonly incumbent: Candidate;
  readonly best: Candidate;
  readonly improved: boolean;
  readonly explored: number;
  readonly ranked: readonly Candidate[];
  readonly trainSize: number;
  readonly holdoutSize: number;
  /** Metric terms the holdout could actually judge, out of six possible. */
  readonly evaluableTerms: number;
  readonly reliable: boolean;
  readonly note: string;
}

export function sweep(
  samples: readonly ReplaySample[],
  base: ScoringConfig,
  options: SweepOptions = DEFAULT_SWEEP_OPTIONS,
): SweepResult {
  // Deterministic split by stay, not by trial: putting two replays of the same
  // stay on opposite sides of the split leaks the answer into the holdout.
  const stays = [
    ...new Set(
      samples.map((s) => `${s.target.hotelId}|${s.target.roomTypeId}|${s.target.checkIn}`),
    ),
  ].sort();
  const holdoutCount = Math.max(1, Math.round(stays.length * options.holdoutShare));
  const holdoutStays = new Set(
    stays.filter((_, i) => i % Math.max(2, Math.round(stays.length / holdoutCount)) === 0),
  );

  const train = samples.filter(
    (s) => !holdoutStays.has(`${s.target.hotelId}|${s.target.roomTypeId}|${s.target.checkIn}`),
  );
  const holdout = samples.filter((s) =>
    holdoutStays.has(`${s.target.hotelId}|${s.target.roomTypeId}|${s.target.checkIn}`),
  );

  const score = (weights: WeightVector, on: readonly ReplaySample[]) => {
    const candidateConfig = configFor(base, weights);
    const metrics = allMetrics(evaluate(on, candidateConfig), candidateConfig);
    return { loss: computeLoss(metrics, candidateConfig), metrics };
  };

  const makeCandidate = (weights: WeightVector): Candidate => {
    const trainResult = score(weights, train);
    const holdoutResult = score(weights, holdout.length > 0 ? holdout : train);
    return {
      weights,
      loss: holdoutResult.loss.value,
      trainLoss: trainResult.loss.value,
      lossTerms: holdoutResult.loss.terms,
      countedMetrics: holdoutResult.loss.counted,
      metrics: holdoutResult.metrics,
    };
  };

  const incumbent = makeCandidate(normalize(base.score.weight));
  const explored: Candidate[] = [incumbent];

  let current = incumbent;
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let bestMove = current;

    for (const key of KEYS) {
      for (const direction of [1, -1]) {
        const next = normalize({
          ...current.weights,
          [key]: current.weights[key] + direction * options.step,
        });
        if (KEYS.every((k) => Math.abs(next[k] - current.weights[k]) < 1e-9)) continue;

        const candidate = makeCandidate(next);
        explored.push(candidate);
        if (candidate.trainLoss < bestMove.trainLoss - 1e-9) bestMove = candidate;
      }
    }

    options.onProgress?.(iteration + 1, bestMove.trainLoss);
    if (bestMove === current) break; // local optimum
    current = bestMove;
  }

  // A loss built from one or two surviving terms cannot rank weights: most of
  // the objective simply was not measurable on this holdout.
  const MIN_RELIABLE_TERMS = 4;
  const reliable = incumbent.lossTerms >= MIN_RELIABLE_TERMS;
  const improved = reliable && current.loss < incumbent.loss - options.minImprovement;

  const note = !reliable
    ? `Sweep is NOT conclusive: the ${holdout.length}-trial holdout could only judge ` +
      `${incumbent.lossTerms} of 6 loss terms (${incumbent.countedMetrics.join(', ') || 'none'}). ` +
      `Collect a larger sample before trusting any weight ranking.`
    : improved
      ? `Best candidate beats the incumbent by ${(incumbent.loss - current.loss).toFixed(3)} on held-out stays, judged on ${incumbent.lossTerms} of 6 terms.`
      : `No candidate beat the incumbent by the required ${options.minImprovement} margin on held-out stays. Keep the current weights.`;

  return {
    incumbent,
    best: improved ? current : incumbent,
    improved,
    explored: explored.length,
    ranked: [...explored].sort((a, b) => a.loss - b.loss).slice(0, 8),
    trainSize: train.length,
    holdoutSize: holdout.length,
    evaluableTerms: incumbent.lossTerms,
    reliable,
    note,
  };
}
