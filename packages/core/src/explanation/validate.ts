/**
 * The gate every generated sentence passes before a customer sees it.
 *
 * Two rules, both release blockers:
 *
 *   V1  every numeral in the text appears in `allowed_numbers`. A model that
 *       states a figure the engine did not compute has fabricated a statistic,
 *       and the failure is invisible to the reader — the number looks exactly
 *       as authoritative as a real one.
 *   V2  no predictive language (invariant P11). This system does not forecast.
 *   V3  no narrated data limitations — those describe the system, not the stay.
 *   V4  no verdict about the HOTEL where the engine measured only the PRICE.
 *
 * Rejection, never repair. A sentence with a wrong number cannot be patched
 * into a right one without knowing what the writer meant, and guessing that is
 * how a fabrication survives a validator. The deterministic renderer is always
 * available and always correct, so falling back costs nothing but polish.
 */

import { numeralsIn } from './bundle.js';
import { findPredictiveLanguage } from './predictive.js';

export interface NarrativeConstraints {
  readonly allowed_numbers: readonly number[];
  readonly max_sentences: number;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/** Sentence count, tolerant of abbreviations we actually emit (none today). */
function sentenceCount(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

/**
 * V3 — internal system conditions are not customer copy (owner directive,
 * 2026-08-26). "We don't have enough data" describes the SYSTEM; customer
 * prose describes the HOTEL and the RATE. A draft that apologises for the
 * data is rejected whole, and the deterministic renderer — which never
 * writes these phrases — ships instead. This does not weaken honesty:
 * facts and caveats stated about the product ("the rates do not state what
 * each includes") pass; narrated limitations do not.
 */
const DATA_APOLOGY =
  /\b(not enough (?:data|information|live|comparable|rates?|reviews?)|could not (?:verify|calculate|score|compare)|unable to (?:score|calculate|verify|compare)|insufficient (?:data|information|comparables?)|data (?:is |was )?(?:unavailable|missing|limited)|we (?:do not|don'?t) have enough|system (?:could|can)(?:not| not)|unfortunately)\b/i;

/**
 * V4 — a verdict about the PRICE is not a verdict about the HOTEL (owner
 * directive, 2026-08-26).
 *
 * "Priced above the local competitive set" and "overpriced" describe the same
 * arithmetic and make different claims. The first is a measurement the engine
 * can defend; the second is a judgement about whether the property is worth
 * its rate, which nothing here measures — the comparison holds price against
 * price, and the things that justify a premium (location, condition, service,
 * what the stay includes) are largely not in this source at all.
 *
 * So the ban is not squeamishness about negative findings. A high Comp-Set
 * Index still renders as a premium, the band still says so, and the caveats
 * still ship. What may not ship is a conclusion the evidence does not reach.
 *
 * Deliberately narrow. "Premium", "above the comparable median", "higher than
 * every comparable checked" all pass — they state the measurement. Only the
 * verdict words are refused, and refused whole: the deterministic renderer
 * never writes them, so falling back costs nothing.
 */
const DISPARAGEMENT =
  /\b(overpriced|over-priced|bad (?:value|deal|choice)|poor (?:value|choice)|not worth (?:it|the)|isn'?t worth (?:it|the)|too expensive|steep for what|rip-?off|avoid this)\b/i;

export function validateNarrative(
  text: string,
  constraints: NarrativeConstraints,
): ValidationResult {
  const violations: string[] = [];

  const predictive = findPredictiveLanguage(text);
  if (predictive.length > 0) {
    violations.push(`predictive language: ${[...new Set(predictive)].join(', ')}`);
  }

  const apology = DATA_APOLOGY.exec(text);
  if (apology) {
    violations.push(`data-limitation language: "${apology[0]}"`);
  }

  const disparaging = DISPARAGEMENT.exec(text);
  if (disparaging) {
    violations.push(`verdict about the hotel rather than the price: "${disparaging[0]}"`);
  }

  // Compared at one decimal because that is the precision the allowlist is
  // built at — 8.25 and 8.3 are the same claim, and the bundle stores 8.3.
  const allowed = new Set(constraints.allowed_numbers.map((n) => Math.round(n * 10) / 10));
  for (const n of numeralsIn(text)) {
    if (!allowed.has(Math.round(n * 10) / 10)) violations.push(`unlisted number: ${n}`);
  }

  const sentences = sentenceCount(text);
  if (sentences > constraints.max_sentences) {
    violations.push(`${sentences} sentences, limit ${constraints.max_sentences}`);
  }

  if (text.trim().length === 0) violations.push('empty');

  return { ok: violations.length === 0, violations };
}
