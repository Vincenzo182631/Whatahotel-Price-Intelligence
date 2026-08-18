import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, analyze, withConfig } from '../../packages/core/src/index.js';
import {
  bookNowRegret,
  coverage,
  factorCorrelation,
  pearson,
  scoreDistribution,
  scoreStability,
  type Trial,
} from '../../packages/calibration/src/metrics.js';
import { computeLoss, normalize, type WeightVector } from '../../packages/calibration/src/sweep.js';
import {
  NOW,
  checkInWithLeadDays,
  makeBaseline,
  makeComparables,
  makeCurrent,
  makeQuery,
  makeSeries,
} from '../support/fixtures.js';

// ── trial fixtures ─────────────────────────────────────────────────────────

let seq = 0;

function trial(over: Partial<Trial> & { recommendation: string }): Trial {
  seq += 1;
  const current = over.currentNightlyMinor ?? 70000;
  return {
    target: {
      hotelId: 1,
      wahHotelId: 'H1',
      hotelName: 'Test Hotel',
      destinationId: 1,
      roomTypeId: 1,
      roomTypeName: 'King',
      comparabilityClass: 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC',
      checkIn: '2026-10-01',
      nights: 3,
      adults: 2,
      children: 0,
      currency: 'USD',
    },
    asOf: `2026-09-${String((seq % 27) + 1).padStart(2, '0')}T12:00:00Z`,
    gateFired: 'G5',
    dealScore: 50,
    dealScoreBand: 'FAIR',
    confidence: 80,
    confidenceBand: 'HIGH',
    currentNightlyMinor: current,
    baselineLevel: 'L0',
    nObservations: 60,
    factorScores: {},
    outcome: {
      nObservations: 5,
      minNightlyMinor: current,
      maxNightlyMinor: current,
      lastNightlyMinor: current,
      horizonEnd: '2026-09-30T00:00:00Z',
    },
    ...over,
  };
}

function repeat(n: number, factory: (i: number) => Trial): Trial[] {
  return Array.from({ length: n }, (_, i) => factory(i));
}

// ── regression guard: the F1/F5 dependency is gone ─────────────────────────

describe('demand is no longer a scoring factor', () => {
  it('never appears in the factor breakdown', () => {
    // F5 was an affine function of F1 — score_F5 = (50 − 50D) + D·score_F1 —
    // so it double-counted rather than adding a sixth perspective. Removed in
    // config v2. This guards against it being reintroduced by accident.
    const { analysis } = analyze(
      {
        query: makeQuery(),
        current: makeCurrent(68900),
        baseline: makeBaseline({
          n: 60,
          ladder: [
            [0, 60000],
            [1, 90000],
          ],
        }),
        series: [],
        comparables: [],
        benefits: [],
        demand: { events: [{ name: 'Big event', impactScore: 0.9 }], roomsLeft: 2 },
        now: NOW,
      },
      DEFAULT_CONFIG,
    );

    const codes = analysis.factors.map((f) => f.code);
    expect(codes).toEqual(['F1', 'F2', 'F3', 'F4', 'F6']);
    expect(codes).not.toContain('F5');
  });

  it('still moves the recommendation through gate G3, independently of F1', () => {
    // Demand keeps doing real work — it just acts on the recommendation rather
    // than on the score, so it cannot double-count the percentile.
    const base = {
      query: makeQuery({ checkIn: checkInWithLeadDays(60) }),
      // A rate well above typical, so the score is poor either way.
      current: makeCurrent(88000),
      baseline: makeBaseline({
        n: 80,
        ladder: [
          [0, 55000],
          [0.5, 66000],
          [1, 92000],
        ],
      }),
      series: makeSeries({ points: 8, spanDays: 7, endMinor: 88000, deltaFraction: -0.03 }),
      comparables: makeComparables({ count: 6, index: 1.0, baselineMedianMinor: 66000 }),
      benefits: [],
      now: NOW,
    };

    const quiet = analyze({ ...base, demand: null }, DEFAULT_CONFIG);
    const pressured = analyze(
      { ...base, demand: { events: [{ name: 'Sell-out event', impactScore: 0.9 }] } },
      DEFAULT_CONFIG,
    );

    // Identical score — demand no longer touches it.
    expect(pressured.analysis.dealScore).toBe(quiet.analysis.dealScore);
    // And it reaches the decision trace, which is where G3 reads it.
    expect(pressured.analysis.decisionTrace.demandPressure).toBeGreaterThan(
      quiet.analysis.decisionTrace.demandPressure as number,
    );
  });
});

