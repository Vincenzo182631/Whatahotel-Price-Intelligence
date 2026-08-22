/**
 * Phase 6 — the personalization layer, held to its two governing rules.
 *
 * Rule one: the preference NEVER changes a number. Every fact in the bundle
 * is identical across preferences; only the interpretation moves. Tested
 * directly by building the same stay under every preference and comparing
 * the objective blocks byte for byte.
 *
 * Rule two: no evidence, no claim. A preference the data cannot speak to —
 * amenities, family, nightlife, quiet, business — gets a plain "limited
 * information" statement, and the fit list is short or empty rather than
 * padded. Model drafts pass the same allowlist/prediction/absent-evidence
 * gate as the assessment, and rejection falls back to the deterministic
 * reading, never to silence.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import {
  buildLiveExplanationBundle,
  type LiveBundleInput,
} from '../../packages/core/src/explanation/liveBundle.js';
import {
  PREFERENCES,
  parsePreference,
  type Preference,
} from '../../packages/core/src/explanation/preference.js';
import {
  deterministicPersonalization,
  validatePersonalization,
} from '../../packages/core/src/explanation/personalization.js';
import {
  computeCalendarDelta,
  computeCompression,
  computeCompSetIndex,
  computePremiumJustification,
} from '../../packages/core/src/scoring/liveSignals.js';
import { composeLiveScore } from '../../packages/core/src/scoring/liveScore.js';
import { bundleKey } from '../../packages/ingest/src/adapters/openai/reasoner.js';

const NOW = new Date('2026-08-21T00:00:00Z');
const OBSERVED = '2026-08-20T23:00:00Z';

/** A premium stay: 62_000 against comps at 44-50k, with every trimming. */
function bundle(overrides: Partial<LiveBundleInput> = {}) {
  const comps = [44_000, 46_000, 48_000, 50_000].map((n, i) => ({
    hotelId: `c${i}`,
    name: `Competitor ${i}`,
    nightlyMinor: n,
    observedAt: OBSERVED,
    isAvailable: true,
  }));
  const nightly = 62_000;
  const premium = computePremiumJustification(nightly, null, comps, DEFAULT_CONFIG);
  const compSet = computeCompSetIndex(
    nightly,
    comps,
    DEFAULT_CONFIG,
    NOW,
    { strength: 'RESOLVED', unknown: [] },
    null,
  );
  const calendar = computeCalendarDelta(
    nightly,
    [{ checkIn: '2026-09-03', nightlyMinor: 60_000, observedAt: OBSERVED, sameDow: true }],
    DEFAULT_CONFIG,
  );
  const compression = computeCompression({ checked: 8, soldOut: 3 }, DEFAULT_CONFIG);

  return buildLiveExplanationBundle({
    configVersion: DEFAULT_CONFIG.version,
    hotelName: 'Loews Miami Beach',
    city: 'Miami Beach',
    roomTypeName: 'Corner King',
    roomClass: 'ROOM',
    checkIn: '2026-09-10',
    checkOut: '2026-09-13',
    nights: 3,
    adults: 2,
    children: 0,
    currency: 'USD',
    nightlyMinor: nightly,
    totalMinor: 186_000,
    observedAt: OBSERVED,
    result: composeLiveScore(compSet, calendar, compression, 1, DEFAULT_CONFIG),
    compSet,
    calendar,
    compression,
    premium,
    reputation: { source: 'GOOGLE', rating: 4.6, review_count: 3200, display_name: 'Loews' },
    comparableRatings: [4.2, 4.4, 4.5],
    availability: {
      position: 'ENTRY',
      availableCategories: 5,
      cheaperCategoriesAvailable: 0,
      entryClassAvailable: true,
      lowerCategoriesUnavailable: false,
      availabilityInfluenced: false,
    },
    // No digits in the name: these sentences are held to the numeric
    // allowlist below, and a digit in a proper noun is still a numeral.
    alternative: { name: 'Seaside Palms', nightlyMinor: 44_000, rating: 4.4, reviewCount: 1800 },
    ...overrides,
  });
}

describe('parsePreference', () => {
  it('accepts any casing and rejects the unrecognised', () => {
    expect(parsePreference('best_value')).toBe('BEST_VALUE');
    expect(parsePreference('LUXURY_EXPERIENCE')).toBe('LUXURY_EXPERIENCE');
    expect(parsePreference('cheapest')).toBeNull();
    expect(parsePreference('')).toBeNull();
    expect(parsePreference(null)).toBeNull();
  });
});

