import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GRID_SPEC,
  backoffHours,
  gridLeadDays,
  planGridTopUp,
  type GridSpec,
} from '../../packages/data/src/repositories/collection.js';

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
  // Coordinates are part of the profile since the builder gained a distance
  // filter. Null here on purpose: these cases are about price and tier, and
  // an unplaceable pair must still be scored — the builder keeps it rather
  // than reading unknown distance as far.
  const hotel = (destinationId: number | null, tier: number | null, typical: number | null) => ({
    id: 1,
    destinationId,
    luxuryTier: tier,
    typicalNightlyMinor: typical,
    latitude: null,
    longitude: null,
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

/**
 * The stay grid is rebuilt from lead-time offsets on every run, so a stay that
 * yields nothing — sold out, or a hotel/date the API refuses with a 500 — looks
 * "missing" forever and is re-proposed on every single run. Measured on the
 * live set: 32 such stays, each costing a call plus its retries, indefinitely,
 * against an API whose rate limit is still unknown (U15).
 */
describe('collection backoff', () => {
  const spec = DEFAULT_GRID_SPEC;

  it('does not back off while a stay is still worth retrying', () => {
    // The first few failures are free: a transient fault should not exile a
    // stay that will work again on the next run.
    for (let n = 0; n < spec.backoffAfterFailures; n += 1) {
      expect(backoffHours(n, spec)).toBe(0);
    }
  });

  it('doubles the delay once a stay looks genuinely dead', () => {
    expect(backoffHours(3, spec)).toBe(1);
    expect(backoffHours(4, spec)).toBe(2);
    expect(backoffHours(5, spec)).toBe(4);
    expect(backoffHours(8, spec)).toBe(32);
  });

  it('caps the delay so a stay is never abandoned permanently', () => {
    // Inventory reopens and outages end. A week is the longest we will go
    // without asking again — and any success resets the counter to zero.
    expect(backoffHours(40, spec)).toBe(spec.backoffMaxHours);
    expect(backoffHours(1000, spec)).toBe(spec.backoffMaxHours);
    expect(spec.backoffMaxHours).toBeLessThanOrEqual(168);
  });

  it('is monotonic — more failures never means a sooner retry', () => {
    let previous = -1;
    for (let n = 0; n <= 50; n += 1) {
      const hours = backoffHours(n, spec);
      expect(hours).toBeGreaterThanOrEqual(previous);
      previous = hours;
    }
  });
});

/**
 * Grid coverage must tolerate ±1 day. The grid's lead times are relative to
 * today and no two of them differ by one day, so under an exact-date match
 * every UTC-day rollover makes the ENTIRE grid look untracked. Measured on
 * 2026-08-19, the first rollover after go-live: "690 new, 231 due", truncated
 * 421 stays at the run limit, starving the HOT-tier refreshes.
 */
describe('grid coverage tolerance', () => {
  const DAY = 86_400_000;
  const now = new Date('2026-08-19T06:00:00Z');
  const hotels = [{ id: 1, wahHotelId: '1198' }];
  const dateAt = (base: Date, days: number) =>
    new Date(base.getTime() + days * DAY).toISOString().slice(0, 10);

  /** One lead, one stay length — isolates the coverage rule itself. */
  const oneLead: GridSpec = {
    ...DEFAULT_GRID_SPEC,
    anchorLeadDays: [10],
    satelliteOffsetDays: [0],
    nights: [1],
  };
  const key = (days: number) => `1|${dateAt(now, days)}|1|2`;

  it('proposes the full grid on a cold start', () => {
    const out = planGridTopUp(hotels, new Set(), new Set(), DEFAULT_GRID_SPEC, now);
    expect(out.length).toBe(
      gridLeadDays(DEFAULT_GRID_SPEC).length * DEFAULT_GRID_SPEC.nights.length,
    );
  });

  it('treats a stay tracked one day either side as covering the wanted date', () => {
    for (const offset of [-1, 0, 1]) {
      const out = planGridTopUp(hotels, new Set([key(10 + offset)]), new Set(), oneLead, now);
      expect(out).toEqual([]);
    }
  });

  it('does not stretch coverage past one day', () => {
    for (const offset of [-2, 2]) {
      const out = planGridTopUp(hotels, new Set([key(10 + offset)]), new Set(), oneLead, now);
      expect(out.map((s) => s.checkIn)).toEqual([dateAt(now, 10)]);
    }
  });

  it("covers today's whole grid with yesterday's — the rollover regression", () => {
    // Yesterday's collection, transplanted forward one day: exactly what the
    // tracked set looks like at the first run after a UTC-day rollover.
    const yesterday = new Date(now.getTime() - DAY);
    const seen = new Set<string>();
    for (const lead of gridLeadDays(DEFAULT_GRID_SPEC)) {
      for (const nights of DEFAULT_GRID_SPEC.nights) {
        seen.add(`1|${dateAt(yesterday, lead)}|${nights}|${DEFAULT_GRID_SPEC.adults}`);
      }
    }
    expect(planGridTopUp(hotels, seen, new Set(), DEFAULT_GRID_SPEC, now)).toEqual([]);
  });

  it('never lets one tracked stay satisfy two distinct grid leads', () => {
    // Adjacent grid leads are ≥3 days apart, so a tracked stay between two
    // wanted dates can sit within tolerance of at most one of them.
    const twoLeads: GridSpec = { ...oneLead, anchorLeadDays: [10, 13] };
    const out = planGridTopUp(hotels, new Set([key(11)]), new Set(), twoLeads, now);
    expect(out.map((s) => s.checkIn)).toEqual([dateAt(now, 13)]);
  });

  it('keys backoff by grid slot, so it holds across the daily date shift', () => {
    // Slot key is hotel|lead|nights|adults. The same backed-off slot must be
    // skipped today AND tomorrow, even though the wanted DATE differs — keyed
    // by date, the skip evaporated at every rollover and the failure counter
    // could never outlast the 6-hour cron.
    const slot = new Set(['1|10|1|2']);
    expect(planGridTopUp(hotels, new Set(), slot, oneLead, now)).toEqual([]);
    const tomorrow = new Date(now.getTime() + DAY);
    expect(planGridTopUp(hotels, new Set(), slot, oneLead, tomorrow)).toEqual([]);
  });

  it('does not let one backed-off slot suppress a different slot', () => {
    const twoLeads: GridSpec = { ...oneLead, anchorLeadDays: [10, 13] };
    const out = planGridTopUp(hotels, new Set(), new Set(['1|10|1|2']), twoLeads, now);
    expect(out.map((s) => s.checkIn)).toEqual([dateAt(now, 13)]);
  });

  it('matches nights and adults exactly — tolerance is about dates only', () => {
    const wrongNights = new Set([`1|${dateAt(now, 10)}|3|2`]);
    const out = planGridTopUp(hotels, wrongNights, new Set(), oneLead, now);
    expect(out.map((s) => s.checkIn)).toEqual([dateAt(now, 10)]);
  });
});
