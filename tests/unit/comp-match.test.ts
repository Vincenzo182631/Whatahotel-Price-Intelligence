/**
 * The tolerant cross-hotel comparison key, and the confidence it may earn.
 *
 * The key exists because the production comparability class is the source's own
 * rate-plan identity and so is hotel-specific: measured over 40 real stays,
 * every competitor survived every other filter and none survived the class
 * filter. See packages/core/src/normalize/compMatch.ts.
 *
 * The tests that matter most here are the ones asserting what tolerance does
 * NOT permit. A key that quietly matched a known-refundable rate to a
 * known-non-refundable one would produce comparisons that look authoritative
 * and are wrong, which is worse than the empty comp set it replaced.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';
import {
  compMatchKey,
  compMatchStrength,
  unknownDimensions,
  type CompMatchTerms,
} from '../../packages/core/src/normalize/compMatch.js';
import { assessLiveConfidence } from '../../packages/core/src/scoring/liveScore.js';
import type {
  CalendarResult,
  CompSetResult,
  CompressionResult,
} from '../../packages/core/src/scoring/liveSignals.js';

const RESOLVED: CompMatchTerms = {
  mealPlan: 'ROOM_ONLY',
  refundPolicy: 'REFUNDABLE',
  audience: 'PUBLIC',
};

describe('the tolerant comparison key', () => {
  it('matches two rates whose terms are equally unstated', () => {
    const a: CompMatchTerms = {
      mealPlan: 'ROOM_ONLY',
      refundPolicy: 'UNKNOWN',
      audience: 'CONSORTIA',
    };
    const b: CompMatchTerms = {
      mealPlan: 'ROOM_ONLY',
      refundPolicy: 'UNKNOWN',
      audience: 'CONSORTIA',
    };
    expect(compMatchKey(a)).toBe(compMatchKey(b));
  });

  it('NEVER matches an unstated term to a stated one', () => {
    // The whole argument for tolerance rests on this. Symmetric ignorance is a
    // fair comparison; ignorance against knowledge is a false equivalence.
    const unknown: CompMatchTerms = { ...RESOLVED, refundPolicy: 'UNKNOWN' };
    const known: CompMatchTerms = { ...RESOLVED, refundPolicy: 'NON_REFUNDABLE' };
    expect(compMatchKey(unknown)).not.toBe(compMatchKey(known));
  });

  it('never merges rates whose stated terms genuinely differ', () => {
    const refundable: CompMatchTerms = { ...RESOLVED, refundPolicy: 'REFUNDABLE' };
    const nonRefundable: CompMatchTerms = { ...RESOLVED, refundPolicy: 'NON_REFUNDABLE' };
    const breakfast: CompMatchTerms = { ...RESOLVED, mealPlan: 'BREAKFAST' };
    expect(compMatchKey(refundable)).not.toBe(compMatchKey(nonRefundable));
    expect(compMatchKey(RESOLVED)).not.toBe(compMatchKey(breakfast));
  });

  it('never produces the UNRESOLVED sentinel — an unstated term is a value here', () => {
    const allUnknown: CompMatchTerms = {
      mealPlan: 'UNKNOWN',
      refundPolicy: 'UNKNOWN',
      audience: 'UNKNOWN',
    };
    expect(compMatchKey(allUnknown)).not.toContain('UNRESOLVED');
  });

  it('grades strength by how much the source actually stated', () => {
    expect(compMatchStrength(RESOLVED)).toBe('RESOLVED');
    expect(compMatchStrength({ ...RESOLVED, refundPolicy: 'UNKNOWN' })).toBe('PARTIAL');
    expect(
      compMatchStrength({ mealPlan: 'UNKNOWN', refundPolicy: 'UNKNOWN', audience: 'UNKNOWN' }),
    ).toBe('OPAQUE');
  });

  it('names the unstated dimensions in words a customer could read', () => {
    expect(unknownDimensions({ ...RESOLVED, refundPolicy: 'UNKNOWN' })).toEqual([
      'cancellation terms',
    ]);
    expect(unknownDimensions(RESOLVED)).toEqual([]);
  });
});

// ── confidence ────────────────────────────────────────────────────────────

function compSet(over: Partial<CompSetResult> = {}): CompSetResult {
  return {
    signal: {
      code: 'S1_COMP_SET',
      name: 'Comparable hotels',
      available: true,
      subScore: 70,
      weight: 0.45,
      weightApplied: 0.45,
      unavailableReason: null,
    },
    matchStrength: 'RESOLVED',
    unknownDimensions: [],
    termsBasis: 'MATCHED',
    radiusExpanded: false,
    csi: 95,
    band: 'MARKET_RATE',
    pctBelowMedian: 5,
    medianCompetitorNightlyMinor: 100_00,
    compsUsed: 6,
    compsExcluded: 0,
    ...over,
  };
}

const calendar = {
  signal: {
    code: 'S2_CALENDAR',
    name: 'Nearby dates',
    available: true,
    subScore: 60,
    weight: 0.35,
    weightApplied: 0.35,
    unavailableReason: null,
  },
  deltaPct: -5,
  band: 'DIP',
  medianNearbyNightlyMinor: 105_00,
  neighboursUsed: 6,
  sameDowOnly: true,
} as unknown as CalendarResult;

const compression = {
  signal: {
    code: 'S3_COMPRESSION',
    name: 'Market compression',
    available: true,
    subScore: 50,
    weight: 0.2,
    weightApplied: 0.2,
    unavailableReason: null,
  },
  soldOutShare: 0.2,
  band: 'NORMAL',
  checked: 8,
  soldOut: 2,
} as unknown as CompressionResult;

describe('confidence reflects how much the comparison rested on stated terms', () => {
  const assess = (cs: CompSetResult) =>
    assessLiveConfidence(cs, calendar, compression, 1, DEFAULT_CONFIG);

  it('reaches HIGH only on a fully resolved match', () => {
    expect(assess(compSet({ matchStrength: 'RESOLVED' }))).toBe('HIGH');
  });

  it('lets a partial match reach HIGH — symmetric ignorance is a fair comparison', () => {
    // This assertion was inverted in config v8, deliberately.
    //
    // HIGH used to require RESOLVED: every rate term stated on both sides.
    // But this source never states refundability for ANY hotel, so the gate
    // was unreachable for the entire catalogue — measured over 10 production
    // hotels, 6 MEDIUM / 4 LOW / 0 HIGH. A gate no evidence can open is not a
    // confidence signal, it is a constant, and it told the customer nothing
    // about the comparison actually in front of them.
    //
    // PARTIAL is a different thing from weak. The tolerant key matches
    // UNKNOWN only to UNKNOWN, so a PARTIAL match means the dimension is
    // unstated on BOTH sides — which is exactly the symmetric ignorance
    // rule 5 argues is fair.
    const partial = compSet({
      matchStrength: 'PARTIAL',
      unknownDimensions: ['cancellation terms'],
      compsUsed: 50,
    });
    expect(assess(partial)).toBe('HIGH');
  });

  it('still caps below HIGH when the local market could not supply the set', () => {
    // The replacement gate, and the reason this is not simply a loosening: a
    // comp set the radius ladder had to climb for is a weaker statement about
    // THIS location than one the primary ring supplied.
    const stretched = compSet({ matchStrength: 'PARTIAL', radiusExpanded: true, compsUsed: 50 });
    expect(assess(stretched)).toBe('MEDIUM');
  });

  it('caps below HIGH on too few competitors however tight the ring', () => {
    const thin = compSet({ matchStrength: 'RESOLVED', compsUsed: 3 });
    expect(assess(thin)).toBe('MEDIUM');
  });

  it('drops an opaque match to LOW', () => {
    const opaque = compSet({
      matchStrength: 'OPAQUE',
      unknownDimensions: ['meal plan', 'cancellation terms', 'rate audience'],
      compsUsed: 20,
    });
    expect(assess(opaque)).toBe('LOW');
  });

  it('still reports LOW when there is no comp set at all', () => {
    const none = compSet({
      signal: { ...compSet().signal, available: false, subScore: null },
      compsUsed: 0,
    });
    expect(assess(none)).toBe('LOW');
  });
});