describe('the preference never changes a number (§4)', () => {
  it('every objective block is identical across all ten preferences', () => {
    const reference = bundle({ preference: 'GENERAL_VALUE' });
    for (const preference of PREFERENCES) {
      const b = bundle({ preference });
      expect(b.verdict).toEqual(reference.verdict);
      expect(b.price).toEqual(reference.price);
      expect(b.premium).toEqual(reference.premium);
      expect(b.availability).toEqual(reference.availability);
      expect(b.reputation).toEqual(reference.reputation);
      expect(b.market).toEqual(reference.market);
      expect(b.constraints.allowed_numbers).toEqual(reference.constraints.allowed_numbers);
    }
  });

  it('each preference is its own cache entry (§26)', () => {
    const keys = new Set(PREFERENCES.map((preference) => bundleKey(bundle({ preference }))));
    expect(keys.size).toBe(PREFERENCES.length);
  });
});

describe('deterministicPersonalization', () => {
  it('is null for GENERAL_VALUE — the default answer is the Phase 5 answer', () => {
    expect(deterministicPersonalization(bundle({ preference: 'GENERAL_VALUE' }))).toBeNull();
    expect(deterministicPersonalization(bundle())).toBeNull();
  });

  it('BEST_VALUE leads with the alternative when one was chosen', () => {
    const p = deterministicPersonalization(bundle({ preference: 'BEST_VALUE' }));
    expect(p).not.toBeNull();
    expect(p?.personalized_insight).toContain('Seaside Palms');
    expect(p?.personalized_insight).toContain('$440'); // nightly, major units
    expect(p?.personalized_insight).toContain('$180'); // the saving
    expect(p?.alternative_reason).toContain('lower current rate');
    expect(p?.source).toBe('DETERMINISTIC');
  });

  it('BEST_VALUE without an alternative reports the comp set honestly', () => {
    const p = deterministicPersonalization(bundle({ preference: 'BEST_VALUE', alternative: null }));
    expect(p?.personalized_insight).toContain('none currently offers');
    expect(p?.personalized_insight).toContain('4'); // comps_used
  });

  it('LUXURY_EXPERIENCE speaks from the verified rating', () => {
    const p = deterministicPersonalization(bundle({ preference: 'LUXURY_EXPERIENCE' }));
    expect(p?.personalized_insight).toContain('4.6 out of 5');
    expect(p?.personalized_insight).toContain('3,200');
    expect(p?.evidence_used).toContain('google_rating');
  });

  it('LUXURY_EXPERIENCE without a rating says so instead of inventing one', () => {
    const p = deterministicPersonalization(
      bundle({ preference: 'LUXURY_EXPERIENCE', reputation: null }),
    );
    expect(p?.personalized_insight).toContain('No verified guest rating');
    expect(p?.evidence_used).not.toContain('google_rating');
  });

  it('BEACH_RESORT is gated on a stated ocean view', () => {
    const ocean = deterministicPersonalization(
      bundle({ preference: 'BEACH_RESORT', roomViewType: 'OCEAN' }),
    );
    expect(ocean?.personalized_insight).toContain('ocean-view category');

    const city = deterministicPersonalization(
      bundle({ preference: 'BEACH_RESORT', roomViewType: 'CITY' }),
    );
    expect(city?.personalized_insight).toContain('Limited beach- and resort-specific information');

    const unstated = deterministicPersonalization(bundle({ preference: 'BEACH_RESORT' }));
    expect(unstated?.personalized_insight).toContain(
      'Limited beach- and resort-specific information',
    );
  });

  it('a preference with no supporting data says so plainly (§7)', () => {
    for (const preference of [
      'AMENITIES',
      'FAMILY',
      'NIGHTLIFE',
      'QUIET_RELAXATION',
      'BUSINESS_TRAVEL',
    ] as const) {
      const p = deterministicPersonalization(bundle({ preference }));
      expect(p?.personalized_insight).toContain('Limited');
      expect(p?.personalized_insight).toContain('information is available');
    }
  });

  it('fit reasons come only from evidence — thin evidence means a short list, never padding', () => {
    const rich = deterministicPersonalization(bundle({ preference: 'LUXURY_EXPERIENCE' }));
    expect(rich?.why_this_hotel_may_fit.length).toBeGreaterThanOrEqual(2);
    expect(rich?.why_this_hotel_may_fit.length).toBeLessThanOrEqual(3);

    const thin = deterministicPersonalization(
      bundle({
        preference: 'NIGHTLIFE',
        reputation: null,
        comparableRatings: [],
        alternative: null,
        availability: null,
      }),
    );
    // Premium stay with no reputation, no alternative and no availability
    // read: nothing qualifies as a fit reason, and nothing is invented.
    expect(thin?.why_this_hotel_may_fit).toEqual([]);
  });

  it('what_to_consider carries the premium and the alternative as neutral facts', () => {
    const p = deterministicPersonalization(bundle({ preference: 'FAMILY' }));
    const joined = p?.what_to_consider.join(' ') ?? '';
    expect(joined).toContain('above the comparable median');
    expect(joined).toContain('lower rate');
  });
});

