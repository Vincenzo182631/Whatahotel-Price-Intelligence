/**
 * The Premium Justification ASSESSMENT — a reasoned verdict on whether a
 * price premium is supported by the evidence we hold.
 *
 * This sits ON TOP of the deterministic premium justification
 * (computePremiumJustification), it does not replace it. The deterministic
 * layer answers with money against money — the only fully commensurable
 * evidence — and its result is published unchanged. This layer lets a model
 * WEIGH the wider evidence (the price gap, what the rate includes, and the
 * guest reputation Phase 3 verified) into one verdict a customer can read.
 *
 * The honesty rules survive intact, enforced mechanically:
 *
 *   - The Deal Score never moves. Reputation stays out of every number.
 *   - The model computes nothing: every numeral in its text is checked
 *     against the bundle's allowlist, every claim of evidence is checked
 *     against whether the bundle actually carries that evidence, and its
 *     confidence is OVERRIDDEN by the one computed here — a model cannot be
 *     trusted to grade its own certainty.
 *   - An invalid verdict is discarded whole and the deterministic mapping
 *     ships instead. The widget never waits and never breaks.
 *
 * Why this exists (Phase 4 §5): a luxury hotel must not score badly merely
 * for being expensive — and must not be excused merely for being famous.
 * No brand knows anything here. "Expensive with strong differentiation" and
 * "expensive with little differentiation" are separated only by the evidence
 * in the bundle: included value, verified guest reputation, room match.
 */

import type { LiveExplanationBundle } from './liveBundle.js';
import { validateNarrative } from './validate.js';

export type AssessmentLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';
export type AssessmentConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * The only evidence the assessment may cite, each key backed by a presence
 * test against the bundle. Citing evidence the bundle does not carry is the
 * text form of inventing data, and it rejects the whole draft.
 */
export const ASSESSMENT_EVIDENCE = [
  'live_rate',
  'comparable_rates',
  'premium_pct',
  'included_value',
  'google_rating',
  'google_review_count',
  'comparable_google_ratings',
  'room_match',
  'calendar_position',
  'market_availability',
] as const;
export type AssessmentEvidence = (typeof ASSESSMENT_EVIDENCE)[number];

export interface PremiumAssessment {
  readonly level: AssessmentLevel;
  readonly reasoning: string;
  readonly key_positive_factors: readonly string[];
  readonly key_negative_factors: readonly string[];
  readonly confidence: AssessmentConfidence;
  readonly recommendation: string;
  readonly evidence_used: readonly AssessmentEvidence[];
  /** MODEL passed validation; DETERMINISTIC is the mapped fallback. */
  readonly source: 'MODEL' | 'DETERMINISTIC';
}

const CONF_RANK: Record<AssessmentConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const minConf = (a: AssessmentConfidence, b: AssessmentConfidence): AssessmentConfidence =>
  CONF_RANK[a] <= CONF_RANK[b] ? a : b;

/**
 * How sure the evidence lets ANYONE be — model or template alike.
 *
 * Computed from primitives rather than judged by the model, because grading
 * certainty is exactly where a fluent model overclaims. The ladder follows
 * Phase 4 §12: six strong comparables can reach HIGH, three reach MEDIUM,
 * fewer is LOW; a comparison against non-equivalent rooms is capped, and a
 * hotel with no verified reputation caps at MEDIUM because a whole class of
 * supporting evidence is missing.
 */
export function evidenceConfidence(
  compsUsed: number,
  roomMatch: string | null,
  hasReputation: boolean,
): AssessmentConfidence {
  const byComps: AssessmentConfidence = compsUsed >= 6 ? 'HIGH' : compsUsed >= 3 ? 'MEDIUM' : 'LOW';
  const byRoom: AssessmentConfidence =
    roomMatch === 'CLASS_AND_VIEW' ? 'HIGH' : roomMatch === 'CLASS' ? 'MEDIUM' : 'LOW';
  const byReputation: AssessmentConfidence = hasReputation ? 'HIGH' : 'MEDIUM';
  return minConf(byComps, minConf(byRoom, byReputation));
}

