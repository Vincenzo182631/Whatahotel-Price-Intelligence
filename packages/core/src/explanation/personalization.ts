/**
 * Phase 6 — the personalization layer.
 *
 * Two layers, deliberately separate. The OBJECTIVE layer is everything the
 * engine already computes: score, ADR, premium, availability, reputation.
 * The PERSONALIZED layer — this file — reinterprets those same facts through
 * the guest's stated preference. It reorders emphasis; it never re-scores.
 * A preference change re-frames the answer and cannot move a number, which
 * is enforced structurally: personalization is built FROM the finished
 * bundle, after every number in it is already decided.
 *
 * The honesty constraint that shapes everything here: this system holds no
 * amenity, family, nightlife, quietness or business-facility data — the
 * source's `info` endpoint does not answer. A preference for which the
 * bundle carries no specific evidence gets a plain statement that the
 * information is limited, never a fabricated fit. "Fewer reasons" is always
 * the right answer to thin evidence; padding a fit list is inventing a
 * hotel.
 *
 * Same guard architecture as the assessment: the deterministic path below
 * works with the model disabled, and a model-written personalization passes
 * validatePersonalization (numeric allowlist, no predictions, no citing
 * absent evidence) or is discarded whole in favour of the deterministic one.
 */

import type { LiveExplanationBundle } from './liveBundle.js';
import type { Preference } from './preference.js';
import {
  evidenceConfidence,
  evidencePresent,
  type AssessmentConfidence,
  type AssessmentEvidence,
  ASSESSMENT_EVIDENCE,
} from './assessment.js';
import { validateNarrative } from './validate.js';

export interface Personalization {
  readonly preference: Preference;
  /** 1–3 sentences interpreting the computed facts through the preference. */
  readonly personalized_insight: string;
  /** Up to 3 evidence-based reasons. Fewer when the evidence is thin. */
  readonly why_this_hotel_may_fit: readonly string[];
  /** Up to 3 neutral considerations. Informative, never pressuring. */
  readonly what_to_consider: readonly string[];
  /** Why the alternative suits this preference. Empty when there is none. */
  readonly alternative_reason: string;
  readonly confidence: AssessmentConfidence;
  readonly evidence_used: readonly AssessmentEvidence[];
  /** MODEL passed validation; DETERMINISTIC is the code-written fallback. */
  readonly source: 'MODEL' | 'DETERMINISTIC';
}

/** The preferences for which the bundle can carry NO specific evidence. */
const NO_DATA_ASPECT: Partial<Record<Preference, string>> = {
  AMENITIES: 'amenity',
  FAMILY: 'family-travel',
  NIGHTLIFE: 'nightlife',
  QUIET_RELAXATION: 'quiet-stay',
  BUSINESS_TRAVEL: 'business-travel',
};

const OCEAN_VIEWS = new Set(['OCEAN', 'PARTIAL_OCEAN']);

const limitedInfoSentence = (aspect: string): string =>
  `Limited ${aspect}-specific information is available for this property in our data, so this view reflects the price evidence for the stay.`;

interface FitCandidate {
  readonly text: string;
  /** Preferences this reason speaks to directly; [] = generally relevant. */
  readonly focus: readonly Preference[];
  readonly evidence: readonly AssessmentEvidence[];
}

/**
 * Every fit reason the bundle can actually support, each traceable to a fact
 * it states. The list is filtered by presence, then ordered
 * preference-relevant-first, then capped — never padded.
 */
