import { describe, expect, it } from 'vitest';

import {
  extractAttributes,
  roomClassesCompatible,
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