/** Which evidence the bundle actually carries, key by key. */
export function evidencePresent(bundle: LiveExplanationBundle): Set<AssessmentEvidence> {
  const present = new Set<AssessmentEvidence>(['live_rate']);
  const comps = bundle.market.comp_set;
  if (comps.available && comps.comps_used > 0) present.add('comparable_rates');
  if (bundle.premium.premium_pct !== null) present.add('premium_pct');
  if (
    bundle.premium.included_value_nightly_minor !== null ||
    bundle.premium.comparable_included_value_nightly_minor !== null
  )
    present.add('included_value');
  if (bundle.reputation.subject) {
    present.add('google_rating');
    if (bundle.reputation.subject.review_count !== null) present.add('google_review_count');
  }
  if (bundle.reputation.comparable_median_rating !== null) present.add('comparable_google_ratings');
  if (comps.room_match !== null) present.add('room_match');
  if (bundle.market.calendar.available) present.add('calendar_position');
  if (bundle.market.compression.available) present.add('market_availability');
  return present;
}

const DETERMINISTIC_LEVEL: Record<string, AssessmentLevel | null> = {
  HIGH: 'HIGH',
  MODERATE: 'MEDIUM',
  LOW: 'LOW',
  LIMITED_DATA: 'INSUFFICIENT_DATA',
  NOT_PREMIUM: null,
};

/** Plain language for each deterministic level, shared with the API summary. */
export function premiumJustificationSummary(level: string): string {
  switch (level) {
    case 'HIGH':
      return 'Premium pricing appears justified. This room costs more than comparable hotels, and most of that difference is covered by what the rate includes.';
    case 'MODERATE':
      return 'Premium pricing appears partly justified. This room costs more than comparable hotels, and some of that difference is covered by what the rate includes.';
    case 'LOW':
      return 'Premium pricing may not be justified. This room costs more than comparable hotels without a matching advantage in what the rate includes.';
    case 'NOT_PREMIUM':
      return 'This room is not priced above comparable hotels, so there is no premium to justify.';
    default:
      return 'Limited data. This room is priced above the competitive set, but there is not enough comparable information to judge whether the premium is justified.';
  }
}

/**
 * The assessment the system stands behind with no model at all.
 *
 * Null when there is no premium to justify. The factor lists stay empty on
 * purpose: this path fabricates nothing, and an empty list is honest where a
 * generated one would be decoration.
 */
export function deterministicAssessment(bundle: LiveExplanationBundle): PremiumAssessment | null {
  // NOT_PREMIUM maps to null ON PURPOSE — there is no premium to justify —
  // and `??` would swallow that into INSUFFICIENT_DATA, so the key's
  // presence is checked explicitly rather than coalesced.
  const level =
    bundle.premium.level in DETERMINISTIC_LEVEL
      ? DETERMINISTIC_LEVEL[bundle.premium.level]
      : 'INSUFFICIENT_DATA';
  if (level === null || level === undefined) return null;
  const comps = bundle.market.comp_set;
  return {
    level,
    reasoning: premiumJustificationSummary(bundle.premium.level),
    key_positive_factors: [],
    key_negative_factors: [],
    confidence: evidenceConfidence(
      comps.comps_used,
      comps.room_match,
      bundle.reputation.subject !== null,
    ),
    recommendation: bundle.verdict.verdict_label,
    evidence_used: [...evidencePresent(bundle)].filter(
      (k) => k !== 'calendar_position' && k !== 'market_availability',
    ),
    source: 'DETERMINISTIC',
  };
}

export interface AssessmentValidation {
  readonly ok: boolean;
  readonly value: PremiumAssessment | null;
  readonly violations: readonly string[];
}

const LEVELS: readonly string[] = ['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_DATA'];

