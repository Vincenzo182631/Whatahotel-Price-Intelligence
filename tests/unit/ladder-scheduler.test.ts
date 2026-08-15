import { describe, expect, it } from 'vitest';

import {
  dowBucketFor,
  leadBucketFor,
  seasonBandFor,
  selectBaselineLevel,
} from '../../packages/core/src/baseline/ladder.js';
import {
  DEFAULT_SCHEDULER_OPTIONS,
  intervalHoursFor,
  isDue,
  tierFor,
} from '../../packages/ingest/src/scheduler/tiers.js';
import { similarityBetween } from '../../packages/ingest/src/comparables/builder.js';

describe('lead-time bucketing', () => {
  it('assigns buckets across the range', () => {
    expect(leadBucketFor(0)).toBe('0-3');
    expect(leadBucketFor(3)).toBe('0-3');
    expect(leadBucketFor(4)).toBe('4-7');
    expect(leadBucketFor(30)).toBe('15-30');
    expect(leadBucketFor(31)).toBe('31-60');
    expect(leadBucketFor(365)).toBe('121+');
  });

  it('clamps negative lead times rather than throwing', () => {
    expect(leadBucketFor(-5)).toBe('0-3');
  });
});

describe('stay stratification', () => {
  it('treats Friday and Saturday nights as the weekend rate', () => {
    // 2026-09-18 is a Friday.
    expect(dowBucketFor('2026-09-18')).toBe('WEEKEND');
    expect(dowBucketFor('2026-09-19')).toBe('WEEKEND');
    expect(dowBucketFor('2026-09-20')).toBe('WEEKDAY');
    expect(dowBucketFor('2026-09-16')).toBe('WEEKDAY');
  });

  it('assigns a season band to every month', () => {
    const bands = new Set(
      Array.from({ length: 12 }, (_, i) =>
        seasonBandFor(`2026-${String(i + 1).padStart(2, '0')}-15`),
      ),
    );
    expect(bands.has('UNKNOWN')).toBe(false);
    expect(bands.size).toBeGreaterThan(1);
  });
});

describe('the widening ladder', () => {
  const candidate = (level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4', n: number) => ({
    level,
    nObservations: n,
  });

  it('takes the most specific level that reaches the target', () => {
    const result = selectBaselineLevel(
      [candidate('L0', 45), candidate('L1', 120), candidate('L3', 400)],
      12,
      30,
    );
    expect(result.level).toBe('L0');
    expect(result.reachedTarget).toBe(true);
  });

  it('climbs when the specific level is too thin', () => {
    const result = selectBaselineLevel(
      [candidate('L0', 5), candidate('L1', 9), candidate('L2', 60)],
      12,
      30,
    );
    expect(result.level).toBe('L2');
    expect(result.rejected.map((r) => r.level)).toEqual(['L0', 'L1']);
  });

  it('climbs past a usable-but-thin level to one that reaches the target', () => {
    // L0 has 15 — above the absolute floor but below the target of 30 — so the
    // ladder keeps climbing. The looseness is paid for by the L3 confidence
    // multiplier, while the larger sample raises f_volume. That trade is the
    // designed behaviour (docs/mvp/01 §6), not an accident.
    const result = selectBaselineLevel([candidate('L0', 15), candidate('L3', 400)], 12, 30);
    expect(result.level).toBe('L3');
    expect(result.reachedTarget).toBe(true);
  });

  it('falls back to the most specific usable level when none reaches the target', () => {
    const result = selectBaselineLevel([candidate('L0', 15), candidate('L3', 20)], 12, 30);
    expect(result.level).toBe('L0');
    expect(result.reachedTarget).toBe(false);
  });

  it('returns the richest candidate when nothing is usable, so the caller can say how short it fell', () => {
    const result = selectBaselineLevel([candidate('L0', 2), candidate('L3', 7)], 12, 30);
    expect(result.selected?.nObservations).toBe(7);
    expect(result.reachedTarget).toBe(false);
  });

  it('returns nothing when there are no candidates at all', () => {
    const result = selectBaselineLevel([], 12, 30);
    expect(result.selected).toBeNull();
    expect(result.level).toBeNull();
  });
});

describe('collection scheduling', () => {
  const opts = DEFAULT_SCHEDULER_OPTIONS;

  it('treats near-term stays as HOT', () => {
    expect(tierFor(5, null, opts)).toBe('HOT');
    expect(tierFor(30, null, opts)).toBe('HOT');
    expect(tierFor(31, null, opts)).toBe('WARM');
    expect(tierFor(200, null, opts)).toBe('COLD');
  });

  it('promotes a recently viewed stay to HOT regardless of lead time', () => {
    expect(tierFor(90, 2, opts)).toBe('HOT');
    expect(tierFor(90, 30, opts)).toBe('WARM');
  });

  it('never-observed stays are always due', () => {
    expect(isDue(null, 'COLD', new Date(), opts)).toBe(true);
  });

  it("respects each tier's interval", () => {
    const now = new Date('2026-08-15T12:00:00Z');
    const threeHoursAgo = new Date(now.getTime() - 3 * 3_600_000).toISOString();
    const eightHoursAgo = new Date(now.getTime() - 8 * 3_600_000).toISOString();

    expect(isDue(threeHoursAgo, 'HOT', now, opts)).toBe(false);
    expect(isDue(eightHoursAgo, 'HOT', now, opts)).toBe(true);
    expect(isDue(eightHoursAgo, 'WARM', now, opts)).toBe(false);

    expect(intervalHoursFor('HOT', opts)).toBeLessThan(intervalHoursFor('WARM', opts));
    expect(intervalHoursFor('WARM', opts)).toBeLessThan(intervalHoursFor('COLD', opts));
  });
});

describe('comparable similarity', () => {
  const hotel = (destinationId: number | null, tier: number | null, typical: number | null) => ({
    id: 1,
    destinationId,
    luxuryTier: tier,
    typicalNightlyMinor: typical,
  });

  it('is zero across destinations', () => {
    expect(similarityBetween(hotel(1, 5, 70000), { ...hotel(2, 5, 70000), id: 2 })).toBe(0);
  });

  it('is zero without a price level to compare', () => {
    expect(similarityBetween(hotel(1, 5, null), { ...hotel(1, 5, 70000), id: 2 })).toBe(0);
  });

  it('rewards similar price and tier', () => {
    const close = similarityBetween(hotel(1, 5, 70000), { ...hotel(1, 5, 72000), id: 2 });
    const distant = similarityBetween(hotel(1, 5, 70000), { ...hotel(1, 3, 130000), id: 3 });
    expect(close).toBeGreaterThan(distant);
    expect(close).toBeLessThanOrEqual(1);
    expect(distant).toBeGreaterThanOrEqual(0);
  });
});