// ── metrics ────────────────────────────────────────────────────────────────

describe('pearson correlation', () => {
  it('is 1 for a perfect positive relationship', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
  });
  it('is -1 for a perfect inverse relationship', () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 6);
  });
  it('is 0 for a constant series and for undersized inputs', () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBe(0);
    expect(pearson([1, 2], [3, 4])).toBe(0);
  });
});

describe('score distribution', () => {
  it('reports INSUFFICIENT_SAMPLE rather than guessing', () => {
    const result = scoreDistribution(
      repeat(5, () => trial({ recommendation: 'CONSIDER' })),
      DEFAULT_CONFIG,
    );
    expect(result.status).toBe('INSUFFICIENT_SAMPLE');
  });

  it('fails when the mean has drifted off target', () => {
    const skewed = repeat(60, (i) =>
      trial({ recommendation: 'BOOK_NOW', dealScore: 90 + (i % 5), dealScoreBand: 'EXCELLENT' }),
    );
    const result = scoreDistribution(skewed, DEFAULT_CONFIG);
    expect(result.status).toBe('FAIL');
    expect(result.value).toBeGreaterThan(80);
  });

  it('warns when the model is not discriminating', () => {
    const flat = repeat(60, () => trial({ recommendation: 'CONSIDER', dealScore: 50 }));
    expect(scoreDistribution(flat, DEFAULT_CONFIG).status).toBe('WARN');
  });

  it('passes a well-spread distribution centred near target', () => {
    const spread = repeat(60, (i) =>
      trial({ recommendation: 'CONSIDER', dealScore: 15 + ((i * 7) % 70) }),
    );
    expect(scoreDistribution(spread, DEFAULT_CONFIG).status).toBe('PASS');
  });
});

describe('factor correlation', () => {
  it('flags a duplicated pair', () => {
    const trials = repeat(60, (i) =>
      trial({
        recommendation: 'CONSIDER',
        factorScores: { F1: i, F2: i, F3: (i * 13) % 97 },
      }),
    );
    const result = factorCorrelation(trials, DEFAULT_CONFIG);
    expect(result.status).toBe('FAIL');
    expect(result.detail).toContain('F1/F2');
  });

  it('passes when factors are independent', () => {
    const trials = repeat(80, (i) =>
      trial({
        recommendation: 'CONSIDER',
        factorScores: { F1: (i * 37) % 101, F2: (i * 61) % 89 },
      }),
    );
    expect(factorCorrelation(trials, DEFAULT_CONFIG).status).not.toBe('FAIL');
  });
});