describe('validatePersonalization', () => {
  const valid = () => ({
    personalized_insight: 'Guests rate this property 4.6 out of 5 across 3,200 reviews.',
    why_this_hotel_may_fit: ['Rated 4.6 out of 5 by 3,200 guest reviews.'],
    what_to_consider: ['A comparable stay is currently available at a lower rate.'],
    alternative_reason: 'A comparable stay is currently available at a lower rate.',
    evidence_used: ['google_rating', 'comparable_rates'],
  });

  it('accepts a grounded draft, forcing preference and confidence', () => {
    const b = bundle({ preference: 'LUXURY_EXPERIENCE' });
    const check = validatePersonalization(valid(), b);
    expect(check.ok).toBe(true);
    expect(check.value?.preference).toBe('LUXURY_EXPERIENCE');
    expect(check.value?.source).toBe('MODEL');
    // Confidence is computed, never the model's to state.
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(check.value?.confidence);
  });

  it('rejects an invented numeral', () => {
    const b = bundle({ preference: 'LUXURY_EXPERIENCE' });
    const draft = { ...valid(), personalized_insight: 'This suits you 87% of the time.' };
    const check = validatePersonalization(draft, b);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('87');
  });

  it('rejects predictive language', () => {
    const b = bundle({ preference: 'BEST_VALUE' });
    const draft = { ...valid(), what_to_consider: ['Prices will rise closer to the date.'] };
    const check = validatePersonalization(draft, b);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('predictive');
  });

  it('rejects an alternative_reason when no alternative was chosen', () => {
    const b = bundle({ preference: 'BEST_VALUE', alternative: null });
    const check = validatePersonalization(valid(), b);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('no alternative');
  });

  it('rejects citing evidence the bundle does not hold', () => {
    const b = bundle({ preference: 'LUXURY_EXPERIENCE', reputation: null });
    const check = validatePersonalization(valid(), b);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('absent evidence google_rating');
  });

  it('rejects a padded list', () => {
    const b = bundle({ preference: 'BEST_VALUE' });
    const draft = {
      ...valid(),
      why_this_hotel_may_fit: ['One.', 'Two.', 'Three.', 'Four.'],
    };
    const check = validatePersonalization(draft, b);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('at most 3');
  });

  it('never validates a personalization for GENERAL_VALUE', () => {
    const b = bundle({ preference: 'GENERAL_VALUE' });
    const check = validatePersonalization(valid(), b);
    expect(check.ok).toBe(false);
  });
});

describe('every deterministic sentence passes its own bundle allowlist', () => {
  // The deterministic path is not re-validated at runtime — it must not need
  // to be. This holds it to the same standard the model is held to.
  it('numerals and predictions, across all preferences and evidence shapes', async () => {
    const { validateNarrative } = await import('../../packages/core/src/explanation/validate.js');
    const shapes: Array<Partial<LiveBundleInput>> = [
      {},
      { alternative: null },
      { reputation: null, comparableRatings: [] },
      { roomViewType: 'OCEAN' },
      { alternative: null, reputation: null, availability: null, comparableRatings: [] },
    ];
    for (const shape of shapes) {
      for (const preference of PREFERENCES.filter((p): p is Preference => p !== 'GENERAL_VALUE')) {
        const b = bundle({ ...shape, preference });
        const p = deterministicPersonalization(b);
        expect(p).not.toBeNull();
        const texts = [
          p!.personalized_insight,
          ...p!.why_this_hotel_may_fit,
          ...p!.what_to_consider,
          ...(p!.alternative_reason ? [p!.alternative_reason] : []),
        ];
        for (const text of texts) {
          const check = validateNarrative(text, {
            ...b.constraints,
            max_sentences: 3,
          });
          expect(check.violations, `${preference}: "${text}"`).toEqual([]);
        }
      }
    }
  });
});
