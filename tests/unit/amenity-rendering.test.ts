/**
 * Naming amenities, and keeping Google's words as Google's.
 *
 * Two decisions from 2026-09-18, both Vincent's: name what the source states
 * rather than infer a category from it, and attribute the editorial summary
 * separately rather than folding it into our sentence.
 *
 * What is pinned here is the LINE between a fact and a conclusion. "Sofa bed"
 * is a fact about a room. "Good for families" is a conclusion, and rule 30 is
 * what that conclusion costs: Places' own goodForChildren field was true for
 * all 20 hotels sampled, so the conclusion it looked like evidence for would
 * have been the same sentence on every hotel in the catalogue.
 */
import { describe, expect, it } from 'vitest';
import {
  deterministicHotelValue,
  hotelOnlyFacts,
} from '../../packages/core/src/explanation/hotelValue.js';

const base = {
  preference: 'GENERAL_VALUE' as const,
  city: 'Honolulu',
  reputation: {
    source: 'GOOGLE' as const,
    rating: 4.4,
    review_count: 4747,
    display_name: 'The Royal Hawaiian',
  },
};

describe('named room amenities', () => {
  it('names what the source states, verbatim', () => {
    const value = deterministicHotelValue(
      hotelOnlyFacts({ ...base, roomAmenities: ['Walk-in closet', 'Marble bathroom'] }),
    );
    expect(value?.summary).toContain('walk-in closet');
    expect(value?.summary).toContain('marble bathroom');
    expect(value?.evidence_used).toContain('hotel_room_amenities');
  });

  it('never turns an amenity into a claim about who the hotel suits', () => {
    // The whole point of the decision. A sofa bed and a crib are facts; the
    // inference from them is not ours to make (rules 21, 28, 30).
    const value = deterministicHotelValue(
      hotelOnlyFacts({ ...base, roomAmenities: ['Sofa bed', 'Cribs'] }),
    );
    const text = `${value?.headline} ${value?.summary}`.toLowerCase();
    for (const claim of ['family', 'families', 'kid', 'child', 'romantic', 'business travel']) {
      expect(text).not.toContain(claim);
    }
  });

  it('says nothing when the source stated nothing, and never pads', () => {
    // The median hotel holds six amenities, so a short list is ordinary and
    // an empty one is simply silence (rule 3's principle for prose).
    const none = deterministicHotelValue(hotelOnlyFacts({ ...base, roomAmenities: [] }));
    expect(none?.summary).not.toContain('Rooms here list');

    const one = deterministicHotelValue(hotelOnlyFacts({ ...base, roomAmenities: ['Bathrobe'] }));
    expect(one?.summary).toContain('bathrobe');
    expect(one?.evidence_used).toContain('hotel_room_amenities');
  });

  it('caps the named list rather than reading out two dozen labels', () => {
    const many = deterministicHotelValue(
      hotelOnlyFacts({
        ...base,
        roomAmenities: ['A one', 'B two', 'C three', 'D four', 'E five'],
      }),
    );
    expect(many?.summary).toContain('a one');
    expect(many?.summary).not.toContain('d four');
  });

  it('can carry a card on amenities alone', () => {
    // Without a rating, perks or themes there was previously nothing to say.
    // A stated amenity is something.
    const value = deterministicHotelValue(
      hotelOnlyFacts({ preference: 'GENERAL_VALUE', roomAmenities: ['Marble bathroom'] }),
    );
    expect(value).not.toBeNull();
    expect(value?.summary).toContain('marble bathroom');
  });
});

describe("Google's description stays Google's", () => {
  const EDITORIAL =
    'Landmark 1927 beachfront hotel with a pink facade and a private stretch of sand.';

  it('is carried separately and attributed, never folded into our summary', () => {
    const value = deterministicHotelValue(hotelOnlyFacts({ ...base, editorialSummary: EDITORIAL }));
    expect(value?.editorial).toEqual({ text: EDITORIAL, attribution: 'GOOGLE' });
    // The claim we must not make is that this is our own reading.
    expect(value?.summary).not.toContain('pink facade');
    expect(value?.evidence_used).toContain('google_editorial_summary');
  });

  it('is null rather than invented when we hold none', () => {
    const value = deterministicHotelValue(hotelOnlyFacts({ ...base }));
    expect(value?.editorial).toBeNull();
    expect(value?.evidence_used).not.toContain('google_editorial_summary');
  });

  it('treats whitespace as absence', () => {
    const value = deterministicHotelValue(hotelOnlyFacts({ ...base, editorialSummary: '   ' }));
    expect(value?.editorial).toBeNull();
  });
});
