/**
 * Motivator assessment: the verdict, and the evidence that earns it.
 *
 * Owner requirement (2026-09-18). What is pinned here is the constraint that
 * makes the inference defensible at all: a verdict never renders without the
 * evidence beside it, and no evidence means LIMITED_EVIDENCE rather than a
 * quiet no.
 */
import { describe, expect, it } from 'vitest';
import {
  assessMotivators,
  renderMotivatorPivot,
} from '../../packages/core/src/explanation/motivators.js';

const empty = {
  roomAmenities: [],
  reviewThemes: [],
  perks: [],
  rating: null,
  comparableMedianRating: null,
  dealScoreOutOfTen: null,
};

const find = (input: Parameters<typeof assessMotivators>[0], m: string) =>
  assessMotivators(input).find((a) => a.motivator === m);

describe('assessMotivators', () => {
  it('covers all ten motivators, always', () => {
    const all = assessMotivators(empty);
    expect(all).toHaveLength(10);
    expect(all.map((a) => a.motivator)).toContain('BEACH_RESORT');
    expect(all.map((a) => a.motivator)).toContain('BUSINESS_TRAVEL');
  });

  it('never returns SUPPORTED without evidence a guest can read', () => {
    // The whole design. An inference with nothing behind it is the Places
    // goodForChildren failure (rule 30): a label with no check available.
    for (const a of assessMotivators({
      ...empty,
      roomAmenities: ['Cribs', 'Marble bathroom'],
      reviewThemes: ['beach', 'quiet'],
      dealScoreOutOfTen: 7.2,
    })) {
      if (a.verdict === 'SUPPORTED') expect(a.evidence.length).toBeGreaterThan(0);
    }
  });

  it('finds nothing means LIMITED_EVIDENCE, never a negative verdict', () => {
    // Owner decision: "we did not find it" is a statement about our research.
    // 2,012 hotels returned an empty amenity list tonight (rule 28's line).
    for (const a of assessMotivators(empty)) {
      expect(a.verdict).toBe('LIMITED_EVIDENCE');
      expect(a.evidence).toEqual([]);
      expect(a.verdict).not.toBe('MEASURED_ABSENT');
    }
  });

  it('supports Family from cribs and connecting rooms, and shows them', () => {
    const family = find({ ...empty, roomAmenities: ['Cribs', 'Connecting rooms'] }, 'FAMILY');
    expect(family?.verdict).toBe('SUPPORTED');
    expect(family?.evidence[0]?.text).toContain('cribs');
    expect(family?.evidence[0]?.source).toBe('ROOM_AMENITY');
  });

  it('supports Beach & Resort from what reviewers actually mention', () => {
    const beach = find({ ...empty, reviewThemes: ['beach', 'pool'] }, 'BEACH_RESORT');
    expect(beach?.verdict).toBe('SUPPORTED');
    expect(beach?.evidence[0]?.text).toContain('the beach');
    expect(beach?.evidence[0]?.source).toBe('REVIEW_THEME');
  });

  it('answers the value motivators from the score, not from a property trait', () => {
    // They are questions about the RATE. Hunting for a "value amenity" would
    // be inventing a signal; the comparison already answers it.
    const general = find({ ...empty, dealScoreOutOfTen: 7.2 }, 'GENERAL_VALUE');
    expect(general?.verdict).toBe('SUPPORTED');
    expect(general?.evidence[0]?.source).toBe('DEAL_SCORE');
    expect(general?.evidence[0]?.text).toContain('7.2');

    const noScore = find(empty, 'GENERAL_VALUE');
    expect(noScore?.verdict).toBe('LIMITED_EVIDENCE');
  });

  it('claims a rating advantage only when the hotel is genuinely above its peers', () => {
    // Never the inverse claim: we do not tell a guest a hotel is worse than
    // its neighbours (rule 22, and the premium-support rule).
    const above = find({ ...empty, rating: 4.7, comparableMedianRating: 4.4 }, 'LUXURY_EXPERIENCE');
    expect(above?.evidence.some((e) => e.source === 'GOOGLE_RATING')).toBe(true);

    const below = find({ ...empty, rating: 4.1, comparableMedianRating: 4.5 }, 'LUXURY_EXPERIENCE');
    expect(below?.evidence.some((e) => e.source === 'GOOGLE_RATING')).toBe(false);
    expect(below?.verdict).toBe('LIMITED_EVIDENCE');
  });

  it('reads Amenities as breadth, and a typical hotel does not clear it', () => {
    // The median hotel holds six. Six is not "the rooms are the point".
    const typical = find({ ...empty, roomAmenities: ['A', 'B', 'C', 'D', 'E', 'F'] }, 'AMENITIES');
    expect(typical?.verdict).toBe('LIMITED_EVIDENCE');

    const broad = find(
      { ...empty, roomAmenities: Array.from({ length: 12 }, (_, i) => `Amenity ${i}`) },
      'AMENITIES',
    );
    expect(broad?.verdict).toBe('SUPPORTED');
    expect(broad?.evidence[0]?.text).toContain('12 room amenities');
  });

  it('does not fire Business Travel on a telephone', () => {
    // A loose match is worse than no match: it would tell a guest nothing
    // while looking like a finding (rule 9).
    const weak = find({ ...empty, roomAmenities: ['Telephone', 'Voice mail'] }, 'BUSINESS_TRAVEL');
    expect(weak?.verdict).toBe('LIMITED_EVIDENCE');

    const real = find({ ...empty, roomAmenities: ['Large desk'] }, 'BUSINESS_TRAVEL');
    expect(real?.verdict).toBe('SUPPORTED');
  });
});