describe('BOOK_NOW regret', () => {
  const regretting = (n: number, share: number) =>
    repeat(n, (i) =>
      trial({
        recommendation: 'BOOK_NOW',
        currentNightlyMinor: 70000,
        outcome: {
          nObservations: 4,
          // A later low well under the booked rate is a regret.
          minNightlyMinor: i < n * share ? 60000 : 70500,
          maxNightlyMinor: 75000,
          lastNightlyMinor: 71000,
          horizonEnd: '2026-09-30T00:00:00Z',
        },
      }),
    );

  it('fails above the target rate', () => {
    const result = bookNowRegret(regretting(60, 0.4), DEFAULT_CONFIG);
    expect(result.status).toBe('FAIL');
    expect(result.value).toBeCloseTo(0.4, 1);
  });

  it('passes below the target rate', () => {
    expect(bookNowRegret(regretting(60, 0.05), DEFAULT_CONFIG).status).toBe('PASS');
  });

  it('ignores a drop smaller than the material threshold', () => {
    const trivial = repeat(60, () =>
      trial({
        recommendation: 'BOOK_NOW',
        currentNightlyMinor: 70000,
        outcome: {
          nObservations: 4,
          minNightlyMinor: 69900, // 0.14% — noise, not a missed opportunity
          maxNightlyMinor: 70500,
          lastNightlyMinor: 70000,
          horizonEnd: '2026-09-30T00:00:00Z',
        },
      }),
    );
    expect(bookNowRegret(trivial, DEFAULT_CONFIG).value).toBe(0);
  });

  it('excludes trials whose outcome cannot be observed', () => {
    const unobservable = repeat(60, () =>
      trial({
        recommendation: 'BOOK_NOW',
        outcome: {
          nObservations: 0,
          minNightlyMinor: null,
          maxNightlyMinor: null,
          lastNightlyMinor: null,
          horizonEnd: '2026-09-30T00:00:00Z',
        },
      }),
    );
    expect(bookNowRegret(unobservable, DEFAULT_CONFIG).status).toBe('INSUFFICIENT_SAMPLE');
  });
});

// The WAIT success metric went with WAIT itself in config v4: with no such
// recommendation there are no trials to measure, and a metric that can only
// ever report an empty sample is noise in a calibration report.

