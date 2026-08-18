/**
 * The recommendation engine: BOOK NOW / CONSIDER / INSUFFICIENT DATA.
 *
 * A strictly ordered gate sequence — first match wins.
 *
 * ── WAIT was retired in config v4 ────────────────────────────────────────
 *
 * Gate G4 used to emit WAIT, guarded by eight never-WAIT conditions (W1–W8),
 * a boundary assertion, and a database CHECK. All of that existed because WAIT
 * is a prediction — "this rate will get better" — and a wrong prediction costs
 * the customer a room. The defence was sound; the output was not. This system
 * has no reliable rate history to forecast from, and the product deliberately
 * does not forecast, so the honest fix is to remove the claim rather than to
 * keep bounding the confidence at which we are allowed to make it.
 *
 * What the guards protected is now unreachable: no gate can emit WAIT, and the
 * type does not contain it. Demand, scarcity and trend still do real work —
 * they route to BOOK_NOW through gate G3 — but they describe the market now,
 * not the market next week.
 *
 * The absence is deliberate in the gate numbering too: G4 is not reused.
 *
 * See docs/mvp/03-confidence-and-recommendation.md §4.
 */

import type { ScoringConfig } from '../config/defaults.js';
import { WEIGHT_COVERAGE_EPSILON } from '../scoring/dealScore.js';
import { hoursBetween } from '../stats.js';
import type { BaselineDistribution, CurrentRate, RecommendationResult } from '../types.js';

export interface RecommendationInput {
  readonly dealScore: number | null;
  readonly confidence: number;
  readonly current: CurrentRate;
  readonly baseline: BaselineDistribution | null;
  readonly weightCoverage: number;
  readonly matchQuality: number;
  readonly leadTimeDays: number;
  readonly trendPct: number | null;
  readonly demandPressure: number;
  readonly volatilityFactor: number;
  readonly now: Date;
}

function gateZeroReasons(input: RecommendationInput, config: ScoringConfig): readonly string[] {
  const reasons: string[] = [];
  const { baseline, current } = input;

  if (input.dealScore === null) reasons.push('SCORE_UNAVAILABLE');
  if (!baseline) reasons.push('NO_BASELINE');
  else if (baseline.nObservations < config.rec.minObsAbs) {
    reasons.push('INSUFFICIENT_OBSERVATIONS');
  }
  // Same epsilon as composeDealScore — the two gates must agree, or a score is
  // computed and then rejected (or worse, the reverse).
  if (input.weightCoverage < config.score.minWeightCoverage - WEIGHT_COVERAGE_EPSILON) {
    reasons.push('INSUFFICIENT_FACTORS');
  }
  if (input.matchQuality < config.rec.matchMin) reasons.push('WEAK_ROOM_MATCH');

  const ageHours = hoursBetween(new Date(current.observedAt), input.now);
  if (ageHours > config.rec.maxCurrentAgeHours) reasons.push('STALE_RATE');

  if (input.confidence < config.rec.confidenceFloor) reasons.push('LOW_CONFIDENCE');
  if (baseline?.level === 'L4' && input.confidence < config.rec.l4ConfidenceMin) {
    reasons.push('WIDENED_BASELINE_LOW_CONFIDENCE');
  }

  return reasons;
}

export function recommend(input: RecommendationInput, config: ScoringConfig): RecommendationResult {
  // ── G0 · data sufficiency ──────────────────────────────────────────────
  const insufficientReasons = gateZeroReasons(input, config);
  if (insufficientReasons.length > 0) {
    return {
      recommendation: 'INSUFFICIENT_DATA',
      gateFired: 'G0',
      insufficientReasons,
    };
  }

  const score = input.dealScore as number;
  const b = config.rec.book;
  const base = { insufficientReasons: [] as readonly string[] };

  // ── G2 · strong deal ───────────────────────────────────────────────────
  if (score >= b.scoreMin && input.confidence >= b.confidenceMin) {
    return { recommendation: 'BOOK_NOW', gateFired: 'G2', ...base };
  }

  // ── G3 · urgency ───────────────────────────────────────────────────────
  // A decent rate plus a market signal that the room may not still be there.
  // Every condition here is observable now: a trend already measured, demand
  // already priced in, inventory already reported low.
  const rising = input.trendPct !== null && input.trendPct >= b.urgencyRisePct;
  const highDemand = input.demandPressure >= b.urgencyDemand;
  const roomsLeft = input.current.roomsLeft;
  const scarce =
    roomsLeft !== null && roomsLeft !== undefined && roomsLeft <= b.urgencyScarcityRooms;

  if (
    score >= b.urgencyScoreMin &&
    input.confidence >= b.confidenceMin &&
    (rising || highDemand || scarce)
  ) {
    return { recommendation: 'BOOK_NOW', gateFired: 'G3', ...base };
  }

  // ── G5 · default ───────────────────────────────────────────────────────
  // Where WAIT used to live. A rate above typical for this hotel now reads as
  // CONSIDER: a statement about what the rate is, not about what it will do.
  return { recommendation: 'CONSIDER', gateFired: 'G5', ...base };
}
