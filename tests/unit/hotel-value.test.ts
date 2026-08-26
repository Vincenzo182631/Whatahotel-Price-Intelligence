/**
 * Phase 6.X — "why you might choose this hotel", held to its rules.
 *
 * The section interprets evidence and must be impossible to turn into an
 * advertisement: chips only from code-built signals, prose only through
 * the allowlist plus the sales-language and historical-pricing gates, and
 * too little evidence means null — hidden, never stretched. Fame is not
 * evidence: a famous name with no data gets nothing to say.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/index.js';
import {
  buildLiveExplanationBundle,
  type LiveBundleInput,
} from '../../packages/core/src/explanation/liveBundle.js';
import {
  deterministicHotelValue,
  hotelValueConfidence,
  supportingSignals,
  validateHotelValue,
} from '../../packages/core/src/explanation/hotelValue.js';
import { validateNarrative } from '../../packages/core/src/explanation/validate.js';
import {
  computeCalendarDelta,
  computeCompression,
  computeCompSetIndex,
  computePremiumJustification,
} from '../../packages/core/src/scoring/liveSignals.js';
import { composeLiveScore } from '../../packages/core/src/scoring/liveScore.js';
import { extractReviewThemes } from '../../packages/ingest/src/adapters/google/themes.js';

const NOW = new Date('2026-08-21T00:00:00Z');
const OBSERVED = '2026-08-20T23:00:00Z';

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
    hotelName: 'The Kahala Resort',
    city: 'Honolulu',
    roomTypeName: 'Ocean View King',
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
    reputation: { source: 'GOOGLE', rating: 4.6, review_count: 3968, display_name: 'Kahala' },
    perks: ['Breakfast for two', 'Hotel credit'],
    reviewThemes: ['service', 'beach'],
    editorialSummary: 'Refined quiet resort on a private beach.',
    availability: {
      position: 'ENTRY',
      availableCategories: 5,
      cheaperCategoriesAvailable: 0,
      entryClassAvailable: true,
      lowerCategoriesUnavailable: false,
      availabilityInfluenced: false,
    },
    ...overrides,
  });
}

describe('extractReviewThemes (ingest)', () => {
  it('measures only positive reviews and needs two mentions', () => {
    const themes = extractReviewThemes([
      { rating: 5, text: 'The service was wonderful and the beach is right there.' },
      { rating: 4, text: 'Great service, lovely pool.' },
      { rating: 1, text: 'The beach was crowded and the pool dirty.' }, // complaints never count
      { rating: 5, text: 'Beach days were the highlight.' },
    ]);
    expect(themes).toContain('service'); // two positive mentions
    expect(themes).toContain('beach'); // two positive mentions (the 1-star one excluded)
    expect(themes).not.toContain('pool'); // one positive mention only
  });

  it('says nothing from a sample of one', () => {
    expect(extractReviewThemes([{ rating: 5, text: 'Amazing spa and service.' }])).toEqual([]);
  });
});

describe('supportingSignals', () => {
  it('builds the citable vocabulary from facts, rating first', () => {
    const signals = supportingSignals(bundle());
    expect(signals[0]).toBe('★ 4.6 Google rating');
    expect(signals).toContain('Praised service');
    expect(signals).toContain('Beach');
    // Every genuine perk is citable, even ones beyond the display cap.
    expect(signals).toContain('Breakfast for two');
    expect(signals).toContain('Hotel credit');
    expect(signals.length).toBeLessThanOrEqual(8);
  });

  it('displays at most four chips', () => {
    const hv = deterministicHotelValue(bundle());
    expect(hv?.supporting_facts.length).toBeLessThanOrEqual(4);
  });

  it('is empty when there is nothing verified to show', () => {
    const bare = bundle({ reputation: null, perks: [], reviewThemes: [], editorialSummary: null });
    expect(supportingSignals(bare)).toEqual([]);
  });
});

describe('deterministicHotelValue', () => {
  it('hides on no evidence — fame is not evidence', () => {
    const bare = bundle({ reputation: null, perks: [], reviewThemes: [], editorialSummary: null });
    expect(deterministicHotelValue(bare)).toBeNull();
  });

  it('reads rating plus what recent reviewers mention', () => {
    const hv = deterministicHotelValue(bundle());
    expect(hv).not.toBeNull();
    expect(hv?.summary).toContain('4.6 out of 5');
    expect(hv?.summary).toContain('recent reviewers mention');
    expect(hv?.summary).toContain('service');
    expect(hv?.source).toBe('DETERMINISTIC');
  });

  it('names the perks as part of what you receive', () => {
    const hv = deterministicHotelValue(bundle());
    expect(hv?.summary.toLowerCase()).toContain('breakfast for two');
  });

  it('suite rule: a chosen top category is a choice, not a fault', () => {
    const hv = deterministicHotelValue(
      bundle({
        availability: {
          position: 'TOP',
          availableCategories: 5,
          cheaperCategoriesAvailable: 4,
          entryClassAvailable: true,
          lowerCategoriesUnavailable: false,
          availabilityInfluenced: false,
        },
      }),
    );
    expect(hv?.summary).toContain('higher room categories');
    expect(hv?.summary).toContain('room selection');
  });

  it('availability rule: says "currently", never "sold out"', () => {
    const hv = deterministicHotelValue(
      bundle({
        availability: {
          position: 'ENTRY',
          availableCategories: 2,
          cheaperCategoriesAvailable: 0,
          entryClassAvailable: false,
          lowerCategoriesUnavailable: true,
          availabilityInfluenced: true,
        },
      }),
    );
    expect(hv?.summary).toContain('Current availability is concentrated');
    expect(hv?.summary.toLowerCase()).not.toContain('sold out');
  });

  it('never mentions price history', () => {
    const hv = deterministicHotelValue(bundle());
    expect(hv?.summary).not.toMatch(/usually|normally|historical|used to|trend/i);
  });

  it('confidence follows evidence richness, coded', () => {
    expect(hotelValueConfidence(bundle())).toBe('HIGH'); // rating + themes + perks
    expect(hotelValueConfidence(bundle({ reviewThemes: [], perks: ['Hotel credit'] }))).toBe(
      'MEDIUM',
    ); // one perk is a single thin strand beside the rating
    // A single perk and nothing else: too thin to grade above LOW, though
    // the section still renders (the null gate needs zero evidence).
    expect(
      hotelValueConfidence(bundle({ reputation: null, reviewThemes: [], perks: ['Hotel credit'] })),
    ).toBe('LOW');
  });
});

describe('validateHotelValue', () => {
  const valid = () => ({
    headline: 'Highly regarded by recent guests',
    summary:
      'Guests rate this property 4.6 out of 5, and recent reviewers mention service and the beach. Booking here also carries breakfast for two.',
    supporting_facts: ['★ 4.6 Google rating', 'Beach'],
    evidence_used: ['google_rating', 'google_review_themes', 'hotel_perks'],
  });

  it('accepts a draft citing a perk beyond the display cap', () => {
    const draft = { ...valid(), supporting_facts: ['★ 4.6 Google rating', 'Hotel credit'] };
    const check = validateHotelValue(draft, bundle());
    expect(check.ok).toBe(true);
  });

  it('accepts a grounded draft, computing confidence itself', () => {
    const check = validateHotelValue(valid(), bundle());
    expect(check.ok).toBe(true);
    expect(check.value?.source).toBe('MODEL');
    expect(check.value?.confidence).toBe('HIGH');
  });

  it('rejects sales language — this is a decision aid, not an ad', () => {
    const check = validateHotelValue(
      { ...valid(), summary: 'The perfect hotel — book now and you won’t regret it.' },
      bundle(),
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('sales language');
  });

  it('rejects implied price history', () => {
    const check = validateHotelValue(
      { ...valid(), summary: 'This property usually costs far more at this time of year.' },
      bundle(),
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('price history');
  });

  it('rejects a sold-out claim', () => {
    const check = validateHotelValue(
      { ...valid(), summary: 'Lower categories are sold out, leaving only suites.' },
      bundle(),
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('sold out');
  });

  it('rejects an invented amenity chip', () => {
    const check = validateHotelValue(
      { ...valid(), supporting_facts: ['Private helipad'] },
      bundle(),
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('not a verified signal');
  });

  it('rejects an invented numeral', () => {
    const check = validateHotelValue(
      { ...valid(), summary: 'Rated among the top 87% of resorts.' },
      bundle(),
    );
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('87');
  });

  it('rejects citing evidence the bundle does not hold', () => {
    const noThemes = bundle({ reviewThemes: [] });
    const draft = {
      ...valid(),
      summary: 'Guests rate this property 4.6 out of 5.',
      supporting_facts: ['★ 4.6 Google rating'],
    };
    const check = validateHotelValue(draft, noThemes);
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('absent evidence google_review_themes');
  });

  it('rejects an over-budget summary', () => {
    const words = Array.from({ length: 95 }, () => 'evidence').join(' ');
    const check = validateHotelValue({ ...valid(), summary: words + '.' }, bundle());
    expect(check.ok).toBe(false);
    expect(check.violations.join(' ')).toContain('word budget');
  });
});

describe('every deterministic sentence passes its own bundle allowlist', () => {
  it('across the evidence shapes', () => {
    const shapes: Array<Partial<LiveBundleInput>> = [
      {},
      { reviewThemes: [] },
      { reputation: null },
      { perks: [] },
      {
        availability: {
          position: 'TOP',
          availableCategories: 5,
          cheaperCategoriesAvailable: 4,
          entryClassAvailable: true,
          lowerCategoriesUnavailable: false,
          availabilityInfluenced: false,
        },
      },
    ];
    for (const shape of shapes) {
      const b = bundle(shape);
      const hv = deterministicHotelValue(b);
      if (!hv) continue;
      const check = validateNarrative(hv.summary, { ...b.constraints, max_sentences: 3 });
      expect(check.violations, `"${hv.summary}"`).toEqual([]);
    }
  });
});

describe('the room being priced is part of what the rate buys (§13)', () => {
  const withView = (roomViewType: string | null) =>
    deterministicHotelValue(bundle({ roomViewType }));

  it('names the view the source stated', () => {
    expect(withView('OCEAN')?.summary).toContain('an ocean view');
    expect(withView('GARDEN')?.summary).toContain('a garden view');
  });

  it('describes a plain view as plainly as a desirable one', () => {
    // Naming the view is a fact about what is being priced. Ranking views
    // would be an advantage the data does not state, so CITY and INTERIOR
    // read in exactly the same register as OCEAN.
    expect(withView('CITY')?.summary).toContain('a city view');
    expect(withView('INTERIOR')?.summary).toContain('an interior aspect');
  });

  it('says nothing when the source stated nothing', () => {
    // UNKNOWN is the source declining to say. Inventing a view would be the
    // fabrication the direction forbids, and an absent fact stays absent
    // (rule 3).
    // Matched on the sentence this feature emits, not on the word "view" —
    // "recent reviewers mention" contains it, and a test that fails on its
    // own vocabulary teaches nothing.
    expect(withView('UNKNOWN')?.summary ?? '').not.toMatch(/category being priced/);
    expect(withView(null)?.summary ?? '').not.toMatch(/category being priced/);
  });

  it('lets a stated view carry the section when nothing else can', () => {
    const bare = deterministicHotelValue(
      bundle({
        reputation: null,
        perks: [],
        reviewThemes: [],
        editorialSummary: null,
        roomViewType: 'OCEAN',
      }),
    );
    expect(bare).not.toBeNull();
    expect(bare?.summary).toContain('an ocean view');
  });
});
