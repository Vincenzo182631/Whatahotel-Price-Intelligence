/**
 * Phase 5's deterministic additions: availability position and the
 * better-value alternative.
 *
 * The two claims most worth guarding:
 *
 *   - "Lower categories currently unavailable" is asserted ONLY when the
 *     catalogue provably carries an entry class none of which is available.
 *     Absence of evidence never becomes a sold-out claim (spec §7).
 *   - The alternative is never simply the cheapest hotel (spec §11).
 */

import { describe, expect, it } from 'vitest';

import {
  assessAvailabilityPosition,
  chooseAlternative,
  chooseRoomUpgrade,
  chooseSuperiorAlternative,
  isProtectedBrand,
  premiumPosition,
} from '../../packages/core/src/index.js';

describe('assessAvailabilityPosition', () => {
  const suiteOnly = [{ roomClass: 'SUITE', nightlyMinor: 350_000 }];

  it('flags the suite-only situation ONLY when the catalogue proves an entry class exists', () => {
    // The Four Seasons scenario: catalogue has ROOM categories, none
    // available today, a suite is the cheapest thing on offer.
    const proven = assessAvailabilityPosition(350_000, 'SUITE', suiteOnly, ['ROOM', 'SUITE']);
    expect(proven.lowerCategoriesUnavailable).toBe(true);
    expect(proven.availabilityInfluenced).toBe(true);
    expect(proven.position).toBe('ENTRY'); // cheapest AVAILABLE, however dear

    // Same availability, but the catalogue only ever had suites: no claim.
    const unproven = assessAvailabilityPosition(350_000, 'SUITE', suiteOnly, ['SUITE']);
    expect(unproven.lowerCategoriesUnavailable).toBe(false);
    expect(unproven.availabilityInfluenced).toBe(false);
  });

  it('a guest who CHOSE the suite from a menu with entry rooms is not availability-influenced', () => {
    const menu = [
      { roomClass: 'ROOM', nightlyMinor: 70_000 },
      { roomClass: 'SUITE', nightlyMinor: 350_000 },
    ];
    const a = assessAvailabilityPosition(350_000, 'SUITE', menu, ['ROOM', 'SUITE']);
    expect(a.position).toBe('TOP');
    expect(a.cheaperCategoriesAvailable).toBe(1);
    expect(a.availabilityInfluenced).toBe(false);
  });

  it('positions ENTRY / MID / TOP by price among what is available', () => {
    const menu = [
      { roomClass: 'ROOM', nightlyMinor: 50_000 },
      { roomClass: 'ROOM', nightlyMinor: 60_000 },
      { roomClass: 'SUITE', nightlyMinor: 90_000 },
    ];
    expect(assessAvailabilityPosition(50_000, 'ROOM', menu, ['ROOM']).position).toBe('ENTRY');
    expect(assessAvailabilityPosition(60_000, 'ROOM', menu, ['ROOM']).position).toBe('MID');
    expect(assessAvailabilityPosition(90_000, 'SUITE', menu, ['ROOM']).position).toBe('TOP');
  });

  it('is silent when nothing is available', () => {
    const a = assessAvailabilityPosition(50_000, 'ROOM', [], ['ROOM']);
    expect(a.position).toBeNull();
    expect(a.availabilityInfluenced).toBe(false);
  });
});

describe('chooseAlternative with a stated preference (Phase 6)', () => {
  const subject = 100_000;
  const candidates = [
    // Big saving, unrated.
    { wahHotelId: 'deep', name: 'Deep Saver', nightlyMinor: 60_000, isAvailable: true },
    // Modest saving, superb verified reputation.
    {
      wahHotelId: 'loved',
      name: 'Beloved Hotel',
      nightlyMinor: 88_000,
      isAvailable: true,
      rating: 4.8,
      reviewCount: 5_000,
    },
  ];

  it('BEST_VALUE tilts the ranking toward the saving', () => {
    expect(chooseAlternative(subject, candidates, 'BEST_VALUE')?.wahHotelId).toBe('deep');
  });

  it('LUXURY_EXPERIENCE tilts it toward verified reputation', () => {
    expect(chooseAlternative(subject, candidates, 'LUXURY_EXPERIENCE')?.wahHotelId).toBe('loved');
  });

  it('any other preference uses the default blend, same as no preference', () => {
    const noPref = chooseAlternative(subject, candidates);
    expect(chooseAlternative(subject, candidates, 'FAMILY')?.wahHotelId).toBe(noPref?.wahHotelId);
    expect(chooseAlternative(subject, candidates, 'GENERAL_VALUE')?.wahHotelId).toBe(
      noPref?.wahHotelId,
    );
  });

  it('a preference never widens eligibility — no candidate within 10% qualifies', () => {
    const nearPrice = [
      { wahHotelId: 'near', name: 'Nearly Same Price', nightlyMinor: 95_000, isAvailable: true },
    ];
    expect(chooseAlternative(subject, nearPrice, 'BEST_VALUE')).toBeNull();
  });
});

