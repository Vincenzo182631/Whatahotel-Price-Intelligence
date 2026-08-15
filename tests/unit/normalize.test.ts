import { describe, expect, it } from 'vitest';

import {
  extractAttributes,
  roomClassesCompatible,
  viewsCompatible,
} from '../../packages/core/src/normalize/attributes.js';
import {
  classifyComparability,
  describeRateTerms,
  ALL_COMPARABILITY_CLASSES,
} from '../../packages/core/src/normalize/ratePlan.js';
import {
  matchRoomType,
  type RoomTypeCandidate,
} from '../../packages/core/src/normalize/roomType.js';
import { normalizeRoomName, trigramSimilarity } from '../../packages/core/src/normalize/text.js';

describe('room name normalization', () => {
  it('collapses the variants of one room to a single form', () => {
    const forms = [
      'Ocean View King',
      'OCEANVIEW KING BED',
      'Deluxe King - Ocean View',
      'ocean  view   king',
      'Ocean-View King',
    ];
    const normalized = forms.map(normalizeRoomName);
    // Not all collapse to the identical string — "deluxe" is a real tier word
    // and is deliberately kept — but the pure whitespace/punctuation variants do.
    expect(normalized[0]).toBe('ocean view king');
    expect(normalized[3]).toBe('ocean view king');
    expect(normalized[4]).toBe('ocean view king');
    expect(normalized[2]).toContain('deluxe');
  });

  it('expands curated abbreviations', () => {
    expect(normalizeRoomName('OVK')).toBe('ocean view king');
    expect(normalizeRoomName('Jr Ste')).toBe('junior suite');
    expect(normalizeRoomName('Dlx Dbl')).toBe('deluxe double');
  });

  it('drops marketing filler but keeps tier words', () => {
    expect(normalizeRoomName('Our Luxurious Ocean View King')).toBe('ocean view king');
    // "deluxe" and "superior" separate real price tiers, so they survive.
    expect(normalizeRoomName('Deluxe Room')).toBe('deluxe');
    expect(normalizeRoomName('Superior King Room')).toBe('superior king');
  });

  it('never normalizes to the empty string, even when every word is filler', () => {
    // Falling back to the unfiltered form is right: an empty normalized name
    // would collide with every other all-filler name at the unique index.
    expect(normalizeRoomName('Room')).toBe('room');
    expect(normalizeRoomName('The Room')).toBe('the room');
    expect(normalizeRoomName('Our Luxurious Signature Room')).toBe('our luxurious signature room');
  });

  it('scores trigram similarity between 0 and 1', () => {
    expect(trigramSimilarity('ocean view king', 'ocean view king')).toBe(1);
    expect(trigramSimilarity('ocean view king', 'garden view twin')).toBeLessThan(0.4);
    expect(trigramSimilarity('', 'anything')).toBe(0);
  });
});

describe('attribute extraction', () => {
  it('reads class, bed and view', () => {
    expect(extractAttributes('ocean view king')).toEqual({
      roomClass: 'ROOM',
      bedConfig: 'KING',
      view: 'OCEAN',
    });
    expect(extractAttributes('junior suite garden view').roomClass).toBe('JUNIOR_SUITE');
    expect(extractAttributes('beachfront villa').roomClass).toBe('VILLA');
    expect(extractAttributes('partial ocean view queen').view).toBe('PARTIAL_OCEAN');
  });

  it('treats UNKNOWN as "could not tell", not "different"', () => {
    expect(roomClassesCompatible('UNKNOWN', 'SUITE')).toBe(true);
    expect(roomClassesCompatible('ROOM', 'ROOM')).toBe(true);
    expect(roomClassesCompatible('ROOM', 'SUITE')).toBe(false);
  });
});