describe('score stability', () => {
  const series = (deltas: readonly number[], priceMovePct = 0) =>
    deltas.map((score, i) =>
      trial({
        recommendation: 'CONSIDER',
        dealScore: score,
        currentNightlyMinor: Math.round(70000 * (1 + (priceMovePct / 100) * i)),
        asOf: `2026-09-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
      }),
    );

  it('measures drift when the price barely moved', () => {
    const trials = series(
      Array.from({ length: 40 }, (_, i) => 50 + (i % 2 === 0 ? 0 : 2)),
      0.2,
    );
    const result = scoreStability(trials, DEFAULT_CONFIG);
    expect(result.status).toBe('PASS');
    expect(result.sampleSize).toBeGreaterThanOrEqual(30);
  });

  it('fails on large swings with a flat price', () => {
    const trials = series(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 20 : 80)));
    expect(scoreStability(trials, DEFAULT_CONFIG).status).toBe('FAIL');
  });

  it('ignores pairs where the price genuinely moved', () => {
    // A score that changes because the rate changed is the model working.
    const trials = series(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 20 : 80)),
      5,
    );
    expect(scoreStability(trials, DEFAULT_CONFIG).status).toBe('INSUFFICIENT_SAMPLE');
  });
});

describe('coverage', () => {
  it('fails when too many queries cannot be scored', () => {
    const trials = [
      ...repeat(40, () =>
        trial({ recommendation: 'INSUFFICIENT_DATA', dealScore: null, dealScoreBand: null }),
      ),
      ...repeat(60, () => trial({ recommendation: 'CONSIDER' })),
    ];
    const result = coverage(trials, DEFAULT_CONFIG);
    expect(result.status).toBe('FAIL');
    expect(result.value).toBeCloseTo(0.4, 2);
  });

  it('passes at good coverage', () => {
    const trials = [
      ...repeat(5, () =>
        trial({ recommendation: 'INSUFFICIENT_DATA', dealScore: null, dealScoreBand: null }),
      ),
      ...repeat(95, () => trial({ recommendation: 'CONSIDER' })),
    ];
    expect(coverage(trials, DEFAULT_CONFIG).status).toBe('PASS');
  });
});

// ── sweep ──────────────────────────────────────────────────────────────────

describe('weight normalization', () => {
  const sum = (w: WeightVector) => Object.values(w).reduce((a, b) => a + b, 0);

  it('always sums to exactly 1.0, as validateConfig requires', () => {
    const cases: WeightVector[] = [
      {
        f1Historical: 0.3,
        f2Market: 0.25,
        f3Trend: 0.15,
        f4Seasonality: 0.1,
        f6Value: 0.1,
      },
      {
        f1Historical: 0.9,
        f2Market: 0.1,
        f3Trend: 0.1,
        f4Seasonality: 0.1,
        f6Value: 0.1,
      },
      { f1Historical: 1, f2Market: 0, f3Trend: 0, f4Seasonality: 0, f6Value: 0 },
      {
        f1Historical: 0.333,
        f2Market: 0.333,
        f3Trend: 0.333,
        f4Seasonality: 0,
        f6Value: 0,
      },
    ];
    for (const c of cases) {
      expect(Math.abs(sum(normalize(c)) - 1)).toBeLessThan(1e-9);
    }
  });

  it('clamps negatives and survives an all-zero vector', () => {
    const negative = normalize({
      f1Historical: -1,
      f2Market: 0.5,
      f3Trend: 0.5,
      f4Seasonality: 0,
      f6Value: 0,
    });
    expect(negative.f1Historical).toBe(0);
    expect(Math.abs(sum(negative) - 1)).toBeLessThan(1e-9);

    const zero = normalize({
      f1Historical: 0,
      f2Market: 0,
      f3Trend: 0,
      f4Seasonality: 0,
      f6Value: 0,
    });
    expect(Math.abs(sum(zero) - 1)).toBeLessThan(1e-9);
  });

  it('produces a vector validateConfig accepts', () => {
    const weights = normalize({
      f1Historical: 0.37,
      f2Market: 0.21,
      f3Trend: 0.19,
      f4Seasonality: 0.07,
      f6Value: 0.11,
    });
    expect(() => withConfig({ score: { weight: weights } })).not.toThrow();
  });
});

describe('loss', () => {
  const metric = (key: string, value: number | null, status: 'PASS' | 'INSUFFICIENT_SAMPLE') => ({
    key,
    title: key,
    status,
    value,
    target: '',
    sampleSize: 100,
    detail: '',
  });

  it('counts only the terms it could actually judge', () => {
    const loss = computeLoss(
      [
        metric('score_distribution', 50, 'PASS'),
        metric('factor_correlation', null, 'INSUFFICIENT_SAMPLE'),
        metric('book_now_regret', null, 'INSUFFICIENT_SAMPLE'),
        metric('wait_success', null, 'INSUFFICIENT_SAMPLE'),
        metric('coverage', 0.1, 'PASS'),
      ],
      DEFAULT_CONFIG,
    );
    expect(loss.terms).toBe(2);
    expect(loss.counted).toEqual(['score_distribution', 'coverage']);
  });

  it('is infinite when nothing could be judged, so it never ranks as best', () => {
    const loss = computeLoss([metric('coverage', null, 'INSUFFICIENT_SAMPLE')], DEFAULT_CONFIG);
    expect(loss.value).toBe(Number.POSITIVE_INFINITY);
    expect(loss.terms).toBe(0);
  });

  it('weights BOOK_NOW regret double — it is the failure a customer feels', () => {
    const withRegret = computeLoss(
      [metric('book_now_regret', 1.0, 'PASS'), metric('coverage', 0.1, 'PASS')],
      DEFAULT_CONFIG,
    );
    expect(withRegret.terms).toBe(3);
  });

  it('is zero when every judged metric sits at target', () => {
    const config = withConfig({});
    const loss = computeLoss(
      [
        metric('score_distribution', config.calibration.targetScoreMean, 'PASS'),
        metric('factor_correlation', 0.1, 'PASS'),
        metric('book_now_regret', 0.0, 'PASS'),
        metric('coverage', 0.0, 'PASS'),
      ],
      config,
    );
    expect(loss.value).toBe(0);
    // Four metrics, with book_now_regret counted twice.
    expect(loss.terms).toBe(5);
  });
});
