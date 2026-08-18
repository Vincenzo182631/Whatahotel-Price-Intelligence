/**
 * Edge paths in the scoring factors and the recommendation engine.
 *
 * These are the branches the scenario suite does not naturally reach — the
 * defensive ones. They matter precisely because they only fire when something
 * has already gone wrong upstream.
 */

import { describe, expect, it } from 'vitest';

import { analyze } from '../../packages/core/src/analyze.js';
import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';
import { recommend } from '../../packages/core/src/recommendation/engine.js';
import { composeDealScore } from '../../packages/core/src/scoring/dealScore.js';
import {
  computeF2,
  computeF3,
  computeF4,
  computeDemandPressure,
  computeF6,
} from '../../packages/core/src/scoring/factors.js';
import type {
  BaselineDistribution,
  FactorResult,
  RecommendationResult,
  ScoringInput,
} from '../../packages/core/src/types.js';
import {
  NOW,
  checkInWithLeadDays,
  makeBaseline,
  makeComparables,
  makeCurrent,
  makeQuery,
  makeSeries,
} from '../support/fixtures.js';

const baseline: BaselineDistribution = makeBaseline({
  n: 60,
  ladder: [
    [0, 60000],
    [0.5, 75000],
    [1, 95000],
  ],
});

describe('F2 · market comparison edge paths', () => {
  it('is unavailable without a baseline median to index against', () => {
    const r = computeF2(
      makeCurrent(70000),
      null,
      makeComparables({ count: 6, index: 1, baselineMedianMinor: 75000 }),
      DEFAULT_CONFIG,
    );
    expect(r.factor.available).toBe(false);
    expect(r.factor.unavailableReason).toBe('NO_BASELINE');
  });

  it('is unavailable below the minimum comparable count', () => {
    const r = computeF2(
      makeCurrent(70000),
      baseline,
      makeComparables({ count: 2, index: 1, baselineMedianMinor: 75000 }),
      DEFAULT_CONFIG,
    );
    expect(r.factor.available).toBe(false);
    expect(r.factor.unavailableReason).toBe('INSUFFICIENT_COMPARABLES');
    expect(r.compCount).toBe(2);
  });

  it('discards comparables missing a price or a baseline', () => {
    const comps = [
      ...makeComparables({ count: 3, index: 1, baselineMedianMinor: 75000 }),
      {
        hotelId: 'broken',
        hotelName: 'Broken',
        currentNightlyMinor: 0,
        baselineMedianMinor: 0,
        observedAt: '2026-08-14T09:00:00Z',
      },
    ];
    const r = computeF2(makeCurrent(70000), baseline, comps, DEFAULT_CONFIG);
    expect(r.compCount).toBe(3);
  });
});

describe('F3 · trend edge paths', () => {
  it('is unavailable below the minimum point count', () => {
    const r = computeF3(
      makeSeries({ points: 2, spanDays: 7, endMinor: 70000, deltaFraction: 0.1 }),
      NOW,
      DEFAULT_CONFIG,
    );
    expect(r.factor.available).toBe(false);
    expect(r.factor.unavailableReason).toBe('INSUFFICIENT_SERIES_POINTS');
    expect(r.pointsUsed).toBe(2);
  });

  it('ignores points older than the window', () => {
    const old = makeSeries({
      points: 8,
      spanDays: 7,
      endMinor: 70000,
      deltaFraction: 0.1,
      endAt: new Date(NOW.getTime() - 30 * 86_400_000),
    });
    expect(computeF3(old, NOW, DEFAULT_CONFIG).factor.available).toBe(false);
  });

  it('refuses to divide by a zero opening price', () => {
    const series = [
      { observedAt: new Date(NOW.getTime() - 6 * 86_400_000).toISOString(), nightlyMinor: 0 },
      { observedAt: new Date(NOW.getTime() - 4 * 86_400_000).toISOString(), nightlyMinor: 100 },
      { observedAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(), nightlyMinor: 200 },
      { observedAt: NOW.toISOString(), nightlyMinor: 300 },
    ];
    expect(computeF3(series, NOW, DEFAULT_CONFIG).factor.available).toBe(false);
  });

  it('accepts a window override', () => {
    const r = computeF3(
      makeSeries({ points: 10, spanDays: 30, endMinor: 70000, deltaFraction: 0.2 }),
      NOW,
      DEFAULT_CONFIG,
      30,
    );
    expect(r.factor.available).toBe(true);
    expect(r.deltaPct).toBeGreaterThan(0);
  });
});