/**
 * The gate a model-written assessment passes before a customer sees it.
 *
 * Rejection, never repair — with ONE deliberate exception: `confidence` is
 * not the model's to state, so rather than reject a draft for mis-grading
 * itself, the code's own evidenceConfidence replaces it unconditionally.
 * That is an override of a field we never trusted, not a repair of one we
 * did.
 */
export function validateAssessment(
  raw: unknown,
  bundle: LiveExplanationBundle,
): AssessmentValidation {
  const violations: string[] = [];
  const fail = (): AssessmentValidation => ({ ok: false, value: null, violations });

  if (raw === null || typeof raw !== 'object') {
    violations.push('assessment missing or not an object');
    return fail();
  }
  const a = raw as Record<string, unknown>;

  if (typeof a.level !== 'string' || !LEVELS.includes(a.level)) {
    violations.push(`level: ${String(a.level)}`);
  }

  const textConstraints = { ...bundle.constraints, max_sentences: 4 };
  const texts: Array<[string, unknown, number]> = [
    ['reasoning', a.reasoning, 4],
    ['recommendation', a.recommendation, 2],
  ];
  for (const [name, value, maxSentences] of texts) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      violations.push(`${name}: empty`);
      continue;
    }
    const check = validateNarrative(value, { ...textConstraints, max_sentences: maxSentences });
    for (const v of check.violations) violations.push(`${name}: ${v}`);
  }

  const factors: Array<[string, unknown]> = [
    ['key_positive_factors', a.key_positive_factors],
    ['key_negative_factors', a.key_negative_factors],
  ];
  for (const [name, value] of factors) {
    if (!Array.isArray(value) || value.length > 5) {
      violations.push(`${name}: not a list of at most 5`);
      continue;
    }
    for (const item of value) {
      if (typeof item !== 'string' || item.length === 0 || item.length > 160) {
        violations.push(`${name}: bad item`);
        continue;
      }
      const check = validateNarrative(item, { ...textConstraints, max_sentences: 1 });
      for (const v of check.violations) violations.push(`${name}: ${v}`);
    }
  }

  // Cited evidence must exist. "google_rating" on a hotel with no verified
  // rating is an invented fact wearing a citation.
  const present = evidencePresent(bundle);
  if (!Array.isArray(a.evidence_used)) {
    violations.push('evidence_used: not a list');
  } else {
    for (const key of a.evidence_used) {
      if (typeof key !== 'string' || !(ASSESSMENT_EVIDENCE as readonly string[]).includes(key)) {
        violations.push(`evidence_used: unknown key ${String(key)}`);
      } else if (!present.has(key as AssessmentEvidence)) {
        violations.push(`evidence_used: cites absent evidence ${key}`);
      }
    }
    if (a.level !== 'INSUFFICIENT_DATA' && a.evidence_used.length === 0) {
      violations.push('a verdict with no evidence cited');
    }
  }

  // A HIGH verdict needs supporting evidence beyond the price itself:
  // reputation or known inclusions. Without either, "justified" would rest
  // on nothing the system can point to.
  if (a.level === 'HIGH' && !present.has('google_rating') && !present.has('included_value')) {
    violations.push('HIGH without reputation or included-value evidence');
  }

  if (violations.length > 0) return fail();

  const comps = bundle.market.comp_set;
  return {
    ok: true,
    violations: [],
    value: {
      level: a.level as AssessmentLevel,
      reasoning: (a.reasoning as string).trim(),
      key_positive_factors: (a.key_positive_factors as string[]).map((s) => s.trim()),
      key_negative_factors: (a.key_negative_factors as string[]).map((s) => s.trim()),
      confidence: evidenceConfidence(
        comps.comps_used,
        comps.room_match,
        bundle.reputation.subject !== null,
      ),
      recommendation: (a.recommendation as string).trim(),
      evidence_used: a.evidence_used as AssessmentEvidence[],
      source: 'MODEL',
    },
  };
}
