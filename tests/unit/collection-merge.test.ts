/**
 * How one run's limit is split three ways.
 *
 * Every side of this has a starvation failure mode, and each one is silent:
 * starved refreshes let stored rates go stale until confidence collapses on
 * hotels whose scores are fine (measured 2026-08-27); a starved grid freezes
 * the tracked set, which empties after ~90 days with every run still exiting
 * 0 (rule 14); starved warming means the stays guests actually open are the
 * only ones nobody collects. So the allocation is pinned rather than trusted.
 */

import { describe, expect, it } from 'vitest';

import { mergeTasks } from '../../packages/ingest/src/scheduler/merge.js';
import type { CollectionTask } from '../../packages/ingest/src/scheduler/tiers.js';

const task = (id: number, reason: string, checkIn = '2026-12-01'): CollectionTask => ({
  hotelId: id,
  wahHotelId: String(1000 + id),
  checkIn,
  nights: 3,
  adults: 2,
  tier: 'HOT',
  lastObservedAt: null,
  reason,
});

const many = (n: number, reason: string, offset = 0): CollectionTask[] =>
  Array.from({ length: n }, (_, i) => task(offset + i, reason));

/**
 * Each queue gets its own id space below, so an allocation test measures
 * allocation. Overlap is a real case — the same stay can be wanted, missing
 * AND due — and it has its own test rather than quietly skewing these.
 */
const OPTS = { refreshShare: 0.5, warmTasks: [], warmShare: 0.2 };

describe('splitting a run between grid, refresh and warming', () => {
  it('serves guest-requested stays first', () => {
    const plan = mergeTasks(many(100, 'NEW_STAY'), many(100, 'DUE', 2000), 100, {
      ...OPTS,
      warmTasks: many(10, 'GUEST_REQUESTED', 5000),
    });
    expect(plan.tasks.slice(0, 10).every((t) => t.reason === 'GUEST_REQUESTED')).toBe(true);
    expect(plan.warmTaken).toBe(10);
  });

  it('caps warming so it can never starve the grid', () => {
    // Rule 14: without grid top-up the tracked set freezes and empties after
    // ~90 days, with every run still reporting success.
    const plan = mergeTasks(many(100, 'NEW_STAY'), [], 100, {
      ...OPTS,
      warmTasks: many(100, 'GUEST_REQUESTED', 5000),
    });
    expect(plan.warmTaken).toBe(20);
    expect(plan.tasks.filter((t) => t.reason === 'NEW_STAY')).toHaveLength(80);
  });

  it('hands back what warming does not use', () => {
    // A floor, not a quota: a run nobody browsed spends nothing on warming.
    const plan = mergeTasks(many(100, 'NEW_STAY'), many(100, 'DUE', 2000), 100, OPTS);
    expect(plan.warmTaken).toBe(0);
    expect(plan.tasks).toHaveLength(100);
    expect(plan.tasks.filter((t) => t.reason === 'DUE')).toHaveLength(50);
  });

  it('still guarantees refreshes their share of what is left', () => {
    const plan = mergeTasks(many(100, 'NEW_STAY'), many(100, 'DUE', 2000), 100, {
      ...OPTS,
      warmTasks: many(20, 'GUEST_REQUESTED', 5000),
    });
    // 20 warmed, 80 left, half of which is reserved for refreshes.
    expect(plan.tasks.filter((t) => t.reason === 'DUE')).toHaveLength(40);
    expect(plan.tasks.filter((t) => t.reason === 'NEW_STAY')).toHaveLength(40);
  });

  it('counts a stay once, under the strongest reason for fetching it', () => {
    // One fetch satisfies all three queues. Counting it twice would reserve a
    // slot for work already being done; filing it under the weaker reason
    // would hide the demand warming exists to follow.
    const shared = task(1, 'GUEST_REQUESTED');
    const plan = mergeTasks(
      [{ ...shared, reason: 'NEW_STAY' }],
      [{ ...shared, reason: 'DUE' }],
      10,
      {
        ...OPTS,
        warmTasks: [shared],
      },
    );
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.reason).toBe('GUEST_REQUESTED');
    expect(plan.total).toBe(1);
  });

  it('never exceeds the limit, whatever each queue holds', () => {
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0],
      [5, 5, 5],
      [1000, 1000, 1000],
      [0, 1000, 0],
      [1000, 0, 0],
      [0, 0, 1000],
    ];
    for (const [g, d, w] of cases) {
      const plan = mergeTasks(many(g, 'NEW_STAY'), many(d, 'DUE', 2000), 100, {
        ...OPTS,
        warmTasks: many(w, 'GUEST_REQUESTED', 5000),
      });
      expect(plan.tasks.length).toBeLessThanOrEqual(100);
    }
  });

  it('spends the whole limit whenever there is work for it', () => {
    const plan = mergeTasks(many(30, 'NEW_STAY'), many(200, 'DUE', 2000), 100, {
      ...OPTS,
      warmTasks: many(5, 'GUEST_REQUESTED', 5000),
    });
    expect(plan.tasks).toHaveLength(100);
  });
});
