/**
 * Every knob the Google Places and OpenAI integrations have, read from the
 * environment in ONE place.
 *
 * Scattering `process.env.X ?? 300` through the code is how two call sites end
 * up disagreeing about the same timeout and nobody notices until one of them
 * is the slow one. Read here, passed as arguments, so a test can set them
 * without touching the environment and a reader can see every default at once.
 *
 * Keys are deliberately NOT part of this object. They are credentials, they
 * are read at the point of use, and they never travel through a settings
 * struct that something might log.
 */

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export interface GoogleSettings {
  /**
   * How stale cached reputation may get before a refresh is due.
   *
   * Weekly, not daily, and the reason is arithmetic. Measured 2026-08-21, the
   * catalogue holds 3,202 hotels of which 3,033 are resolvable. A 24-hour
   * refresh is ~92,000 billed Place Details calls a MONTH, every month, and
   * those calls carry `rating` and `userRatingCount` — Google's dearer
   * fields. Weekly is ~13,200.
   *
   * Nothing is lost for the 7x. A property's guest rating is an average over
   * thousands of reviews; it moves by hundredths over months, and no guest
   * decision turns on today's value versus last Tuesday's. Refreshing a slow
   * signal quickly buys precision the signal does not have.
   */
  readonly refreshHours: number;
  readonly timeoutMs: number;
  /**
   * Below this, a candidate is UNVERIFIED and its data is never used.
   *
   * 0.7 is deliberately strict: the cost of a wrong match is showing one
   * hotel's reputation on another hotel's page, which is worse than showing
   * none. See scoreMatch for what the number is made of.
   */
  readonly minMatchConfidence: number;
}

export interface OpenAiSettings {
  readonly model: string;
  readonly timeoutMs: number;
  /** How long an identical intelligence request reuses its answer. */
  readonly cacheMinutes: number;
}

export function googleSettings(): GoogleSettings {
  return {
    refreshHours: num('GOOGLE_PLACES_REFRESH_HOURS', 168),
    timeoutMs: num('GOOGLE_PLACES_TIMEOUT_MS', 4_000),
    minMatchConfidence: num('GOOGLE_PLACES_MIN_MATCH_CONFIDENCE', 0.7),
  };
}

export function openAiSettings(): OpenAiSettings {
  return {
    model: process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini',
    // Short on purpose: the deterministic answer is already correct and
    // already on screen. Reasoning is an enhancement, and an enhancement that
    // makes the guest wait is a regression.
    timeoutMs: num('OPENAI_TIMEOUT_MS', 6_000),
    cacheMinutes: num('OPENAI_INTELLIGENCE_CACHE_MINUTES', 60),
  };
}

/** Configured, not merely present: an empty string is not a key. */
export const googleConfigured = (): boolean => Boolean(process.env.GOOGLE_PLACES_API_KEY?.trim());

export const openAiConfigured = (): boolean => Boolean(process.env.OPENAI_API_KEY?.trim());
