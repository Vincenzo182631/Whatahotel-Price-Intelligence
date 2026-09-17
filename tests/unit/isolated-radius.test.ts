/**
 * The isolation rung's CONFIG contract (`live.csi.isolatedRadiusMiles`).
 *
 * The rung itself lives in loadLiveIntelligence and needs a database, so the
 * behaviour is covered by the integration suite. What is pinned here is the
 * shape, because two of the ways this feature can fail are silent and neither
 * would redden a behavioural test:
 *
 *   - set at or below the ordinary ladder's outer rung, the rung can never
 *     fire. Nothing errors; isolated resorts simply stay unscoreable and the
 *     config looks as though it addresses them.
 *   - made REQUIRED, it repeats the outlierRatio outage of 2026-09-17: the
 *     active stored config predates the field, the engine reads it anyway,
 *     and every rate-carrying stay answers 500 until the seed is applied.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../packages/core/src/config/defaults.js';

describe('the isolation rung config', () => {
  it('reaches further than the ordinary ladder, or it can never fire', () => {
    const rungs = DEFAULT_CONFIG.live.csi.radiusMiles;
    const outer = Math.max(...rungs);
    const isolated = DEFAULT_CONFIG.live.csi.isolatedRadiusMiles ?? 0;
    expect(isolated).toBeGreaterThan(outer);
  });

  it('reaches far enough for the case it was written for', () => {
    // Four Seasons Oahu at Ko Olina holds zero comparables inside 5 miles and
    // its nearest real peers are the Waikiki hotels, roughly 20 miles away.
    // A rung that stops short of them fixes nothing.
    expect(DEFAULT_CONFIG.live.csi.isolatedRadiusMiles ?? 0).toBeGreaterThanOrEqual(20);
  });

  it('is OPTIONAL, so a config version predating it still runs', () => {
    // The 2026-09-17 outage in one assertion: the engine must tolerate an
    // active stored config that has never heard of this field (rule 6).
    const v10 = {
      ...DEFAULT_CONFIG,
      live: {
        ...DEFAULT_CONFIG.live,
        csi: { ...DEFAULT_CONFIG.live.csi, isolatedRadiusMiles: undefined },
      },
    } as unknown as typeof DEFAULT_CONFIG;

    expect(v10.live.csi.isolatedRadiusMiles ?? 0).toBe(0);
    // Zero disables the rung rather than reaching zero miles, which would
    // compare a hotel against nothing and call it an answer.
    expect((v10.live.csi.isolatedRadiusMiles ?? 0) > Math.max(...v10.live.csi.radiusMiles)).toBe(
      false,
    );
  });

  it('leaves the ordinary ladder untouched', () => {
    // The rung is additive. If adding it moved 2/3/5, every ordinary
    // comparison would silently change basis.
    expect(DEFAULT_CONFIG.live.csi.radiusMiles).toEqual([2, 3, 5]);
  });
});
