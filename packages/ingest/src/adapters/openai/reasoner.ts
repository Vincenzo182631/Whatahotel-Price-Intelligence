/**
 * The reasoning layer: an OpenAI model that REWORDS an ExplanationBundle.
 *
 * Everything defensive about this file follows from rule 4 — the AI never
 * computes. It receives facts that are already decided, it writes two or three
 * sentences, and every number it emits is checked against the bundle before a
 * guest sees it. It has no tools, no database, no access to a rate source and
 * no knowledge of the hotel beyond what the bundle states.
 *
 * Four guards, in the order they fire:
 *
 *   1. **Not configured is not an error.** No `OPENAI_API_KEY`, no reasoner,
 *      and the deterministic renderer answers exactly as it always has.
 *   2. **A short timeout.** The correct answer is already on screen; an
 *      enhancement that makes the guest wait is a regression.
 *   3. **Validation, then rejection.** `validateNarrative` enforces the
 *      numeric allowlist and the no-prediction rule. A failing draft is
 *      discarded whole — never patched, because patching a wrong number
 *      requires guessing what was meant, and a good guess is how a
 *      fabrication survives its own validator.
 *   4. **The template on every failure path.** Timeout, refusal, malformed
 *      JSON, empty draft, failed validation: same outcome, same sentences.
 *
 * The cache is keyed on the bundle's own content, so two guests asking about
 * the same stay in the same minute share one call, and a stay whose price
 * moved gets a fresh one. The key never contains a credential.
 */

