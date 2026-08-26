/**
 * Phase 6.X — "WHY YOU MIGHT CHOOSE THIS HOTEL".
 *
 * Price Intelligence answers "how does this price compare?". This section
 * answers the other half of the decision: "why might this hotel still be
 * worth choosing?" — from evidence, never from brand aura. The evidence
 * base is exactly the bundle's `hotel_facts` and reputation: the verified
 * guest rating, the perks the source itself states, Google's own editorial
 * sentence, and themes measured over the review sample. A famous name with
 * none of those gets nothing to say here, which is the Four Seasons rule
 * working: fame is not evidence.
 *
 * Same guard architecture as the assessment and the personalization:
 *
 *   - The SUPPORTING SIGNALS (the chips) are computed here, from facts,
 *     and a model may only ever cite them verbatim — a chip the code did
 *     not build is an invented amenity and rejects the draft whole.
 *   - Model prose passes the numeric allowlist, the predictive gate, a
 *     sales-language gate (this is a decision aid, not an advertisement)
 *     and a historical-pricing gate (we hold no price history and must
 *     not imply one).
 *   - Confidence is computed by code from evidence richness.
 *   - The deterministic path works with no model, and too little evidence
 *     means null — the section hides rather than stretches.
 */

import type { LiveExplanationBundle } from './liveBundle.js';
import { validateNarrative } from './validate.js';
import type { AssessmentConfidence } from './assessment.js';
import { THEME_PROSE } from './themes.js';

/** At most this many chips are DISPLAYED; the citable list is wider. */
export const MAX_DISPLAY_SIGNALS = 4;

export const HOTEL_VALUE_EVIDENCE = [
  'google_rating',
  'google_review_themes',
  'google_editorial_summary',
  'hotel_perks',
  'hotel_location',
  'room_category',
  'availability',
] as const;
export type HotelValueEvidence = (typeof HOTEL_VALUE_EVIDENCE)[number];

export interface HotelValue {
  /** A short phrase, not a paragraph. The section TITLE is fixed by the UI. */
  readonly headline: string;
  /** 1–3 sentences, ~40–80 words. The decision-oriented reading. */
  readonly summary: string;
  /** Verbatim members of supportingSignals(bundle). Never model-invented. */
  readonly supporting_facts: readonly string[];
  readonly confidence: AssessmentConfidence;
  readonly evidence_used: readonly HotelValueEvidence[];
  readonly source: 'MODEL' | 'DETERMINISTIC';
}

// THEME_PROSE moved to themes.ts (the premium assessment reads it too, and
// hotelValue <- assessment would otherwise be a cycle). Re-exported so every
// existing importer of it from this module keeps working.
export { THEME_PROSE } from './themes.js';

/**
 * The verified signal chips — built into the bundle itself (liveBundle.ts)
 * so the model, this validator and the renderer share one vocabulary. The
 * model cites these strings verbatim or its draft is rejected; it cannot
 * invent a badge, and it cannot be failed for a string it was never shown.
 */
export function supportingSignals(bundle: LiveExplanationBundle): string[] {
  return [...bundle.hotel_facts.supporting_signals];
}

/** Which evidence the bundle actually carries for this section. */
export function hotelValueEvidencePresent(bundle: LiveExplanationBundle): Set<HotelValueEvidence> {
  const present = new Set<HotelValueEvidence>();
  if (bundle.reputation.subject) present.add('google_rating');
  if (bundle.hotel_facts.review_themes.length > 0) present.add('google_review_themes');
  if (bundle.hotel_facts.editorial_summary) present.add('google_editorial_summary');
  if (bundle.hotel_facts.perks.length > 0) present.add('hotel_perks');
  if (bundle.subject.city) present.add('hotel_location');
  if (bundle.subject.room_class) present.add('room_category');
  if (bundle.availability.available_categories > 0) present.add('availability');
  return present;
}

/**
 * Coded, never model-graded. HIGH needs the rating plus what guests say or
 * what the rate includes; a single strand of evidence is MEDIUM; anything
 * thinner is LOW (and usually hidden by the null gate below).
 */
export function hotelValueConfidence(bundle: LiveExplanationBundle): AssessmentConfidence {
  const rep = bundle.reputation.subject !== null;
  const themes = bundle.hotel_facts.review_themes.length >= 2;
  const perks = bundle.hotel_facts.perks.length >= 2;
  if (rep && (themes || perks)) return 'HIGH';
  if (rep || themes || perks) return 'MEDIUM';
  return 'LOW';
}

const listOut = (items: readonly string[]): string =>
  items.length === 1
    ? (items[0] as string)
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;

/**
 * The reading the system stands behind with no model.
 *
 * Null when the evidence is too thin to say anything a guest could use —
 * the section then hides (§22). Sentences are built only from facts the
 * bundle states, in the consultative register: "may", "recent reviewers
 * mention", never an imperative.
 */