/**
 * The pivot: what this property DOES show, when the clicked preference shows
 * nothing.
 *
 * Shape copied from the WhataHotel advisor, examined 2026-09-18. Asked
 * whether W Aspen has a pool and a beach it answered the literal question,
 * gave the reason, and pointed somewhere useful. Ours said "limited
 * information is available" and stopped, which is true and leaves a guest
 * with less than they arrived with.
 *
 * The content is not copied. Every word here is evidence measured for the
 * same hotel on the same request, for the other nine motivators — which were
 * computed and thrown away whenever the tenth came back empty.
 */
describe('renderMotivatorPivot', () => {
  const beachy = assessMotivators({
    roomAmenities: ['Bathrobe', 'Slippers'],
    reviewThemes: ['beach', 'service'],
    perks: ['Breakfast for two'],
    rating: null,
    comparableMedianRating: null,
    dealScoreOutOfTen: 7,
  });

  it('names what the property does show when the asked-about one is thin', () => {
    const pivot = renderMotivatorPivot(beachy, 'FAMILY');
    expect(pivot).not.toBeNull();
    expect(pivot).toMatch(/What this property does show/);
    expect(pivot?.toLowerCase()).toMatch(/beach|service|bathrobe/);
  });

  it('never points at the preference that was actually asked about', () => {
    // It is the answer to "we hold nothing for X", so citing X would be a
    // contradiction in one sentence.
    const pivot = renderMotivatorPivot(beachy, 'BEACH_RESORT');
    expect(pivot ?? '').not.toMatch(/the beach/);
  });

  it('never pivots to the rate', () => {
    // The two VALUE motivators answer a question about the price, and a
    // guest asking about the beach is not asking about the price.
    const pivot = renderMotivatorPivot(beachy, 'FAMILY') ?? '';
    expect(pivot).not.toMatch(/out of 10|score|rate/i);
  });

  it('says nothing at all when nothing else is supported either', () => {
    // Silence beats padding. The limited sentence stands alone, as before.
    const bare = assessMotivators({
      roomAmenities: [],
      reviewThemes: [],
      perks: [],
      rating: null,
      comparableMedianRating: null,
      dealScoreOutOfTen: null,
    });
    expect(renderMotivatorPivot(bare, 'FAMILY')).toBeNull();
  });

  it('states no shortcoming of the hotel', () => {
    // Rule 33: "we hold no evidence" is a statement about our research, and
    // the limited sentence beside this one already makes it. Rule 28 forbids
    // a verdict on the property outright.
    const pivot = renderMotivatorPivot(beachy, 'FAMILY') ?? '';
    expect(pivot).not.toMatch(/not |lacks|without|no |unsuitable|poor/i);
  });
});

/**
 * Area evidence — the class of fact our preference answers were most short of.
 *
 * Added after reading the WhataHotel advisor's own system prompt, which draws
 * a line we did not have: its "never invent" rule covers HOTEL facts (rating,
 * amenities, perks, price) while the surrounding AREA may come from general
 * knowledge. The line is right; the sourcing is where we differ. Ours cites
 * two things already held and never fed to a motivator — Google's own
 * description (rule 32) and the address the hotel's page states (rule 24).
 */
describe('area evidence', () => {
  const withArea = (over: Record<string, unknown> = {}) =>
    assessMotivators({
      roomAmenities: [],
      reviewThemes: [],
      perks: [],
      rating: null,
      comparableMedianRating: null,
      dealScoreOutOfTen: null,
      editorialSummary: 'A landmark hotel steps from the beach, with a spa and two restaurants.',
      streetAddress: '2259 Kalakaua Ave, Honolulu, HI 96815',
      ...over,
    });

  const evidenceFor = (all: ReturnType<typeof assessMotivators>, m: string) =>
    all.find((x) => x.motivator === m)?.evidence ?? [];

  it("quotes Google's description as Google's, never as our own measurement", () => {
    const beach = evidenceFor(withArea(), 'BEACH_RESORT');
    const line = beach.find((e) => e.source === 'GOOGLE_EDITORIAL');
    expect(line).toBeDefined();
    // Rule 32: a reader can weigh "Google says this" and cannot weigh an
    // unattributed claim.
    expect(line?.text).toMatch(/^Google's description/);
    expect(line?.text).toContain('beach');
  });

  it('answers LOCATION with the address the property itself states', () => {
    const loc = evidenceFor(withArea(), 'LOCATION');
    const addr = loc.find((e) => e.source === 'STREET_ADDRESS');
    expect(addr?.text).toContain('Kalakaua Ave');
  });

  it('puts the address on LOCATION only', () => {
    // An address answers "where is this". Padding the other nine motivators
    // with it would be noise, which is rule 9's failure in a new place.
    for (const m of ['BEACH_RESORT', 'FAMILY', 'AMENITIES', 'NIGHTLIFE']) {
      expect(evidenceFor(withArea(), m).some((e) => e.source === 'STREET_ADDRESS')).toBe(false);
    }
  });

  it('matches a placement, not the word "location"', () => {
    // "Location" hits every summary ever written; "steps from" is a placement
    // a reader can check against a map.
    const vague = withArea({ editorialSummary: 'A hotel with a great location.' });
    expect(evidenceFor(vague, 'LOCATION').some((e) => e.source === 'GOOGLE_EDITORIAL')).toBe(false);
  });

  it('says nothing when we hold neither', () => {
    const bare = withArea({ editorialSummary: null, streetAddress: null });
    for (const m of ['LOCATION', 'BEACH_RESORT']) {
      const srcs = evidenceFor(bare, m).map((e) => e.source);
      expect(srcs).not.toContain('GOOGLE_EDITORIAL');
      expect(srcs).not.toContain('STREET_ADDRESS');
    }
  });
});
