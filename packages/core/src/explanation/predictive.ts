/**
 * The predictive-language rule, in one place.
 *
 * Invariant P11 is a release blocker: no rendered explanation may tell a
 * customer what a price is going to do. This system has no basis for such a
 * claim — the source carries no rate history (U3), WAIT was retired in config
 * v4, and the product deliberately does not forecast.
 *
 * The vocabulary is deliberately blunt. A false positive costs one reworded
 * sentence; a false negative ships a forecast. When in doubt it fires.
 *
 * This lives in `packages/core` rather than in the test that first needed it
 * because two callers now check the same rule against different text: the
 * property suite, which checks every explanation the engine can generate from
 * fabricated inputs, and `scripts/live-probe.mjs`, which checks the ones it
 * actually generates from production data. Two copies of a safety regex is one
 * copy too many — they drift, and the half that drifts is the half nobody is
 * looking at.
 */

export const PREDICTIVE_VOCABULARY =
  /\b(will|won't|going to|expect|expected|predict|forecast|likely to|unlikely to|soften|rise|rises|drop further|fall further|before it|book before|soon)\b/i;

/** True when `text` contains language that states or implies a future price. */
export function containsPredictiveLanguage(text: string): boolean {
  return PREDICTIVE_VOCABULARY.test(text);
}

/**
 * Every predictive term in `text`, for reporting.
 *
 * A bare boolean tells you a release is blocked; this tells you which word to
 * go and fix.
 */
export function findPredictiveLanguage(text: string): readonly string[] {
  const global = new RegExp(PREDICTIVE_VOCABULARY.source, 'gi');
  return [...text.matchAll(global)].map((m) => m[0]);
}