export function deterministicHotelValue(bundle: LiveExplanationBundle): HotelValue | null {
  const rep = bundle.reputation.subject;
  const { perks, review_themes: themes } = bundle.hotel_facts;
  if (!rep && perks.length === 0 && themes.length === 0) return null;

  const evidence = new Set<HotelValueEvidence>();
  const sentences: string[] = [];

  const themeProse = themes.map((t) => THEME_PROSE[t]).filter((t): t is string => !!t);
  if (rep && themeProse.length > 0) {
    sentences.push(
      `Guests rate this property ${rep.rating} out of 5, and recent reviewers mention ${listOut(themeProse.slice(0, 3))}.`,
    );
    evidence.add('google_rating');
    evidence.add('google_review_themes');
  } else if (rep) {
    sentences.push(
      `Guests rate this property ${rep.rating} out of 5${rep.review_count !== null ? ` across ${rep.review_count.toLocaleString('en-US')} reviews` : ''}.`,
    );
    evidence.add('google_rating');
  } else if (themeProse.length > 0) {
    sentences.push(`Recent reviewers mention ${listOut(themeProse.slice(0, 3))}.`);
    evidence.add('google_review_themes');
  }

  if (perks.length > 0) {
    const named = perks.slice(0, 3).map((p) => p.toLowerCase());
    sentences.push(
      bundle.preference === 'BEST_VALUE'
        ? `The rate itself carries ${listOut(named)}, which counts toward what you receive for the price.`
        : `Booking here also carries ${listOut(named)}.`,
    );
    evidence.add('hotel_perks');
  }

  // The suite rule (§17): a room the guest chose from a menu with cheaper
  // categories is a choice, and the reading should say so instead of
  // treating the price as the property's fault.
  const avail = bundle.availability;
  if (avail.selected_position === 'TOP' && avail.cheaper_categories_available > 0) {
    sentences.push(
      "You're viewing one of the property's higher room categories, so the rate reflects the room selection as well as the property itself.",
    );
    evidence.add('room_category');
    evidence.add('availability');
  } else if (avail.availability_influenced) {
    // The availability rule (§18) — "currently", never "sold out".
    sentences.push(
      'Current availability is concentrated in higher room categories, which helps explain part of the current rate.',
    );
    evidence.add('availability');
  }

  const headline = rep
    ? themeProse.length > 0
      ? 'Highly regarded by recent guests'
      : 'A well-rated property'
    : 'What this stay includes';

  return {
    headline,
    summary: sentences.slice(0, 3).join(' '),
    supporting_facts: supportingSignals(bundle).slice(0, MAX_DISPLAY_SIGNALS),
    confidence: hotelValueConfidence(bundle),
    evidence_used: [...evidence],
    source: 'DETERMINISTIC',
  };
}

/** This is a decision aid, not an advertisement. */
const SALES_LANGUAGE =
  /\b(book now|perfect hotel|won'?t regret|best hotel in|guaranteed|unforgettable|once[- ]in[- ]a[- ]lifetime|must[- ]stay|dream (?:hotel|stay))\b/i;

/** We hold no price history, and prose must not imply one (§19). */
const HISTORICAL_PRICING =
  /\b(usually costs?|normally costs?|typically costs?|used to cost|historical(?:ly)?|price trend|average price|past price|previous price|discount(?:ed)? from)\b/i;

const SOLD_OUT = /\bsold[- ]out\b/i;

export interface HotelValueValidation {
  readonly ok: boolean;
  readonly value: HotelValue | null;
  readonly violations: readonly string[];
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export function validateHotelValue(
  raw: unknown,
  bundle: LiveExplanationBundle,
): HotelValueValidation {
  const violations: string[] = [];
  const fail = (): HotelValueValidation => ({ ok: false, value: null, violations });

  if (raw === null || typeof raw !== 'object') {
    violations.push('hotel_value missing or not an object');
    return fail();
  }
  const v = raw as Record<string, unknown>;

  if (typeof v.headline !== 'string' || v.headline.trim().length === 0) {
    violations.push('headline: empty');
  } else if (v.headline.length > 80) {
    violations.push('headline: too long');
  }

  if (typeof v.summary !== 'string' || v.summary.trim().length === 0) {
    violations.push('summary: empty');
  } else {
    if (wordCount(v.summary) > 90) violations.push('summary: over the word budget');
    const check = validateNarrative(v.summary, { ...bundle.constraints, max_sentences: 3 });
    for (const violation of check.violations) violations.push(`summary: ${violation}`);
  }

  for (const [name, text] of [
    ['headline', v.headline],
    ['summary', v.summary],
  ] as const) {
    if (typeof text !== 'string') continue;
    if (SALES_LANGUAGE.test(text)) violations.push(`${name}: sales language`);
    if (HISTORICAL_PRICING.test(text)) violations.push(`${name}: implies price history`);
    if (SOLD_OUT.test(text)) violations.push(`${name}: claims sold out`);
  }
  if (typeof v.headline === 'string') {
    const check = validateNarrative(v.headline, { ...bundle.constraints, max_sentences: 1 });
    for (const violation of check.violations) violations.push(`headline: ${violation}`);
  }

  // A supporting fact the code did not build is an invented amenity.
  const allowedSignals = new Set(supportingSignals(bundle));
  if (!Array.isArray(v.supporting_facts)) {
    violations.push('supporting_facts: not a list');
  } else {
    for (const fact of v.supporting_facts) {
      if (typeof fact !== 'string' || !allowedSignals.has(fact)) {
        violations.push(`supporting_facts: not a verified signal: ${String(fact)}`);
      }
    }
  }

  const present = hotelValueEvidencePresent(bundle);
  if (!Array.isArray(v.evidence_used)) {
    violations.push('evidence_used: not a list');
  } else {
    for (const key of v.evidence_used) {
      if (typeof key !== 'string' || !(HOTEL_VALUE_EVIDENCE as readonly string[]).includes(key)) {
        violations.push(`evidence_used: unknown key ${String(key)}`);
      } else if (!present.has(key as HotelValueEvidence)) {
        violations.push(`evidence_used: cites absent evidence ${key}`);
      }
    }
  }

  if (violations.length > 0) return fail();

  return {
    ok: true,
    violations: [],
    value: {
      headline: (v.headline as string).trim(),
      summary: (v.summary as string).trim(),
      supporting_facts: v.supporting_facts as string[],
      confidence: hotelValueConfidence(bundle),
      evidence_used: v.evidence_used as HotelValueEvidence[],
      source: 'MODEL',
    },
  };
}