function fitCandidates(bundle: LiveExplanationBundle): FitCandidate[] {
  const out: FitCandidate[] = [];
  const rep = bundle.reputation.subject;

  if (rep) {
    out.push({
      text:
        rep.review_count !== null
          ? `Rated ${rep.rating} out of 5 by ${rep.review_count.toLocaleString('en-US')} guest reviews.`
          : `Holds a ${rep.rating} out of 5 guest rating.`,
      focus: ['LUXURY_EXPERIENCE', 'FAMILY', 'QUIET_RELAXATION', 'BUSINESS_TRAVEL'],
      evidence:
        rep.review_count !== null ? ['google_rating', 'google_review_count'] : ['google_rating'],
    });
    const compMedian = bundle.reputation.comparable_median_rating;
    if (compMedian !== null && rep.rating > compMedian) {
      out.push({
        text: `Its guest rating is above the comparable median of ${compMedian} out of 5.`,
        focus: ['LUXURY_EXPERIENCE'],
        evidence: ['google_rating', 'comparable_google_ratings'],
      });
    }
  }

  if (
    bundle.premium.included_value_nightly_minor !== null &&
    bundle.premium.included_value_nightly_minor > 0
  ) {
    out.push({
      text: 'The rate carries included value beyond the room itself.',
      focus: ['LUXURY_EXPERIENCE', 'BEST_VALUE'],
      evidence: ['included_value'],
    });
  }

  const comps = bundle.market.comp_set;
  if (comps.available && comps.pct_below_median !== null && comps.pct_below_median > 0) {
    out.push({
      text: `The selected rate is about ${comps.pct_below_median}% below the comparable median.`,
      focus: ['BEST_VALUE'],
      evidence: ['comparable_rates'],
    });
  }

  if (
    bundle.availability.selected_position === 'ENTRY' &&
    bundle.availability.available_categories > 1
  ) {
    out.push({
      text: 'This is the lowest-priced category currently available at this property.',
      focus: ['BEST_VALUE'],
      evidence: ['availability_position'],
    });
  }

  if (bundle.subject.room_view !== null && OCEAN_VIEWS.has(bundle.subject.room_view)) {
    out.push({
      text: 'The selected room is an ocean-view category.',
      focus: ['BEACH_RESORT', 'LUXURY_EXPERIENCE'],
      evidence: ['live_rate'],
    });
  }

  return out;
}

/** Neutral considerations the bundle supports, most preference-relevant first. */
function considerCandidates(bundle: LiveExplanationBundle): FitCandidate[] {
  const out: FitCandidate[] = [];

  if (bundle.premium.premium_pct !== null && bundle.premium.premium_pct > 0) {
    out.push({
      text: `The selected rate is about ${bundle.premium.premium_pct}% above the comparable median.`,
      focus: ['BEST_VALUE'],
      evidence: ['premium_pct', 'comparable_rates'],
    });
  }
  if (bundle.alternative) {
    out.push({
      text: 'A comparable stay is currently available at a lower rate.',
      focus: ['BEST_VALUE'],
      evidence: ['comparable_rates'],
    });
  }
  if (bundle.availability.availability_influenced) {
    out.push({
      text: 'Lower-priced room categories at this property are currently unavailable.',
      focus: [],
      evidence: ['availability_position'],
    });
  }
  if (!bundle.market.comp_set.available || bundle.market.comp_set.comps_used === 0) {
    out.push({
      text: 'Comparable pricing data for this stay is limited.',
      focus: [],
      evidence: ['live_rate'],
    });
  }
  return out;
}

/** Preference-relevant first, stable within each half, capped. */
function pick(
  candidates: readonly FitCandidate[],
  preference: Preference,
  cap: number,
): FitCandidate[] {
  const focused = candidates.filter((c) => c.focus.includes(preference));
  const general = candidates.filter((c) => !c.focus.includes(preference));
  return [...focused, ...general].slice(0, cap);
}