describe('F4 · seasonality', () => {
  it('is unavailable without input', () => {
    expect(computeF4(null, DEFAULT_CONFIG).unavailableReason).toBe('INSUFFICIENT_HISTORY');
  });

  it('is unavailable below the history requirement', () => {
    const r = computeF4(
      { seasonalIndex: 0.8, historyDays: 100, seasonBand: 'LOW' },
      DEFAULT_CONFIG,
    );
    expect(r.available).toBe(false);
  });

  it('rewards a structurally cheap season once a full cycle exists', () => {
    const r = computeF4(
      { seasonalIndex: 0.8, historyDays: 400, seasonBand: 'LOW' },
      DEFAULT_CONFIG,
    );
    expect(r.available).toBe(true);
    expect(r.subScore).toBe(80); // 50 + (1 - 0.8) * 150
  });
});

describe('demand pressure (formerly factor F5)', () => {
  it('is no longer a scoring factor', () => {
    // Removed in config v2: it was an affine function of F1 and carried no
    // independent signal. Demand now reaches the verdict only through guard W4
    // and gate G3. See packages/core/src/scoring/factors.ts.
    const signal = computeDemandPressure({ compSoldOutShare: 1 });
    expect(signal).not.toHaveProperty('factor');
    expect(Object.keys(signal).sort()).toEqual(['demandPressure', 'events', 'hasSignal']);
  });

  it('distinguishes "no signal" from "signal shows no demand"', () => {
    const none = computeDemandPressure(null);
    expect(none.hasSignal).toBe(false);
    expect(none.demandPressure).toBe(0);

    const quiet = computeDemandPressure({ roomsLeft: 10 });
    expect(quiet.hasSignal).toBe(true);
    expect(quiet.demandPressure).toBe(0);
  });

  it('derives pressure from scarcity, sell-out share and booking velocity', () => {
    expect(computeDemandPressure({ roomsLeft: 1 }).demandPressure).toBeCloseTo(0.9, 5);
    expect(computeDemandPressure({ compSoldOutShare: 0.7 }).demandPressure).toBeCloseTo(0.7, 5);
    expect(computeDemandPressure({ bookingVelocityPercentile: 0.8 }).demandPressure).toBeCloseTo(
      0.8,
      5,
    );
  });

  it('takes the strongest available signal and collects event names', () => {
    const signal = computeDemandPressure({
      events: [{ name: 'Art Basel', impactScore: 0.5 }],
      roomsLeft: 1,
    });
    expect(signal.demandPressure).toBeCloseTo(0.9, 5);
    expect(signal.events).toEqual(['Art Basel']);
  });
});

