/**
 * Deal Score composition — weighted mean over the AVAILABLE factors, with
 * proportional weight redistribution. See docs/mvp/02-deal-score.md §2.
 */

import type { ScoringConfig } from '../config/defaults.js';
import { toScore } from '../stats.js';
import type { DealScoreResult, FactorResult, ScoreBand } from '../types.js';

/**
 * Weight coverage is a sum of floating-point weights, so a factor set that
 * exactly meets the minimum can land just under it: 0.30 + 0.15 + 0.10 is
 * 0.5499999999999999, not 0.55. Without this tolerance a hotel with precisely
 * the minimum coverage is rejected as INSUFFICIENT_DATA — which is what
 * happened to two hotels the first time real data ran through the API.
 */
export const WEIGHT_COVERAGE_EPSILON = 1e-9;

export function bandForScore(score: number, config: ScoringConfig): ScoreBand {
  const b = config.score.band;
  if (score >= b.excellentMin) return 'EXCELLENT';
  if (score >= b.goodMin) return 'GOOD';
  if (score >= b.fairMin) return 'FAIR';
  if (score >= b.belowAverageMin) return 'BELOW_AVERAGE';
  return 'POOR';
}

/**
 * Compose the factors into a Deal Score.
 *
 * Returns `score: null` when the model could not run meaningfully — F1 absent,
 * or too little of the total weight available. A null score is the honest
 * output; a zero would render to the customer as "terrible deal".
 */
export function composeDealScore(
  factors: readonly FactorResult[],
  config: ScoringConfig,
): DealScoreResult {
  const available = factors.filter((f) => f.available && f.subScore !== null);
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  const availableWeight = available.reduce((sum, f) => sum + f.weight, 0);
  const weightCoverage = totalWeight === 0 ? 0 : availableWeight / totalWeight;

  const f1 = factors.find((f) => f.code === 'F1');
  const f1Available = f1?.available === true;

  const withApplied: FactorResult[] = factors.map((f) => ({
    ...f,
    weightApplied:
      f.available && f.subScore !== null && availableWeight > 0 ? f.weight / availableWeight : 0,
  }));

  if (
    !f1Available ||
    availableWeight === 0 ||
    weightCoverage < config.score.minWeightCoverage - WEIGHT_COVERAGE_EPSILON
  ) {
    return { score: null, band: null, factors: withApplied, weightCoverage };
  }

  let weighted = 0;
  for (const f of withApplied) {
    if (f.available && f.subScore !== null) weighted += f.weightApplied * f.subScore;
  }

  const score = toScore(weighted);
  return { score, band: bandForScore(score, config), factors: withApplied, weightCoverage };
}
