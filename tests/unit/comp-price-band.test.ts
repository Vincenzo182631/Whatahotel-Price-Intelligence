/**
 * The price-tier outlier guard (config `live.csi.outlierRatio`).
 *
 * Matching the room class, the view and the rate terms establishes that two
 * rates describe the same PRODUCT. It cannot establish that they are sold in
 * the same MARKET. These tests pin both halves of that: a hotel in a different
 * price tier is set aside, and a hotel merely dearer or cheaper than its peers
 * is emphatically NOT — the second is the signal the index exists to report.
 */
import { describe, expect, it } from 'vitest';
import {
  computeCompSetIndex,
  computePremiumJustification,
} from '../../packages/core/src/scoring/liveSignals.js';
import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';
import type { CompetitorRate } from '../../packages/core/src/scoring/liveSignals.js';

const NOW = new Date('2026-09-17T12:00:00Z');

function comp(nightlyMinor: number, hotelId = String(nightlyMinor)): CompetitorRate {
  return {
    hotelId,
    name: `Hotel ${hotelId}`,
    nightlyMinor,
    observedAt: '2026-09-17T11:00:00Z',
    isAvailable: true,
  };
}

const MATCH = { strength: 'RESOLVED' as const, unknown: [], roomMatch: 'CLASS' as const };

describe('the price-tier guard', () => {
  it('sets aside a hotel a third of the subject price, matching room or not', () => {
    // Halekulani at $889 against three real peers and one airport hotel.
    const r = computeCompSetIndex(
      88_900,
      [comp(85_000), comp(92_000), comp(79_000), comp(20_000, 'airport')],
      DEFAULT_CONFIG,
      NOW,
      MATCH,
    );
    expect(r.compsUsed).toBe(3);
    expect(r.compsExcludedOutlier).toBe(1);
    // The median is the three real peers', untouched by the airport hotel.
    expect(r.medianCompetitorNightlyMinor).toBe(85_000);
  });

  it('sets aside a hotel several times the subject price — the flattering direction', () => {
    const r = computeCompSetIndex(
      88_900,
      [comp(85_000), comp(92_000), comp(79_000), comp(900_000, 'villa')],
      DEFAULT_CONFIG,
      NOW,
      MATCH,
    );
    expect(r.compsUsed).toBe(3);
    expect(r.compsExcludedOutlier).toBe(1);
    expect(r.medianCompetitorNightlyMinor).toBe(85_000);
  });

  it('does NOT trim a genuine premium — the widest real reading survives intact', () => {
    // Four Seasons Paris George V against a half-collected market read 45%
    // above. A guard that touched that would delete the signal it guards.
    const r = computeCompSetIndex(
      320_000,
      [comp(220_000), comp(225_000), comp(215_000)],
      DEFAULT_CONFIG,
      NOW,
      MATCH,
    );
    expect(r.compsExcludedOutlier).toBe(0);
    expect(r.compsUsed).toBe(3);
    expect(Math.round(r.csi as number)).toBe(145);
  });

  it('does NOT trim a genuine bargain either', () => {
    const r = computeCompSetIndex(
      50_000,
      [comp(120_000), comp(125_000), comp(118_000)],
      DEFAULT_CONFIG,
      NOW,
      MATCH,
    );
    expect(r.compsExcludedOutlier).toBe(0);
    expect(r.band).toBe('STRONG_VALUE');
  });

  it('reports INSUFFICIENT rather than answering from out-of-tier hotels', () => {
    // Two real peers and three airport hotels. Before the guard this answered
    // from five; the answer would have described the wrong market.
    const r = computeCompSetIndex(
      88_900,
      [comp(85_000), comp(20_000, 'a'), comp(21_000, 'b'), comp(19_000, 'c')],
      DEFAULT_CONFIG,
      NOW,
      MATCH,
    );
    expect(r.signal.available).toBe(false);
    expect(r.signal.unavailableReason).toBe('INSUFFICIENT_COMPARABLES');
    expect(r.csi).toBeNull();
    expect(r.compsExcludedOutlier).toBe(3);
  });

  it('counts rate-less and out-of-tier exclusions separately', () => {
    const soldOut: CompetitorRate = { ...comp(84_000, 'soldout'), isAvailable: false };
    const r = computeCompSetIndex(
      88_900,
      [comp(85_000), comp(92_000), comp(79_000), comp(20_000, 'airport'), soldOut],
      DEFAULT_CONFIG,
      NOW,
      MATCH,
    );
    expect(r.compsExcluded).toBe(1);
    expect(r.compsExcludedOutlier).toBe(1);
    expect(r.compsUsed).toBe(3);
  });

  it('measures the premium against the same hotels the index compared against', () => {
    // If the premium used a different pool, the percentage a guest reads would
    // be a premium over a market they were never shown.
    const comps = [comp(85_000), comp(92_000), comp(79_000), comp(20_000, 'airport')];
    const index = computeCompSetIndex(88_900, comps, DEFAULT_CONFIG, NOW, MATCH);
    const premium = computePremiumJustification(88_900, null, comps, DEFAULT_CONFIG);
    expect(premium.compsPriced).toBe(index.compsUsed);
    // 88,900 against a median of 85,000 — a few percent, not the 100%+ the
    // airport hotel would have manufactured.
    expect(Math.round(premium.premiumPct as number)).toBe(5);
  });
});
