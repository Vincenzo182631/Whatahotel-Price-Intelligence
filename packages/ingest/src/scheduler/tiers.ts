/**
 * Collection scheduling (docs/mvp/01 §5).
 *
 * Not all stays deserve equal attention. The cost of collection scales with the
 * Cartesian product of hotels × check-in dates × lengths of stay × occupancies,
 * so the scheduler's job is to spend the call budget where it changes an answer.
 */

import { db, type Queryable } from '@wahpi/data';

export type CollectionTier = 'HOT' | 'WARM' | 'COLD';

export interface TierPolicy {
  readonly tier: CollectionTier;
  readonly intervalHours: number;
}

export interface SchedulerOptions {
  readonly hotIntervalHours: number;
  readonly warmIntervalHours: number;
  readonly coldIntervalHours: number;
  readonly hotLeadDaysMax: number;
  readonly hotViewedWithinDays: number;
  readonly horizonDays: number;
  readonly maxTasks: number;
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  hotIntervalHours: 6,
  warmIntervalHours: 24,
  coldIntervalHours: 72,
  hotLeadDaysMax: 30,
  hotViewedWithinDays: 7,
  horizonDays: 120,
  maxTasks: 500,
};

export interface CollectionTask {
  readonly hotelId: number;
  readonly wahHotelId: string;
  readonly checkIn: string;
  readonly nights: number;
  readonly adults: number;
  readonly tier: CollectionTier;
  readonly lastObservedAt: string | null;
  readonly reason: string;
}

export function tierFor(
  leadTimeDays: number,
  viewedWithinDays: number | null,
  options: SchedulerOptions,
): CollectionTier {
  if (leadTimeDays <= options.hotLeadDaysMax) return 'HOT';
  if (viewedWithinDays !== null && viewedWithinDays <= options.hotViewedWithinDays) return 'HOT';
  if (leadTimeDays <= options.horizonDays) return 'WARM';
  return 'COLD';
}

export function intervalHoursFor(tier: CollectionTier, options: SchedulerOptions): number {
  switch (tier) {
    case 'HOT':
      return options.hotIntervalHours;
    case 'WARM':
      return options.warmIntervalHours;
    case 'COLD':
      return options.coldIntervalHours;
  }
}

export function isDue(
  lastObservedAt: string | null,
  tier: CollectionTier,
  now: Date,
  options: SchedulerOptions,
): boolean {
  if (lastObservedAt === null) return true;
  const ageHours = (now.getTime() - Date.parse(lastObservedAt)) / 3_600_000;
  return ageHours >= intervalHoursFor(tier, options);
}

/**
 * Stays due for a refresh, most urgent first.
 *
 * Prioritises by tier then by staleness, so a HOT stay untouched for a day
 * outranks a WARM stay untouched for a week — the near-term decision is the one
 * a customer is about to make.
 */
export async function planCollection(
  options: SchedulerOptions = DEFAULT_SCHEDULER_OPTIONS,
  now: Date = new Date(),
  q?: Queryable,
): Promise<CollectionTask[]> {
  const { rows } = await db(q).query(
    `WITH tracked AS (
       SELECT o.hotel_id, h.wah_hotel_id, o.check_in, o.nights, o.adults,
              max(o.observed_at) AS last_observed_at,
              (o.check_in - CURRENT_DATE) AS lead_days
         FROM rate_observation o
         JOIN hotel h ON h.id = o.hotel_id
        WHERE h.is_active AND h.collection_tier <> 'OFF'
          AND o.check_in >= CURRENT_DATE
          -- ::int is required. Bare $1 leaves Postgres unable to choose
          -- between date+integer and date+interval: "operator is not unique".
          AND o.check_in <= CURRENT_DATE + $1::int
        GROUP BY o.hotel_id, h.wah_hotel_id, o.check_in, o.nights, o.adults
     ),
     viewed AS (
       SELECT hotel_id, check_in, nights, adults, max(computed_at) AS last_viewed_at
         FROM analysis
        WHERE computed_at >= now() - ($2 || ' days')::interval
        GROUP BY hotel_id, check_in, nights, adults
     )
     SELECT t.*, v.last_viewed_at
       FROM tracked t
       LEFT JOIN viewed v
         ON v.hotel_id = t.hotel_id AND v.check_in = t.check_in
        AND v.nights = t.nights AND v.adults = t.adults
      ORDER BY t.lead_days, t.last_observed_at`,
    [options.horizonDays, options.hotViewedWithinDays],
  );

  const tasks: CollectionTask[] = [];

  for (const row of rows) {
    const lastObservedAt = row.last_observed_at
      ? (row.last_observed_at as Date).toISOString()
      : null;
    const viewedWithinDays = row.last_viewed_at
      ? (now.getTime() - (row.last_viewed_at as Date).getTime()) / 86_400_000
      : null;
    const leadDays = row.lead_days as number;
    const tier = tierFor(leadDays, viewedWithinDays, options);

    if (!isDue(lastObservedAt, tier, now, options)) continue;

    tasks.push({
      hotelId: row.hotel_id as number,
      wahHotelId: row.wah_hotel_id as string,
      checkIn: (row.check_in as Date).toISOString().slice(0, 10),
      nights: row.nights as number,
      adults: row.adults as number,
      tier,
      lastObservedAt,
      reason:
        viewedWithinDays !== null && viewedWithinDays <= options.hotViewedWithinDays
          ? 'RECENTLY_VIEWED'
          : `LEAD_${leadDays}D`,
    });
  }

  const order: Record<CollectionTier, number> = { HOT: 0, WARM: 1, COLD: 2 };
  tasks.sort((a, b) => {
    const byTier = order[a.tier] - order[b.tier];
    if (byTier !== 0) return byTier;
    const ageA = a.lastObservedAt ? Date.parse(a.lastObservedAt) : 0;
    const ageB = b.lastObservedAt ? Date.parse(b.lastObservedAt) : 0;
    return ageA - ageB;
  });

  // Truncation is logged by the caller, never silent — a capped plan that reads
  // as complete coverage is how gaps go unnoticed.
  return tasks.slice(0, options.maxTasks);
}
