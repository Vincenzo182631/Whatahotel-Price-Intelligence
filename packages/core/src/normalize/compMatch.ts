/**
 * The cross-hotel comparison key.
 *
 * ── Why this exists separately from `classifyComparability` ────────────────
 *
 * `classifyComparability` builds the semantic class used for baselines, and it
 * poisons: any dimension it cannot resolve makes the whole class UNRESOLVED,
 * and unresolved rates are excluded from every baseline (doc 01 §4). That is
 * right for a baseline, which asks "what is normal for THIS room at THIS
 * hotel" — a rate we cannot classify has no business setting that norm.
 *
 * The Comp-Set Index asks a different question: is this rate good compared to
 * OTHER hotels, right now. It needs a key that matches across hotels, and the
 * production key could never do that. Measured on 11,598 live rates across 13
 * hotels (2026-08-18):
 *
 *   CURRENT  `WAH:code|offer`        37 keys · 0.2 comps/subject ·   0/1252
 *   STORED   strict meal|refund|aud   1 key  · 0.0 comps/subject ·   0/2
 *   ENRICHED + offer-text tokens      1 key  · 0.6 comps/subject ·   0/65
 *   TOLERANT UNKNOWN matches UNKNOWN  5 keys · 3.7 comps/subject · 502/833
 *
 * The source states cancellation terms for 15% of offers and breakfast for
 * 10%, never both. 93% of rate plans carry `refund_policy = UNKNOWN`. So there
 * is no parsing improvement available that would rescue a strict key — the
 * facts are simply not in the payload.
 *
 * ── What "tolerant" does and does not permit ───────────────────────────────
 *
 * UNKNOWN matches UNKNOWN. It does NOT match a known value.
 *
 * That distinction carries the whole argument. Comparing two rates whose
 * refundability is equally unstated is a comparison between two things we know
 * the same amount about — the uncertainty is symmetric and it does not favour
 * either side. Comparing a known-refundable rate against a known-non-refundable
 * one is a false equivalence: those are different products, priced
 * differently, and rule 5 refuses that merge whether or not this key exists.
 *
 * So the tolerant key is weaker evidence, not wrong evidence. `matchStrength`
 * exists so that everything downstream can treat it as weaker rather than
 * quietly rounding it up to certainty — see `assessLiveConfidence`, which
 * cannot return HIGH on a match that rests on an unstated term.
 *
 * The opaque source key is untouched and still governs baselines.
 */

import type { MealPlan, RateAudience, RefundPolicy } from '../types.js';

export interface CompMatchTerms {
  readonly mealPlan: MealPlan;
  readonly refundPolicy: RefundPolicy;
  readonly audience: RateAudience;
}

/**
 * How much of the match rests on terms the source actually stated.
 *
 *   RESOLVED  every dimension known — a like-for-like comparison
 *   PARTIAL   at least one unstated, matched against equally unstated
 *   OPAQUE    nothing stated; the rates are alike only in being unclassifiable
 */
export type CompMatchStrength = 'RESOLVED' | 'PARTIAL' | 'OPAQUE';

/** The dimensions the source left unstated, for disclosure rather than display. */
export function unknownDimensions(terms: CompMatchTerms): readonly string[] {
  const out: string[] = [];
  if (terms.mealPlan === 'UNKNOWN') out.push('meal plan');
  if (terms.refundPolicy === 'UNKNOWN') out.push('cancellation terms');
  if (terms.audience === 'UNKNOWN') out.push('rate audience');
  return out;
}

export function compMatchStrength(terms: CompMatchTerms): CompMatchStrength {
  const unknown = unknownDimensions(terms).length;
  if (unknown === 0) return 'RESOLVED';
  if (unknown >= 3) return 'OPAQUE';
  return 'PARTIAL';
}

/**
 * The key two rates must share to be compared across hotels.
 *
 * Deliberately just the three terms joined — no UNRESOLVED sentinel, because
 * an unstated term here is a value to match on, not a disqualification. The
 * separator matches the semantic class's so the two are visually comparable in
 * a log; they are never interchangeable in code.
 */
export function compMatchKey(terms: CompMatchTerms): string {
  return `${terms.mealPlan}|${terms.refundPolicy}|${terms.audience}`;
}