/** The insight sentence(s) the system can stand behind with no model. */
function deterministicInsight(
  bundle: LiveExplanationBundle,
  preference: Preference,
): { text: string; evidence: AssessmentEvidence[] } {
  const rep = bundle.reputation.subject;
  const comps = bundle.market.comp_set;

  switch (preference) {
    case 'BEST_VALUE': {
      if (bundle.alternative) {
        const alt = bundle.alternative;
        return {
          text: `If value is your main priority, ${alt.name} currently offers a comparable stay at ${alt.nightly_display} per night — about ${alt.save_display} less than the selected rate.`,
          evidence: ['comparable_rates', 'live_rate'],
        };
      }
      if (comps.available && comps.comps_used > 0) {
        return {
          text: `Among the ${comps.comps_used} comparable hotels with a live rate, none currently offers a comparable stay at a meaningfully lower price.`,
          evidence: ['comparable_rates', 'live_rate'],
        };
      }
      return {
        text: 'Comparable pricing for this stay is currently limited, so there is not enough evidence to point to a stronger-value option.',
        evidence: ['live_rate'],
      };
    }
    case 'LUXURY_EXPERIENCE': {
      if (rep) {
        const count =
          rep.review_count !== null
            ? ` across ${rep.review_count.toLocaleString('en-US')} reviews`
            : '';
        const included =
          bundle.premium.included_value_nightly_minor !== null &&
          bundle.premium.included_value_nightly_minor > 0
            ? ' The rate also carries included value beyond the room itself.'
            : '';
        return {
          text: `Guests rate this property ${rep.rating} out of 5${count}.${included}`,
          evidence: [
            'google_rating',
            ...(rep.review_count !== null ? (['google_review_count'] as const) : []),
            ...(included ? (['included_value'] as const) : []),
          ],
        };
      }
      return {
        text: 'No verified guest rating is available for this property, so this view reflects the price evidence for the stay.',
        evidence: ['live_rate'],
      };
    }
    case 'BEACH_RESORT': {
      if (bundle.subject.room_view !== null && OCEAN_VIEWS.has(bundle.subject.room_view)) {
        return {
          text: "The selected room is an ocean-view category. Beyond the room's view, limited beach- and resort-specific information is available in our data.",
          evidence: ['live_rate'],
        };
      }
      return { text: limitedInfoSentence('beach- and resort'), evidence: ['live_rate'] };
    }
    case 'LOCATION': {
      if (bundle.subject.city) {
        return {
          text: `This property is in ${bundle.subject.city}. Beyond its destination, limited location-specific detail is available in our data.`,
          evidence: ['live_rate'],
        };
      }
      return { text: limitedInfoSentence('location'), evidence: ['live_rate'] };
    }
    default:
      return {
        text: limitedInfoSentence(NO_DATA_ASPECT[preference] ?? 'preference'),
        evidence: ['live_rate'],
      };
  }
}

function alternativeReasonFor(bundle: LiveExplanationBundle, preference: Preference): string {
  if (!bundle.alternative) return '';
  switch (preference) {
    case 'BEST_VALUE':
      return 'Selected for its lower current rate weighed together with its guest-review standing.';
    case 'LUXURY_EXPERIENCE':
      return 'Selected for its guest-review standing among comparable stays at a lower rate.';
    default:
      return 'A comparable stay is currently available at a lower rate.';
  }
}

/**
 * The personalization the system stands behind with no model at all.
 *
 * Null for GENERAL_VALUE — the default preference produces no
 * personalization block, so the un-personalized response is exactly the
 * Phase 5 response.
 */
export function deterministicPersonalization(
  bundle: LiveExplanationBundle,
): Personalization | null {
  const preference = bundle.preference;
  if (preference === 'GENERAL_VALUE') return null;

  const insight = deterministicInsight(bundle, preference);
  const fit = pick(fitCandidates(bundle), preference, 3);
  const consider = pick(considerCandidates(bundle), preference, 3);

  const evidence = new Set<AssessmentEvidence>(insight.evidence);
  for (const c of [...fit, ...consider]) for (const e of c.evidence) evidence.add(e);
  const present = evidencePresent(bundle);

  const comps = bundle.market.comp_set;
  return {
    preference,
    personalized_insight: insight.text,
    why_this_hotel_may_fit: fit.map((c) => c.text),
    what_to_consider: consider.map((c) => c.text),
    alternative_reason: alternativeReasonFor(bundle, preference),
    confidence: evidenceConfidence(
      comps.comps_used,
      comps.room_match,
      bundle.reputation.subject !== null,
    ),
    evidence_used: [...evidence].filter((e) => present.has(e)),
    source: 'DETERMINISTIC',
  };
}

