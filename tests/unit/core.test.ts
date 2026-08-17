import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';
import { validateConfig, withConfig } from '../../packages/core/src/config/schema.js';
import { fFreshness, fVolatility, fVolume } from '../../packages/core/src/confidence/confidence.js';
import {
  nightlyFromTotal,
  pctBelow,
  roundHalfAwayFromZero,
  money,
} from '../../packages/core/src/money.js';
import {
  coefficientOfVariation,
  percentile,
  percentileRank,
  percentileRankFromLadder,
  theilSenSlope,
  trimOutliers,
  weightedGeometricMean,
} from '../../packages/core/src/stats.js';

describe('money', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money(689.5, 'USD')).toThrow(TypeError);
  });

  it('rounds half away from zero, matching Postgres round(numeric)', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
  });

  it('derives nightly from a stay total the same way the DB column does', () => {
    expect(nightlyFromTotal(206700, 3)).toBe(68900);
    expect(nightlyFromTotal(100000, 3)).toBe(33333);
  });

  it('rejects a zero or negative night count', () => {
    expect(() => nightlyFromTotal(1000, 0)).toThrow(RangeError);
  });

  it('computes percentage below a reference', () => {
    expect(pctBelow(68900, 74800)).toBeCloseTo(7.888, 2);
  });
});

describe('stats', () => {
  it('interpolates percentiles like percentile_cont', () => {
    const values = [10, 20, 30, 40];
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 0.5)).toBe(25);
    expect(percentile(values, 1)).toBe(40);
  });

  it('uses mid-rank for ties in percentileRank', () => {
    // Without mid-rank handling a rate sitting on the modal price would score
    // either 0 or 100 depending on comparison direction.
    expect(percentileRank([10, 20, 20, 30], 20)).toBe(0.5);
    expect(percentileRank([10, 20, 30], 5)).toBe(0);
    expect(percentileRank([10, 20, 30], 35)).toBe(1);
  });

  it('agrees between raw values and the summary ladder', () => {
    const ladder = { min: 100, p10: 120, p25: 140, p50: 160, p75: 190, p90: 220, max: 260 };
    expect(percentileRankFromLadder(ladder, 160)).toBeCloseTo(0.5, 5);
    expect(percentileRankFromLadder(ladder, 90)).toBe(0);
    expect(percentileRankFromLadder(ladder, 300)).toBe(1);
  });

  it('resists a single outlier in the trend slope on a well-populated window', () => {
    const clean = Array.from({ length: 8 }, (_, i) => ({ x: i, y: 100 + i * 10 }));
    const spiked = [...clean.slice(0, 7), { x: 7, y: 900 }];
    expect(theilSenSlope(clean)).toBeCloseTo(10, 5);
    // Least squares over `spiked` gives ≈ 71; Theil–Sen holds at the true slope.
    expect(theilSenSlope(spiked)).toBeCloseTo(10, 5);
  });

  it('is NOT fully robust at the 4-point minimum with an endpoint spike', () => {
    // Documented limitation, not an aspiration. With 4 points, an outlier at the
    // endpoint contaminates 3 of the 6 pairwise slopes, which is enough to move
    // the median. Raising score.trend.minSeriesPoints to 6 would remove this;
    // flagged for calibration rather than changed unilaterally.
    const spiked = [
      { x: 0, y: 100 },
      { x: 1, y: 110 },
      { x: 2, y: 120 },
      { x: 3, y: 900 },
    ];
    expect(theilSenSlope(spiked)).toBeGreaterThan(60);
  });

  it('trims outliers by percentile', () => {
    const values = [1, 50, 51, 52, 53, 1000];
    const { kept, removed } = trimOutliers(values, 0.1, 0.9);
    expect(removed).toBeGreaterThan(0);
    expect(kept).not.toContain(1000);
  });

  it('lets a single zero factor annihilate the geometric mean', () => {
    // This is the entire reason confidence uses a geometric mean.
    expect(
      weightedGeometricMean([
        { value: 0.95, weight: 0.9 },
        { value: 0, weight: 0.1 },
      ]),
    ).toBe(0);
  });

  it('computes a coefficient of variation', () => {
    expect(coefficientOfVariation([100, 100, 100])).toBe(0);
    expect(coefficientOfVariation([50, 150])).toBeCloseTo(0.5, 5);
  });
});

describe('confidence factors', () => {
  it('saturates volume logarithmically', () => {
    expect(fVolume(0, DEFAULT_CONFIG)).toBe(0);
    expect(fVolume(12, DEFAULT_CONFIG)).toBeGreaterThan(0.5);
    expect(fVolume(60, DEFAULT_CONFIG)).toBeCloseTo(1, 5);
    expect(fVolume(1000, DEFAULT_CONFIG)).toBe(1);
  });

  it('decays freshness piecewise and floors it', () => {
    expect(fFreshness(1, DEFAULT_CONFIG)).toBe(1);
    expect(fFreshness(6, DEFAULT_CONFIG)).toBe(1);
    expect(fFreshness(72, DEFAULT_CONFIG)).toBeCloseTo(0.2, 5);
    expect(fFreshness(500, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.confidence.freshFloor);
    expect(fFreshness(40, DEFAULT_CONFIG)).toBeLessThan(fFreshness(20, DEFAULT_CONFIG));
  });

  it('floors volatility rather than zeroing it', () => {
    // High volatility makes a percentile fragile, not false.
    expect(fVolatility(0, DEFAULT_CONFIG)).toBe(1);
    expect(fVolatility(5, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.confidence.volatilityFloor);
  });
});

describe('config validation', () => {
  it('accepts the defaults', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual([]);
  });

  it('rejects deal-score weights that do not sum to 1', () => {
    const bad = withConfig({ score: { weight: { f1Historical: 0.5 } } });
    expect(validateConfig(bad).some((i) => i.includes('sum to 1.0'))).toBe(true);
  });

  it('rejects a config still carrying the retired rec.wait block', () => {
    // A v3-or-earlier document loaded against a v4 engine. Silently ignoring
    // the block would leave someone believing thresholds were in force that
    // nothing reads any more.
    const stale = {
      ...DEFAULT_CONFIG,
      rec: { ...DEFAULT_CONFIG.rec, wait: { confidenceMin: 70, scoreMax: 42 } },
    } as unknown as typeof DEFAULT_CONFIG;
    expect(validateConfig(stale).some((i) => i.includes('retired'))).toBe(true);
  });

  it('does not carry a WAIT verdict anywhere in the shipped config', () => {
    expect(JSON.stringify(DEFAULT_CONFIG)).not.toContain('wait');
  });

  it('rejects non-descending score bands', () => {
    const bad = withConfig({ score: { band: { goodMin: 95 } } });
    expect(validateConfig(bad).some((i) => i.includes('strictly descending'))).toBe(true);
  });

  it('keeps the urgency bar below the strong-deal bar', () => {
    // G3 exists to catch a merely good rate that is about to become
    // unavailable, so its score threshold must sit below G2's or it never fires.
    expect(DEFAULT_CONFIG.rec.book.urgencyScoreMin).toBeLessThan(DEFAULT_CONFIG.rec.book.scoreMin);
  });
});

describe('config seed', () => {
  it('matches DEFAULT_CONFIG exactly', () => {
    const sql = readFileSync(
      new URL('../../db/seeds/002_scoring_config.sql', import.meta.url),
      'utf8',
    );
    const match = sql.match(/\$config\$([\s\S]*?)\$config\$/);
    expect(match, 'seed file must contain a $config$-quoted JSON document').not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  });
});