describe('F6 · effective value', () => {
  const query = makeQuery();

  it('is unavailable with no benefits', () => {
    expect(computeF6(makeCurrent(70000), query, [], DEFAULT_CONFIG).factor.unavailableReason).toBe(
      'NO_BENEFITS',
    );
  });

  it('caps an implausible benefit valuation', () => {
    const r = computeF6(
      makeCurrent(70000),
      query,
      [
        {
          code: 'ABSURD',
          displayName: 'Absurd credit',
          basis: 'PER_NIGHT',
          valueMinor: 500000,
          realizationFactor: 1,
        },
      ],
      DEFAULT_CONFIG,
    );
    expect(r.wasCapped).toBe(true);
    expect(r.benefitValuePerNightMinor).toBe(70000 * DEFAULT_CONFIG.score.value.benefitCapPct);
  });

  it('spreads a per-stay benefit across the nights', () => {
    const r = computeF6(
      makeCurrent(70000),
      makeQuery({ nights: 4 }),
      [
        {
          code: 'HOTEL_CREDIT',
          displayName: 'Credit',
          basis: 'PER_STAY',
          valueMinor: 10000,
          realizationFactor: 0.8,
        },
      ],
      DEFAULT_CONFIG,
    );
    expect(r.benefitValuePerNightMinor).toBe(2000); // 10000 * 0.8 / 4
    expect(r.effectiveNightlyMinor).toBe(68000);
  });
});

describe('deal score composition', () => {
  const factor = (over: Partial<FactorResult>): FactorResult => ({
    code: 'F1',
    name: 'x',
    available: true,
    subScore: 50,
    rawValue: 0,
    unit: 'SCORE',
    weight: 0.33,
    weightApplied: 0,
    unavailableReason: null,
    ...over,
  });

  it('returns null when F1 is unavailable, however good the rest look', () => {
    const result = composeDealScore(
      [
        factor({ code: 'F1', available: false, subScore: null }),
        factor({ code: 'F2', weight: 0.28, subScore: 100 }),
        factor({ code: 'F3', weight: 0.17, subScore: 100 }),
        factor({ code: 'F4', weight: 0.11, subScore: 100 }),
        factor({ code: 'F6', weight: 0.11, subScore: 100 }),
      ],
      DEFAULT_CONFIG,
    );
    expect(result.score).toBeNull();
  });

  it('returns null below the minimum weight coverage', () => {
    const result = composeDealScore(
      [
        factor({ code: 'F1', weight: 0.33, subScore: 90 }),
        factor({ code: 'F2', weight: 0.28, available: false, subScore: null }),
        factor({ code: 'F3', weight: 0.17, available: false, subScore: null }),
        factor({ code: 'F4', weight: 0.11, available: false, subScore: null }),
        factor({ code: 'F6', weight: 0.11, available: false, subScore: null }),
      ],
      DEFAULT_CONFIG,
    );
    expect(result.weightCoverage).toBeCloseTo(0.33, 5);
    expect(result.score).toBeNull();
  });

  it('handles an empty factor list without dividing by zero', () => {
    const result = composeDealScore([], DEFAULT_CONFIG);
    expect(result.score).toBeNull();
    expect(result.weightCoverage).toBe(0);
  });
});

describe('WAIT is retired', () => {
  // These are exactly the inputs that used to route to gate G4: a poor score,
  // high confidence, a long lead time, a falling price, no demand, no scarcity.
  // Every one of the eight never-WAIT guards evaluated clear on this case —
  // it was the engine's one legitimate path to telling a customer to hold off.
  const formerWaitCase = {
    dealScore: 20,
    confidence: 90,
    current: makeCurrent(70000),
    baseline,
    weightCoverage: 0.8,
    matchQuality: 0.95,
    leadTimeDays: 60,
    trendPct: -5,
    demandPressure: 0,
    volatilityFactor: 0.9,
    now: NOW,
  };

  it('lands on CONSIDER via G5 where it used to land on WAIT via G4', () => {
    const result = recommend(formerWaitCase, DEFAULT_CONFIG);
    expect(result.recommendation).toBe('CONSIDER');
    expect(result.gateFired).toBe('G5');
  });

  it('stays on CONSIDER no matter how confident or how far out the stay is', () => {
    for (const confidence of [70, 85, 100]) {
      for (const leadTimeDays of [10, 60, 180]) {
        for (const trendPct of [-20, -5, 0]) {
          const result = recommend(
            { ...formerWaitCase, confidence, leadTimeDays, trendPct },
            DEFAULT_CONFIG,
          );
          expect(result.recommendation as string).not.toBe('WAIT');
        }
      }
    }
  });

  it('still reaches BOOK_NOW through the urgency gate on scarce inventory', () => {
    // Scarcity used to do double duty: block WAIT (W5) and trigger urgency
    // (G3). Only the second job remains, and it must still work.
    const result = recommend(
      {
        ...formerWaitCase,
        dealScore: 65,
        current: makeCurrent(70000, { roomsLeft: 2 }),
      },
      DEFAULT_CONFIG,
    );
    expect(result.recommendation).toBe('BOOK_NOW');
    expect(result.gateFired).toBe('G3');
  });
});