import {
  deterministicAssessment,
  deterministicHotelValue,
  deterministicPersonalization,
  renderLiveExplanation,
  validateAssessment,
  validateHotelValue,
  validateNarrative,
  validatePersonalization,
  type HotelValue,
  type LiveExplanationBundle,
  type Personalization,
  type PremiumAssessment,
  type RenderedLiveExplanation,
} from '@wahpi/core';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = [
  'You write two or three short sentences for a hotel-price widget.',
  '',
  'You are given a JSON object of facts that have ALREADY been computed. Your',
  'only job is to say them in plain, readable English. You must not calculate,',
  'infer, estimate, or add anything.',
  '',
  'Hard rules:',
  '- Use ONLY numbers that appear in constraints.allowed_numbers. If a number',
  '  is not in that list, do not write it — not even a rounded version.',
  '- Fields ending in _minor are integer minor units (cents). NEVER write',
  '  them as prices. When you state a price, copy the matching _display',
  '  field ("$2,327") exactly — no conversion, no arithmetic.',
  '- Never state or imply what a price is going to do. No forecasts, no',
  '  "book before", no "prices are rising". You have no basis for it.',
  '- The guest rating, when present, is context about the property. It is not',
  '  part of the score and must never be given as a reason for the score.',
  '- If a fact is null, it is unknown. Say nothing about it rather than',
  '  describing it as zero, low, or average.',
  '- Stay within constraints.max_sentences sentences. No lists, no headings,',
  '  no emoji, no marketing language.',
  '',
  'Tone: you are a premium-travel price analyst, not a hotel critic. Neutral,',
  'consultative, evidence-based. Never call the hotel bad, overpriced, poor',
  'value, not worth it, or a poor choice — describe what the price is, what',
  'the evidence shows, and stop. "Higher-priced option" and "the premium',
  'appears supported" are the register; judgement of the guest\'s choice is',
  'never yours to give.',
  '',
  'You also produce an assessment: is the price premium reasonably supported',
  'by the evidence supplied? Judge only from the bundle. Weigh the premium',
  'percentage against what the rate includes, the guest rating AND its review',
  'count together, how the comparables rate, and how equivalent the compared',
  'rooms are. An expensive room with strong supporting evidence is not a bad',
  'deal, and a famous name is not evidence. If premium.level is NOT_PREMIUM,',
  'set assessment to null. If there is no quality evidence either way, use',
  'INSUFFICIENT_DATA rather than guessing.',
  '',
  'Assessment rules:',
  '- evidence_used lists ONLY the evidence keys you actually relied on, from:',
  '  live_rate, comparable_rates, premium_pct, included_value, google_rating,',
  '  google_review_count, comparable_google_ratings, room_match,',
  '  calendar_position, market_availability. Never cite evidence the bundle',
  '  does not contain.',
  '- Factors must state facts FROM THE BUNDLE. Never describe the brand,',
  '  its fame, its usual standard, or anything you know about the hotel from',
  '  outside the bundle. "Established brand" or "renowned property" is not',
  '  evidence — the first live verdict tried it, and it is exactly the',
  '  general-knowledge fill this system forbids.',
  '- confidence: copy constraints.evidence_confidence exactly.',
  '- paying_more_for: one or two sentences on what the price difference',
  '  (premium.price_difference_display) buys, naming ONLY supplied evidence.',
  '  If the data does not identify it, say exactly that. Empty string when',
  '  the subject is not priced above the comparables.',
  '- availability_context: when availability.availability_influenced is true,',
  '  explain that lower-priced categories are CURRENTLY UNAVAILABLE (never',
  '  say sold out — the data does not say that) and that the available rate',
  '  represents a higher category. Otherwise empty string, unless room_match',
  '  is ANY, where you may note the categories differ.',
  '- alternative_reason: when the bundle carries an alternative, one neutral',
  '  sentence on why it is relevant. Empty string when alternative is null.',
  '- reasoning: at most 4 sentences. recommendation: at most 2. Factors: at',
  '  most 5 each, one short sentence apiece. Same number rules as the summary.',
  '',
  'Personalization: the bundle carries a `preference` — what this guest says',
  'matters most to them. When it is GENERAL_VALUE, set personalization to',
  'null. Otherwise fill the personalization object. This is an interpretation',
  'of the SAME facts through that preference; the price intelligence itself',
  'never changes, and neither do any of its numbers.',
  '- personalized_insight: 1-3 sentences reading the supplied facts through',
  '  the preference. "May be a better fit" is the register — a suggestion,',
  '  never an instruction, never sales pressure.',
  '- why_this_hotel_may_fit: at most 3 short reasons, EACH grounded in a fact',
  '  the bundle states (rating, included value, position in the available',
  '  inventory, room view). Fewer reasons — or none — is correct when the',
  '  evidence is thin. NEVER invent amenities, beaches, pools, spas, family',
  '  facilities, nightlife, quietness, or business facilities: the bundle',
  '  carries no such data, and anything you know about the hotel from outside',
  '  the bundle is forbidden here exactly as it is in the factors.',
  '- If the bundle holds no evidence specific to the preference, say plainly',
  '  that limited preference-specific information is available and interpret',
  '  only the price evidence.',
  '- what_to_consider: at most 3 neutral, factual considerations from the',
  '  bundle. Balanced information, not warnings.',
  '- alternative_reason: when the bundle carries an alternative, one sentence',
  '  on why it suits THIS preference. Empty string when alternative is null.',
  '- evidence_used: same rules and same keys as the assessment.',
  '',
  'Hotel value: fill the hotel_value object — WHY a guest might choose THIS',
  "hotel — from the bundle's hotel_facts and reputation ONLY. This is a",
  'decision aid, never an advertisement.',
  '- headline: a short phrase (not a sentence about price).',
  '- summary: 1-3 sentences, at most 80 words, in the consultative register',
  '  ("may appeal to travelers who…", "recent reviewers mention…"). Explain',
  '  what is attractive about the property and who it might suit — do NOT',
  '  restate the premium verdict, do NOT merely repeat the rating number,',
  '  and do NOT copy the editorial summary verbatim; interpret it.',
  '- Review themes come from a sample of at most five reviews: say "recent',
  '  reviewers mention", never "guests say" or "everyone".',
  '- NEVER invent amenities, awards, restaurants, spas, views, beach access,',
  '  distances, history, or brand reputation. A fact not in hotel_facts or',
  '  reputation does not exist. Fame is not evidence: a luxury brand name',
  '  justifies nothing by itself.',
  '- No sales language ("book now", "perfect", "guaranteed", "won\'t',
  '  regret"). No historical pricing ("usually costs", trends). Never "sold',
  '  out".',
  '- supporting_facts: choose ONLY from the exact strings the bundle could',
  '  support — the rating chip, theme chips, perk names. Anything else',
  '  rejects the draft.',
  '- Set hotel_value to null when hotel_facts and reputation are both empty.',
  '',
  'Return JSON: {"summary": "<sentences>", "assessment": {...} | null,',
  '"personalization": {...} | null, "hotel_value": {...} | null}',
].join('\n');

