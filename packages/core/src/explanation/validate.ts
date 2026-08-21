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

export function validateNarrative(
  text: string,
  constraints: NarrativeConstraints,
): ValidationResult {
  const violations: string[] = [];

  const predictive = findPredictiveLanguage(text);
  if (predictive.length > 0) {
    violations.push(`predictive language: ${[...new Set(predictive)].join(', ')}`);
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