describe('room type matching', () => {
  const candidates: RoomTypeCandidate[] = [
    { roomTypeId: '1', normalizedName: 'ocean view king', roomClass: 'ROOM', sourceCodes: ['OVK'] },
    { roomTypeId: '2', normalizedName: 'ocean view king suite', roomClass: 'SUITE' },
    { roomTypeId: '3', normalizedName: 'garden view twin', roomClass: 'ROOM' },
  ];

  it('prefers a structured source code', () => {
    const match = matchRoomType('Anything At All', candidates, {}, 'OVK');
    expect(match.roomTypeId).toBe('1');
    expect(match.method).toBe('SOURCE_ID');
    expect(match.confidence).toBe(1);
  });

  it('matches an exact normalized name', () => {
    const match = matchRoomType('OCEAN VIEW KING', candidates);
    expect(match.roomTypeId).toBe('1');
    expect(match.method).toBe('ALIAS_EXACT');
  });

  it('NEVER merges a room into a suite, however similar the strings', () => {
    // The failure mode that most damages the Deal Score: mixing two price tiers.
    const match = matchRoomType('Ocean View King Suite Premium', candidates);
    expect(match.roomTypeId).not.toBe('1');
    if (match.roomTypeId !== null) {
      expect(match.roomTypeId).toBe('2');
    }

    const reverse = matchRoomType('Ocean View King Bed', candidates);
    expect(reverse.roomTypeId).not.toBe('2');
  });

  it('reports fuzzy matches with reduced confidence and flags them for review', () => {
    const match = matchRoomType('Oceanview Kng', candidates);
    if (match.method === 'ALIAS_FUZZY') {
      expect(match.confidence).toBeGreaterThanOrEqual(0.6);
      expect(match.confidence).toBeLessThanOrEqual(0.9);
      expect(match.needsReview).toBe(true);
    } else {
      expect(match.method).toBe('UNMATCHED');
    }
  });

  it('returns UNMATCHED rather than guessing', () => {
    const match = matchRoomType('Completely Unrelated Accommodation Xyzzy', [
      { roomTypeId: '9', normalizedName: 'presidential penthouse', roomClass: 'PENTHOUSE' },
    ]);
    expect(match.roomTypeId).toBeNull();
    expect(match.confidence).toBe(0);
    expect(match.needsReview).toBe(true);
  });

  it('records which candidates were rejected for class mismatch', () => {
    const match = matchRoomType('Grand Suite Deluxe', candidates);
    expect(match.rejectedForClassMismatch.length).toBeGreaterThan(0);
  });
});

/**
 * These three rules were added after running the matcher against live hotel
 * inventory, where the defaults merged products that are priced differently.
 * The strings below are real room names from that data.
 */
describe('room type matching · guards against over-merging', () => {
  const beachfront: RoomTypeCandidate[] = [
    {
      roomTypeId: 'oceanfront',
      normalizedName: 'oceanfront guest room 1 king',
      roomClass: 'ROOM',
      view: 'OCEAN',
    },
    {
      roomTypeId: 'city',
      normalizedName: 'cityscape guest room 1 king',
      roomClass: 'ROOM',
      view: 'CITY',
    },
  ];

  it('never merges across views, however similar the strings', () => {
    // These differ by one word out of five and are trigram-close.
    const match = matchRoomType('Bayfront Guest Room, 1 King', beachfront);
    expect(match.roomTypeId).not.toBe('city');
  });

  it('recognises the view words real inventory actually uses', () => {
    expect(extractAttributes('oceanfront guest room').view).toBe('OCEAN');
    expect(extractAttributes('bayfront king bed').view).toBe('OCEAN');
    expect(extractAttributes('cityscape suite king').view).toBe('CITY');
    expect(extractAttributes('partial ocean view guest room').view).toBe('PARTIAL_OCEAN');
    // Still distinct: partial ocean is a priced step below full ocean.
    expect(viewsCompatible('OCEAN', 'PARTIAL_OCEAN')).toBe(false);
    // UNKNOWN stays permissive — it means "could not tell".
    expect(viewsCompatible('OCEAN', 'UNKNOWN')).toBe(true);
  });

  it('can disable the fuzzy step for sources with machine-stable names', () => {
    // The real strings, with the long shared tail that is the whole problem:
    // trigram similarity is 0.56, well over the 0.45 default, even though a
    // Presidential Suite is emphatically not a Corner Suite.
    const suites: RoomTypeCandidate[] = [
      {
        roomTypeId: 'corner',
        normalizedName: 'bayfront corner suite floor 20 25 separate living and bedroom bay view',
        roomClass: 'SUITE',
      },
    ];
    const presidential = 'Bayfront Presidential Suite, View, Separate Living and Bedroom, Bay View';

    const loose = matchRoomType(presidential, suites, { attributeInference: false });
    expect(loose.roomTypeId).toBe('corner');
    expect(loose.method).toBe('ALIAS_FUZZY');

    const strict = matchRoomType(presidential, suites, {
      fuzzyMinSimilarity: 0.97,
      attributeInference: false,
    });
    expect(strict.roomTypeId).toBeNull();
    expect(strict.method).toBe('UNMATCHED');
  });

  it('can disable the attribute-vector step, which is coarse by design', () => {
    const suites: RoomTypeCandidate[] = [
      {
        roomTypeId: 'corner',
        normalizedName: 'corner suite 1 double',
        roomClass: 'SUITE',
        view: 'UNKNOWN',
      },
    ];
    // Same class, same bed, same view — the vector cannot tell these apart,
    // so with the fuzzy step off it must decline rather than guess.
    const opts = { fuzzyMinSimilarity: 0.97 };
    expect(matchRoomType('Presidential Suite 1 Double', suites, opts).method).toBe(
      'ATTRIBUTE_INFERRED',
    );
    expect(
      matchRoomType('Presidential Suite 1 Double', suites, {
        ...opts,
        attributeInference: false,
      }).method,
    ).toBe('UNMATCHED');
  });

  it('still merges genuine restatements of one room', () => {
    // The guards must not make the matcher useless: an exact restatement and
    // the source code path both still resolve.
    const one: RoomTypeCandidate[] = [
      {
        // As normalizeRoomName produces it: "guest room" is marketing filler.
        roomTypeId: '1',
        normalizedName: 'oceanfront 1 king',
        roomClass: 'ROOM',
        view: 'OCEAN',
        sourceCodes: ['OFK'],
      },
    ];
    const strict = { fuzzyMinSimilarity: 0.97, attributeInference: false };
    expect(matchRoomType('OCEANFRONT GUEST ROOM, 1 KING', one, strict).method).toBe('ALIAS_EXACT');
    expect(matchRoomType('Totally Different Text', one, strict, 'OFK').method).toBe('SOURCE_ID');
  });
});