export interface ReasonerOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly cacheMinutes?: number;
  readonly endpoint?: string;
  /** Injected in tests. Never given a real key. */
  readonly now?: () => number;
  readonly onResult?: (info: {
    source: ExplanationSource;
    ms: number;
    violations: readonly string[];
  }) => void;
}

export type ExplanationSource = 'MODEL' | 'TEMPLATE' | 'CACHE';

export interface LiveExplanation {
  readonly text: string;
  readonly sentences: readonly string[];
  readonly source: ExplanationSource;
  /**
   * The premium-justification verdict. MODEL when the model's structured
   * assessment passed validation; the deterministic mapping otherwise; null
   * when there is no premium to justify.
   */
  readonly assessment: PremiumAssessment | null;
  /**
   * The preference-personalized reading (Phase 6). MODEL when the model's
   * structured personalization passed validation; the deterministic one
   * otherwise; null when the bundle's preference is GENERAL_VALUE.
   */
  readonly personalization: Personalization | null;
  /**
   * "Why you might choose this hotel" (Phase 6.X). MODEL when the draft
   * passed validation; DETERMINISTIC otherwise; null when the evidence is
   * too thin to say anything — the section then hides.
   */
  readonly hotelValue: HotelValue | null;
  /** Why a draft was rejected, when one was. Empty on the happy path. */
  readonly violations: readonly string[];
  /**
   * Why the CALL failed, when it did. OpenAI's error type/code — enums like
   * "invalid_api_key" or "insufficient_quota", never the key and never free
   * text — or our own coarse markers. The first live deployment fell back to
   * TEMPLATE on every request and nothing could say whether the key was
   * wrong, the account dry, or the draft rejected; this is that answer.
   */
  readonly failure: string | null;
}