/**
 * Regression for a bug the property suite found only intermittently, because
 * it was unseeded: f_volatility scored an UNMEASURABLE spread as perfect
 * stability, so confidence FELL as the second observation arrived.
 */
describe('volatility is excluded when it cannot be measured', () => {
  const inputAt = (n: number): ScoringInput => ({
    query: makeQuery({ checkIn: checkInWithLeadDays(30), nights: 1 }),
    current: makeCurrent(20000, { totalMinor: 20000, observedAt: NOW.toISOString() }),
    baseline: makeBaseline({
      n,
      ladder: [
        [0, 16000],
        [0.5, 20000],
        [1, 24000],
      ],
    }),
    series: [],
    comparables: [],
    benefits: [],
    demand: null,
    now: NOW,
  });

  const volatilityOf = (n: number) =>
    analyze(inputAt(n), DEFAULT_CONFIG).analysis.confidenceFactors.find(
      (f) => f.code === 'f_volatility',
    );

  it('is not counted at a single observation', () => {
    const factor = volatilityOf(1);
    expect(factor?.included).toBe(false);
    expect(factor?.weight).toBe(0);
    // The specific defect: it was included at value 1.0 — a perfect score
    // awarded for having no data at all.
    expect(factor?.included === true && factor.value === 1).toBe(false);
  });

  it('is counted from two observations onward', () => {
    expect(volatilityOf(2)?.included).toBe(true);
    expect(volatilityOf(2)?.weight).toBe(DEFAULT_CONFIG.confidence.weight.volatility);
  });

  it('confidence never falls as the sample grows', () => {
    const series = [1, 2, 3, 4, 5, 6, 8, 10, 16, 24].map(
      (n) => analyze(inputAt(n), DEFAULT_CONFIG).analysis.confidence,
    );
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i]).toBeGreaterThanOrEqual(series[i - 1] as number);
    }
  });
});

describe('analyze · degenerate inputs', () => {
  it('reports INSUFFICIENT_DATA with no baseline at all', () => {
    const { analysis } = analyze(
      {
        query: makeQuery({ checkIn: checkInWithLeadDays(30) }),
        current: makeCurrent(70000),
        baseline: null,
        series: [],
        comparables: [],
        benefits: [],
        now: NOW,
      },
      DEFAULT_CONFIG,
    );
    expect(analysis.recommendation).toBe('INSUFFICIENT_DATA');
    expect(analysis.dealScore).toBeNull();
    expect(analysis.baseline.nObservations).toBe(0);
  });

  it('reports INSUFFICIENT_DATA on a rate older than the staleness limit', () => {
    const { analysis } = analyze(
      {
        query: makeQuery({ checkIn: checkInWithLeadDays(30) }),
        current: makeCurrent(70000, {
          observedAt: new Date(NOW.getTime() - 100 * 3_600_000).toISOString(),
        }),
        baseline,
        series: makeSeries({ points: 6, spanDays: 7, endMinor: 70000, deltaFraction: 0 }),
        comparables: makeComparables({ count: 5, index: 1, baselineMedianMinor: 75000 }),
        benefits: [],
        now: NOW,
      },
      DEFAULT_CONFIG,
    );
    expect(analysis.recommendation).toBe('INSUFFICIENT_DATA');
    expect(analysis.caveatCodes).toContain('STALE_DATA');
  });
});