describe('comparability classification', () => {
  it('produces twelve resolved classes', () => {
    expect(ALL_COMPARABILITY_CLASSES).toHaveLength(12);
    expect(new Set(ALL_COMPARABILITY_CLASSES).size).toBe(12);
  });

  it('separates flexible from restricted and board from room-only', () => {
    const flexBB = classifyComparability({
      mealPlan: 'BREAKFAST',
      refundPolicy: 'REFUNDABLE',
      audience: 'PUBLIC',
    });
    const restrictedRO = classifyComparability({
      mealPlan: 'ROOM_ONLY',
      refundPolicy: 'NON_REFUNDABLE',
      audience: 'PUBLIC',
    });
    expect(flexBB.comparabilityClass).not.toBe(restrictedRO.comparabilityClass);
    expect(flexBB.resolved).toBe(true);
  });

  it('collapses all board types into one group', () => {
    const half = classifyComparability({
      mealPlan: 'HALF_BOARD',
      refundPolicy: 'REFUNDABLE',
      audience: 'PUBLIC',
    });
    const all = classifyComparability({
      mealPlan: 'ALL_INCLUSIVE',
      refundPolicy: 'REFUNDABLE',
      audience: 'PUBLIC',
    });
    expect(half.comparabilityClass).toBe(all.comparabilityClass);
  });

  it('marks any UNKNOWN dimension as UNRESOLVED', () => {
    const result = classifyComparability({
      mealPlan: 'BREAKFAST',
      refundPolicy: 'UNKNOWN',
      audience: 'PUBLIC',
    });
    expect(result.comparabilityClass).toBe('UNRESOLVED');
    expect(result.resolved).toBe(false);
  });

  it('describes terms for the customer', () => {
    expect(
      describeRateTerms({
        mealPlan: 'BREAKFAST',
        refundPolicy: 'REFUNDABLE',
        audience: 'CONSORTIA',
      }),
    ).toBe('Breakfast included · Free cancellation · Preferred partner rate');

    expect(
      describeRateTerms({ mealPlan: 'UNKNOWN', refundPolicy: 'UNKNOWN', audience: 'UNKNOWN' }),
    ).toBe('Rate terms unconfirmed');
  });
});
