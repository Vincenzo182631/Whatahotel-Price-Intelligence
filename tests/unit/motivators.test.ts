/**
 * Motivator assessment: the verdict, and the evidence that earns it.
 *
 * Owner requirement (2026-09-18). What is pinned here is the constraint that
 * makes the inference defensible at all: a verdict never renders without the
 * evidence beside it, and no evidence means LIMITED_EVIDENCE rather than a
 * quiet no.
 */
import { describe, expect, it } from 'vitest';
import { assessMotivators } from '../../packages/core/src/explanation/motivators.js';

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