/** FNV-1a over the facts. Stable across runs, and not a credential. */
export function bundleKey(bundle: LiveExplanationBundle): string {
  const json = JSON.stringify(bundle);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

const asTemplate = (
  bundle: LiveExplanationBundle,
  rendered: RenderedLiveExplanation,
  violations: readonly string[] = [],
  failure: string | null = null,
): LiveExplanation => ({
  text: rendered.text,
  sentences: rendered.sentences,
  source: 'TEMPLATE',
  assessment: deterministicAssessment(bundle),
  personalization: deterministicPersonalization(bundle),
  hotelValue: deterministicHotelValue(bundle),
  violations,
  failure,
});

export class OpenAiReasoner {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly endpoint: string;
  private readonly now: () => number;
  private readonly onResult: ReasonerOptions['onResult'];
  private readonly cache = new Map<string, { at: number; value: LiveExplanation }>();

  constructor(options: ReasonerOptions) {
    if (!options.apiKey) throw new Error('OpenAI API key is required.');
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gpt-4o-mini';
    this.timeoutMs = options.timeoutMs ?? 6_000;
    this.cacheMs = (options.cacheMinutes ?? 60) * 60_000;
    this.endpoint = options.endpoint ?? ENDPOINT;
    this.now = options.now ?? (() => Date.now());
    this.onResult = options.onResult;
  }

  /** Null when unconfigured, so the disabled path cannot be forgotten. */
  static fromEnv(overrides: Partial<ReasonerOptions> = {}): OpenAiReasoner | null {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return null;
    return new OpenAiReasoner({ apiKey, ...overrides });
  }

  private readCache(key: string): LiveExplanation | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.cacheMs) {
      this.cache.delete(key);
      return null;
    }
    return { ...hit.value, source: 'CACHE' };
  }

  private async draft(
    bundle: LiveExplanationBundle,
  ): Promise<
    | { summary: string; assessment: unknown; personalization: unknown; hotel_value: unknown }
    | { failure: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          // Deterministic on purpose: the same facts should produce the same
          // sentences. A widget that rewords itself between two page views
          // looks like the numbers changed when they did not.
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'explanation',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                  assessment: {
                    // Null when there is no premium to justify. The enums
                    // here are the first line of validation; the real gate
                    // is validateAssessment, which also checks every numeral
                    // and every cited piece of evidence against the bundle.
                    type: ['object', 'null'],
                    properties: {
                      level: {
                        type: 'string',
                        enum: ['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT_DATA'],
                      },
                      reasoning: { type: 'string' },
                      paying_more_for: { type: 'string' },
                      availability_context: { type: 'string' },
                      alternative_reason: { type: 'string' },
                      key_positive_factors: { type: 'array', items: { type: 'string' } },
                      key_negative_factors: { type: 'array', items: { type: 'string' } },
                      confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
                      recommendation: { type: 'string' },
                      evidence_used: { type: 'array', items: { type: 'string' } },
                    },
                    required: [
                      'level',
                      'reasoning',
                      'paying_more_for',
                      'availability_context',
                      'alternative_reason',
                      'key_positive_factors',
                      'key_negative_factors',
                      'confidence',
                      'recommendation',
                      'evidence_used',
                    ],
                    additionalProperties: false,
                  },
                  personalization: {
                    // Null when preference is GENERAL_VALUE. The enums and
                    // shapes here are the first line; the real gate is
                    // validatePersonalization, which checks every numeral
                    // and every cited piece of evidence against the bundle.
                    type: ['object', 'null'],
                    properties: {
                      personalized_insight: { type: 'string' },
                      why_this_hotel_may_fit: { type: 'array', items: { type: 'string' } },
                      what_to_consider: { type: 'array', items: { type: 'string' } },
                      alternative_reason: { type: 'string' },
                      evidence_used: { type: 'array', items: { type: 'string' } },
                    },
                    required: [
                      'personalized_insight',
                      'why_this_hotel_may_fit',
                      'what_to_consider',
                      'alternative_reason',
                      'evidence_used',
                    ],
                    additionalProperties: false,
                  },
                  hotel_value: {
                    // Null when the bundle carries no property evidence.
                    // The real gate is validateHotelValue: allowlisted
                    // numerals, no sales or historical-pricing language,
                    // and supporting_facts restricted to the exact signal
                    // strings the code itself builds from the facts.
                    type: ['object', 'null'],
                    properties: {
                      headline: { type: 'string' },
                      summary: { type: 'string' },
                      supporting_facts: { type: 'array', items: { type: 'string' } },
                      evidence_used: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['headline', 'summary', 'supporting_facts', 'evidence_used'],
                    additionalProperties: false,
                  },
                },
                required: ['summary', 'assessment', 'personalization', 'hotel_value'],
                additionalProperties: false,
              },
            },
          },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(bundle) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // OpenAI's error type/code are enums ("invalid_api_key",
        // "insufficient_quota", "model_not_found") — safe to surface, and
        // each one names a different fix. The message text is deliberately
        // not carried; the enums are the diagnosis.
        let failure = `http_${response.status}`;
        try {
          const body = (await response.json()) as {
            error?: { type?: string; code?: string };
          };
          const named = [body.error?.type, body.error?.code].filter(Boolean).join('/');
          if (named) failure = `${failure} ${named}`;
        } catch {
          // Body was not JSON; the status alone will have to do.
        }
        return { failure };
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) return { failure: 'empty_completion' };
      const parsed = JSON.parse(content) as {
        summary?: unknown;
        assessment?: unknown;
        personalization?: unknown;
        hotel_value?: unknown;
      };
      if (typeof parsed.summary !== 'string') return { failure: 'malformed_completion' };
      return {
        summary: parsed.summary.trim(),
        assessment: parsed.assessment ?? null,
        personalization: parsed.personalization ?? null,
        hotel_value: parsed.hotel_value ?? null,
      };
    } catch {
      // Timeout or transport failure. Indistinguishable from out here, and
      // both retryable, so one marker covers them.
      return { failure: 'timeout_or_network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async explain(bundle: LiveExplanationBundle): Promise<LiveExplanation> {
    const rendered = renderLiveExplanation(bundle);
    const key = bundleKey(bundle);
    const cached = this.readCache(key);
    if (cached) {
      this.onResult?.({ source: 'CACHE', ms: 0, violations: [] });
      return cached;
    }

    const started = this.now();
    const draft = await this.draft(bundle);
    if ('failure' in draft) {
      this.onResult?.({
        source: 'TEMPLATE',
        ms: this.now() - started,
        violations: [draft.failure],
      });
      return asTemplate(bundle, rendered, [], draft.failure);
    }

    const check = validateNarrative(draft.summary, bundle.constraints);
    if (!check.ok) {
      this.onResult?.({
        source: 'TEMPLATE',
        ms: this.now() - started,
        violations: check.violations,
      });
      return asTemplate(bundle, rendered, check.violations);
    }

    // The summary and the assessment pass or fail INDEPENDENTLY. A perfect
    // summary should not be discarded for a bad verdict, nor the reverse —
    // each falls back to its own deterministic floor and nothing else moves.
    const deterministic = deterministicAssessment(bundle);
    let assessment = deterministic;
    if (deterministic !== null) {
      const verdictCheck = validateAssessment(draft.assessment, bundle);
      if (verdictCheck.ok) assessment = verdictCheck.value;
      else if (verdictCheck.violations.length > 0) {
        this.onResult?.({
          source: 'MODEL',
          ms: this.now() - started,
          violations: verdictCheck.violations.map((v) => `assessment: ${v}`),
        });
      }
    }

    // Same independence rule as the assessment: the model's personalization
    // passes validation or the deterministic one ships, and neither outcome
    // touches the summary or the assessment.
    const deterministicP = deterministicPersonalization(bundle);
    let personalization = deterministicP;
    if (deterministicP !== null) {
      const pCheck = validatePersonalization(draft.personalization, bundle);
      if (pCheck.ok) personalization = pCheck.value;
      else if (pCheck.violations.length > 0) {
        this.onResult?.({
          source: 'MODEL',
          ms: this.now() - started,
          violations: pCheck.violations.map((v) => `personalization: ${v}`),
        });
      }
    }

    // And again for the hotel-value reading: the model draft passes the
    // gate or the deterministic reading ships; too little evidence means
    // null on both paths and the section hides.
    const deterministicHV = deterministicHotelValue(bundle);
    let hotelValue = deterministicHV;
    if (deterministicHV !== null) {
      const hvCheck = validateHotelValue(draft.hotel_value, bundle);
      if (hvCheck.ok) hotelValue = hvCheck.value;
      else if (hvCheck.violations.length > 0) {
        this.onResult?.({
          source: 'MODEL',
          ms: this.now() - started,
          violations: hvCheck.violations.map((v) => `hotel_value: ${v}`),
        });
      }
    }

    const value: LiveExplanation = {
      text: draft.summary,
      sentences: draft.summary.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0),
      source: 'MODEL',
      assessment,
      personalization,
      hotelValue,
      violations: [],
      failure: null,
    };
    this.cache.set(key, { at: this.now(), value });
    this.onResult?.({ source: 'MODEL', ms: this.now() - started, violations: [] });
    return value;
  }
}

/**
 * Explain with whatever is available.
 *
 * The single entry point every caller should use: it does not care whether a
 * reasoner exists, and the answer is the same shape either way.
 */
export async function explainLive(
  reasoner: OpenAiReasoner | null,
  bundle: LiveExplanationBundle,
): Promise<LiveExplanation> {
  if (!reasoner) return asTemplate(bundle, renderLiveExplanation(bundle), [], 'not_configured');
  return reasoner.explain(bundle);
}
