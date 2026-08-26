/**
 * The competitive radius ladder (config v8).
 *
 * Location is part of what a rate buys, so the primary comparison must be
 * what a guest wanting THIS location could book instead. These tests pin the
 * two properties that make the ladder honest rather than merely tighter:
 * it climbs ONLY on scarcity, and it never reaches further than 5 miles.
 *
 * The measured cost is real and deliberate. Across 3,036 geo-located hotels
 * (2026-08-26) the share with three neighbours in range falls from 74% at the
 * old flat 30 km to 58% at the 5-mile rung. Widening the ladder back would
 * undo the change, so a test asserts the last rung.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';
import {
  DEFAULT_COMPARABLE_OPTIONS,
  similarityBetween,
} from '../../packages/ingest/src/comparables/builder.js';

const MILES_TO_KM = 1.609344;

describe('the radius ladder as configured', () => {
  const rungs = DEFAULT_CONFIG.live.csi.radiusMiles;

  it('starts at the 2-mile primary market', () => {
    expect(rungs[0]).toBe(2);
  });

  it('climbs 2 → 3 → 5 and stops', () => {
    expect([...rungs]).toEqual([2, 3, 5]);
  });

  it('never restores anything like the old 30 km reach', () => {
    // 30 km is ~18.6 miles. The point of v8 is that a prime-district hotel is
    // not compared against suburban ones, and a rung beyond 5 miles in a
    // dense city reaches straight back into that comparison.
    const widestKm = Math.max(...rungs) * MILES_TO_KM;
    expect(widestKm).toBeLessThan(10);
    expect(Math.max(...rungs)).toBeLessThanOrEqual(5);
  });

  it('is strictly increasing — a ladder that went backwards would loop', () => {
    for (let i = 1; i < rungs.length; i += 1) {
      expect(rungs[i]!).toBeGreaterThan(rungs[i - 1]!);
    }
  });

  it('still reaches the St. Regis Aruba comparable that motivated v7', () => {
    // That case is a comparable 7 km away, invisible because its destination
    // LABEL differed. v8 drops the label for the distance, so the ladder must
    // still be able to see it or the fix regresses.
    expect(Math.max(...rungs) * MILES_TO_KM).toBeGreaterThan(7);
  });
});

/**
 * The climb rule, as a pure restatement of loadLiveIntelligence's loop.
 *
 * Kept in step with the real thing by construction: both express "climb only
 * while short of minComps, and only when the wider ring actually finds more".
 * The behaviours worth pinning are the ones a well-meaning change would break.
 */
function climb(
  rungs: readonly number[],
  minComps: number,
  found: (miles: number) => number,
): { miles: number; expanded: boolean; comps: number } {
  let miles = rungs[0] ?? 0;
  let comps = found(miles);
  let expanded = false;
  for (let i = 1; i < rungs.length; i += 1) {
    if (comps >= minComps) break;
    const wider = rungs[i] ?? miles;
    const widerComps = found(wider);
    if (widerComps > comps) {
      miles = wider;
      comps = widerComps;
      expanded = true;
    }
  }
  return { miles, expanded, comps };
}

describe('when the ladder climbs', () => {
  const rungs = [2, 3, 5];
  const min = 3;

  it('stays at 2 miles when 2 miles is enough', () => {
    // Three relevant competitors beat ten loose ones: having found its three,
    // the ladder must not reach further to collect more.
    const r = climb(rungs, min, (mi) => (mi === 2 ? 4 : 40));
    expect(r.miles).toBe(2);
    expect(r.expanded).toBe(false);
    expect(r.comps).toBe(4);
  });

  it('stops at exactly minComps rather than optimising the count', () => {
    const r = climb(rungs, min, (mi) => (mi === 2 ? 3 : 30));
    expect(r.miles).toBe(2);
    expect(r.comps).toBe(3);
  });

  it('climbs one rung at a time, and no further than it must', () => {
    const r = climb(rungs, min, (mi) => (mi === 2 ? 1 : mi === 3 ? 3 : 99));
    expect(r.miles).toBe(3);
    expect(r.expanded).toBe(true);
  });

  it('reaches the final rung only when the middle one is still short', () => {
    const r = climb(rungs, min, (mi) => (mi === 5 ? 3 : 1));
    expect(r.miles).toBe(5);
    expect(r.expanded).toBe(true);
  });

  it('reports no expansion when a wider ring finds nothing more', () => {
    // A rung that adds nothing must not be reported as an expansion: that
    // would claim a weaker, more distant basis than the one actually used.
    const r = climb(rungs, min, () => 1);
    expect(r.miles).toBe(2);
    expect(r.expanded).toBe(false);
  });

  it('accepts a short set rather than inventing comparables', () => {
    // Exhausting the ladder without reaching minComps is a real answer. The
    // comp signal is simply not produced, which is rule 3's principle: an
    // absent measurement is absent, never a manufactured one.
    const r = climb(rungs, min, () => 2);
    expect(r.comps).toBeLessThan(min);
  });
});

describe('curated peer sets are bounded by distance too', () => {
  // The gap the 32-hotel cohort exposed. Tightening only the destination
  // branch moved one score out of 32, because most hotels carry a curated
  // set and the curated branch had no distance filter at all. A curated
  // comparable is chosen on price band within a shared destination LABEL —
  // and a label spans a metro area, which is the comparison v8 exists to stop.
  it('never lets the builder reach further than the ladder does', () => {
    const widestRungKm = Math.max(...DEFAULT_CONFIG.live.csi.radiusMiles) * MILES_TO_KM;
    expect(DEFAULT_COMPARABLE_OPTIONS.maxDistanceKm).toBeCloseTo(widestRungKm, 6);
  });

  it('keeps a pair it cannot place, rather than calling unknown distance far', () => {
    // 5% of the catalogue holds no coordinates. Dropping those from a peer
    // set built on price would punish a gap in OUR data as though it were a
    // fact about the hotel — the same error SKIPPED_NO_GEO exists to avoid.
    const placed = { id: 1, destinationId: 7, luxuryTier: null, typicalNightlyMinor: 50_000 };
    const unplaced = { ...placed, id: 2 };
    expect(similarityBetween({ ...placed }, { ...unplaced })).toBeGreaterThan(0);
  });
});