describe('chooseAlternative', () => {
  const subject = 85_000;

  it('is not simply the cheapest: a well-reviewed saving beats a bare one', () => {
    const alt = chooseAlternative(subject, [
      // Cheapest, but unrated.
      { wahHotelId: 'a', name: 'Cheapest Inn', nightlyMinor: 48_000, isAvailable: true },
      // Slightly dearer, strongly rated with real volume.
      {
        wahHotelId: 'b',
        name: 'Well Rated Hotel',
        nightlyMinor: 55_000,
        isAvailable: true,
        rating: 4.6,
        reviewCount: 5200,
      },
    ]);
    expect(alt?.wahHotelId).toBe('b');
    expect(alt?.saveNightlyMinor).toBe(30_000);
  });

  it('ignores savings under 10% and unavailable hotels', () => {
    expect(
      chooseAlternative(subject, [
        { wahHotelId: 'a', name: 'Barely Cheaper', nightlyMinor: 80_000, isAvailable: true },
        { wahHotelId: 'b', name: 'Sold Out', nightlyMinor: 40_000, isAvailable: false },
      ]),
    ).toBeNull();
  });

  it('a thin rating on tiny volume does not outrank a solid one', () => {
    const alt = chooseAlternative(subject, [
      {
        wahHotelId: 'a',
        name: 'Nine Reviews',
        nightlyMinor: 60_000,
        isAvailable: true,
        rating: 4.9,
        reviewCount: 9,
      },
      {
        wahHotelId: 'b',
        name: 'Five Thousand Reviews',
        nightlyMinor: 60_000,
        isAvailable: true,
        rating: 4.6,
        reviewCount: 5000,
      },
    ]);
    expect(alt?.wahHotelId).toBe('b');
  });

  it('is null when the comp set is empty', () => {
    expect(chooseAlternative(subject, [])).toBeNull();
  });
});

describe('premiumPosition — the consultative frame is computed, not chosen', () => {
  it('maps levels to frames', () => {
    expect(premiumPosition('HIGH', 30, false)).toBe('PREMIUM_APPEARS_SUPPORTED');
    expect(premiumPosition('MEDIUM', 30, false)).toBe('PREMIUM_MAY_BE_REASONABLE');
    expect(premiumPosition('LOW', 30, false)).toBe('HIGHER_PRICED_OPTION');
    expect(premiumPosition('LOW', 80, false)).toBe('SIGNIFICANT_PREMIUM');
    expect(premiumPosition('INSUFFICIENT_DATA', null, false)).toBe('LIMITED_DATA');
  });

  it('the availability frame outranks the plain ones when the premium is large', () => {
    expect(premiumPosition('LOW', 400, true)).toBe('SIGNIFICANT_PREMIUM_LIMITED_AVAILABILITY');
    expect(premiumPosition('INSUFFICIENT_DATA', 400, true)).toBe(
      'SIGNIFICANT_PREMIUM_LIMITED_AVAILABILITY',
    );
  });
});

describe('the customer-facing register (spec §1/§13)', () => {
  it('the widget label maps carry no critic vocabulary', async () => {
    const { readFile } = await import('node:fs/promises');
    const widget = await readFile('apps/web/public/widget.js', 'utf8');
    const labels = widget.match(/POSITION_LABEL = \{[^}]+\}/)?.[0] ?? '';
    expect(labels.length).toBeGreaterThan(0);
    for (const banned of ['LOW', 'Bad', 'bad value', 'overpriced', 'not worth', 'poor']) {
      expect(labels.includes(banned), `"${banned}" in customer labels`).toBe(false);
    }
  });
});

describe('chooseSuperiorAlternative — the upsell', () => {
  const subject = { hotelName: 'The Kahala Resort', nightlyMinor: 60_000, rating: 4.4 };
  const strong = {
    wahHotelId: 'sup',
    name: 'Halekulani',
    nightlyMinor: 90_000,
    isAvailable: true,
    rating: 4.7,
    reviewCount: 4_100,
    themes: ['service', 'quiet'],
  };

  it('recommends by verified standing, never by price — pricier is fine', () => {
    const pick = chooseSuperiorAlternative(subject, [strong]);
    expect(pick?.wahHotelId).toBe('sup');
    expect(pick?.priceDeltaNightlyMinor).toBe(30_000); // an upsell, and said so
  });

  it('needs a MEANINGFUL rating gap and real review volume', () => {
    expect(
      chooseSuperiorAlternative(subject, [{ ...strong, rating: 4.5 }]), // +0.1 only
    ).toBeNull();
    expect(chooseSuperiorAlternative(subject, [{ ...strong, reviewCount: 60 }])).toBeNull();
  });

  it('NEVER fires for a Four Seasons booking — the rule is code, not prompt', () => {
    expect(isProtectedBrand('Four Seasons Oahu at Ko Olina')).toBe(true);
    expect(isProtectedBrand('FourSeasons Resort Maui')).toBe(true);
    expect(isProtectedBrand('The Kahala Resort')).toBe(false);
    expect(
      chooseSuperiorAlternative(
        { hotelName: 'Four Seasons Resort Oahu', nightlyMinor: 60_000, rating: 4.2 },
        [strong],
      ),
    ).toBeNull();
  });

  it('a Four Seasons CANDIDATE is still recommendable — the rule protects the selection', () => {
    const fsCandidate = { ...strong, wahHotelId: 'fs', name: 'Four Seasons Resort Maui' };
    expect(chooseSuperiorAlternative(subject, [fsCandidate])?.wahHotelId).toBe('fs');
  });
});

describe('chooseRoomUpgrade — the non-competing recommendation', () => {
  const rooms = [
    { roomTypeId: 1, name: 'Historic Room, 1 King', roomClass: 'ROOM', nightlyMinor: 50_000 },
    { roomTypeId: 2, name: 'Junior Suite', roomClass: 'JUNIOR_SUITE', nightlyMinor: 80_000 },
    { roomTypeId: 3, name: 'Grand Suite', roomClass: 'SUITE', nightlyMinor: 140_000 },
  ];

  it('offers the CHEAPEST higher category', () => {
    const up = chooseRoomUpgrade('ROOM', 50_000, rooms);
    expect(up?.roomTypeId).toBe(2);
    expect(up?.priceDeltaNightlyMinor).toBe(30_000);
  });

  it('is silent when the guest already holds the top category on offer', () => {
    expect(chooseRoomUpgrade('SUITE', 140_000, rooms)).toBeNull();
  });
});
