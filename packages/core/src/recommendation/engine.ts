/**
 * The BOOK NOW / WAIT engine.
 *
 * A strictly ordered gate sequence — first match wins. The ordering is the
 * mechanism that makes the safety rules unconditional: the never-WAIT guards
 * are evaluated before any path that could emit WAIT, so no combination of
 * inputs can route around them.
 *
 * See docs/mvp/03-confidence-and-recommendation.md §4.
 */

import type { ScoringConfig } from '../config/defaults.js';
import { hoursBetween } from '../stats.js';
import type {
  BaselineDistribution,
  CurrentRate,
  GuardCode,
  GuardResult,
  RecommendationResult,
} from '../types.js';

export class WaitConfidenceViolation extends Error {
  constructor(confidence: number, threshold: number) {
    super(
      `Engine produced WAIT at confidence ${confidence}, below the required ${threshold}. ` +
        `This is a safety invariant (docs/mvp/03 §4, guard W1) and must never occur.`,
    );
    this.name = 'WaitConfidenceViolation';
  }
}

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

/**
 * Gate G1 — the never-WAIT guards.
 *
 * These do not produce an output. They remove WAIT from the set of possible
 * outputs before any recommendation is chosen.
 */
export function evaluateGuards(
  input: RecommendationInput,
  config: ScoringConfig,
): readonly GuardResult[] {
  const w = config.rec.wait;
  const { current, baseline } = input;

  const roomsLeft = current.roomsLeft;
  const hasScarcitySignal = roomsLeft !== null && roomsLeft !== undefined;

  return [
    {
      code: 'W1',
      tripped: input.confidence < w.confidenceMin,
      detail: `confidence ${input.confidence} < ${w.confidenceMin}`,
    },
    {
      code: 'W2',
      tripped: input.leadTimeDays < w.minLeadDays,
      detail: `lead time ${input.leadTimeDays}d < ${w.minLeadDays}d`,
    },
    {
      code: 'W3',
      tripped: input.trendPct !== null && input.trendPct >= w.riseBlockPct,
      detail: `7-day trend ${input.trendPct?.toFixed(1) ?? 'n/a'}% >= ${w.riseBlockPct}%`,
    },
    {
      code: 'W4',
      tripped: input.demandPressure >= w.demandBlock,
      detail: `demand pressure ${input.demandPressure.toFixed(2)} >= ${w.demandBlock}`,
    },
    {
      code: 'W5',
      tripped: hasScarcitySignal && (roomsLeft as number) <= w.scarcityBlock,
      detail: `rooms left ${roomsLeft ?? 'n/a'} <= ${w.scarcityBlock}`,
    },
    {
      code: 'W6',
      tripped: input.volatilityFactor < w.minVolatilityConfidence,
      detail: `volatility factor ${input.volatilityFactor.toFixed(2)} < ${w.minVolatilityConfidence}`,
    },
    {
      code: 'W7',
      tripped: current.onlyNonRefundableAvailable === true,
      detail: 'only non-refundable inventory available',
    },
    {
      code: 'W8',
      tripped: baseline !== null && (baseline.level === 'L3' || baseline.level === 'L4'),
      detail: `baseline widened to ${baseline?.level ?? 'none'}`,
    },
  ];
}

function gateZeroReasons(input: RecommendationInput, config: ScoringConfig): readonly string[] {
  const reasons: string[] = [];
  const { baseline, current } = input;

  if (input.dealScore === null) reasons.push('SCORE_UNAVAILABLE');
  if (!baseline) reasons.push('NO_BASELINE');
  else if (baseline.nObservations < config.rec.minObsAbs) {
    reasons.push('INSUFFICIENT_OBSERVATIONS');
  }
  if (input.weightCoverage < config.score.minWeightCoverage) reasons.push('INSUFFICIENT_FACTORS');
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
  const guards = evaluateGuards(input, config);
  const waitBlockedBy: GuardCode[] = guards.filter((g) => g.tripped).map((g) => g.code);

  // ── G0 · data sufficiency ──────────────────────────────────────────────
  const insufficientReasons = gateZeroReasons(input, config);
  if (insufficientReasons.length > 0) {
    return {
      recommendation: 'INSUFFICIENT_DATA',
      gateFired: 'G0',
      waitBlockedBy,
      guards,
      insufficientReasons,
    };
  }

  const score = input.dealScore as number;
  const waitBlocked = waitBlockedBy.length > 0;
  const b = config.rec.book;
  const w = config.rec.wait;

  const base = { waitBlockedBy, guards, insufficientReasons: [] as readonly string[] };

  // ── G2 · strong deal ───────────────────────────────────────────────────
  // The confidence bar here (60) is deliberately below WAIT's (70). Booking a
  // demonstrably below-average rate has bounded downside; waiting does not.
  if (score >= b.scoreMin && input.confidence >= b.confidenceMin) {
    return { recommendation: 'BOOK_NOW', gateFired: 'G2', ...base };
  }

  // ── G3 · urgency ───────────────────────────────────────────────────────
  const rising = input.trendPct !== null && input.trendPct >= b.urgencyRisePct;
  const highDemand = input.demandPressure >= b.urgencyDemand;
  const scarce =
    input.current.roomsLeft !== null &&
    input.current.roomsLeft !== undefined &&
    input.current.roomsLeft <= w.scarcityBlock;

  if (
    score >= b.urgencyScoreMin &&
    input.confidence >= b.confidenceMin &&
    (rising || highDemand || scarce)
  ) {
    return { recommendation: 'BOOK_NOW', gateFired: 'G3', ...base };
  }

  // ── G4 · poor deal, safe to wait ───────────────────────────────────────
  // The confidence and lead-time conditions restate W1 and W2 on purpose:
  // belt-and-braces on the only genuinely risky output.
  if (
    !waitBlocked &&
    score <= w.scoreMax &&
    input.confidence >= w.confidenceMin &&
    (input.trendPct === null || input.trendPct <= w.maxTrendPct) &&
    input.leadTimeDays >= w.minLeadDays
  ) {
    if (input.confidence < w.confidenceMin) {
      throw new WaitConfidenceViolation(input.confidence, w.confidenceMin);
    }
    return { recommendation: 'WAIT', gateFired: 'G4', ...base };
  }

  // ── G5 · default ───────────────────────────────────────────────────────
  return { recommendation: 'CONSIDER', gateFired: 'G5', ...base };
}

/**
 * Boundary assertion — the second of three enforcement layers for the
 * never-WAIT rule (gate, this assertion, and a database CHECK constraint).
 *
 * Defence in depth is warranted because this is the rule with the clearest
 * path to customer harm.
 */
export function assertWaitInvariant(
  result: RecommendationResult,
  confidence: number,
  config: ScoringConfig,
): void {
  if (result.recommendation === 'WAIT' && confidence < config.rec.wait.confidenceMin) {
    throw new WaitConfidenceViolation(confidence, config.rec.wait.confidenceMin);
  }
}