export interface PersonalizationValidation {
  readonly ok: boolean;
  readonly value: Personalization | null;
  readonly violations: readonly string[];
}

/**
 * The gate a model-written personalization passes before a customer sees it.
 *
 * Same policy as validateAssessment: rejection, never repair — except the
 * two fields that were never the model's to state. `preference` is forced to
 * the one the guest actually selected, and `confidence` is replaced by the
 * code-computed evidenceConfidence.
 */
export function validatePersonalization(
  raw: unknown,
  bundle: LiveExplanationBundle,
): PersonalizationValidation {
  const violations: string[] = [];
  const fail = (): PersonalizationValidation => ({ ok: false, value: null, violations });

  if (bundle.preference === 'GENERAL_VALUE') {
    violations.push('no personalization is produced for GENERAL_VALUE');
    return fail();
  }
  if (raw === null || typeof raw !== 'object') {
    violations.push('personalization missing or not an object');
    return fail();
  }
  const p = raw as Record<string, unknown>;

  const textConstraints = { ...bundle.constraints };
  if (typeof p.personalized_insight !== 'string' || p.personalized_insight.trim().length === 0) {
    violations.push('personalized_insight: empty');
  } else {
    const check = validateNarrative(p.personalized_insight, {
      ...textConstraints,
      max_sentences: 3,
    });
    for (const v of check.violations) violations.push(`personalized_insight: ${v}`);
  }

  const lists: Array<[string, unknown]> = [
    ['why_this_hotel_may_fit', p.why_this_hotel_may_fit],
    ['what_to_consider', p.what_to_consider],
  ];
  for (const [name, value] of lists) {
    if (!Array.isArray(value) || value.length > 3) {
      violations.push(`${name}: not a list of at most 3`);
      continue;
    }
    for (const item of value) {
      if (typeof item !== 'string' || item.trim().length === 0 || item.length > 160) {
        violations.push(`${name}: bad item`);
        continue;
      }
      const check = validateNarrative(item, { ...textConstraints, max_sentences: 1 });
      for (const v of check.violations) violations.push(`${name}: ${v}`);
    }
  }

  if (typeof p.alternative_reason === 'string' && p.alternative_reason.trim().length > 0) {
    if (bundle.alternative === null) {
      violations.push('alternative_reason: no alternative was chosen');
    } else {
      const check = validateNarrative(p.alternative_reason, {
        ...textConstraints,
        max_sentences: 2,
      });
      for (const v of check.violations) violations.push(`alternative_reason: ${v}`);
    }
  }

  const present = evidencePresent(bundle);
  if (!Array.isArray(p.evidence_used)) {
    violations.push('evidence_used: not a list');
  } else {
    for (const key of p.evidence_used) {
      if (typeof key !== 'string' || !(ASSESSMENT_EVIDENCE as readonly string[]).includes(key)) {
        violations.push(`evidence_used: unknown key ${String(key)}`);
      } else if (!present.has(key as AssessmentEvidence)) {
        violations.push(`evidence_used: cites absent evidence ${key}`);
      }
    }
  }

  if (violations.length > 0) return fail();

  const comps = bundle.market.comp_set;
  return {
    ok: true,
    violations: [],
    value: {
      preference: bundle.preference,
      personalized_insight: (p.personalized_insight as string).trim(),
      why_this_hotel_may_fit: (p.why_this_hotel_may_fit as string[]).map((s) => s.trim()),
      what_to_consider: (p.what_to_consider as string[]).map((s) => s.trim()),
      alternative_reason:
        typeof p.alternative_reason === 'string' ? p.alternative_reason.trim() : '',
      confidence: evidenceConfidence(
        comps.comps_used,
        comps.room_match,
        bundle.reputation.subject !== null,
      ),
      evidence_used: p.evidence_used as AssessmentEvidence[],
      source: 'MODEL',
    },
  };
}
