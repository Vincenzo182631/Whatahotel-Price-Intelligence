/**
 * Baseline rollup — recomputes `rate_baseline` from `rate_observation`.
 *
 * Writes a row at EVERY level of the widening ladder so a page view reads one
 * indexed row rather than scanning the fact table (docs/mvp/01 §6). Percentiles
 * come from `percentile_cont`, which matches the engine's interpolation exactly,
 * so a rollup-served score equals a raw-values score.
 */

import { LEAD_BUCKETS, type BaselineLevel } from '@wahpi/core';
import { db, upsertBaseline, type Queryable } from '@wahpi/data';

export interface RollupOptions {
  readonly lookbackDays: number;
  readonly minMatchConfidence: number;
  readonly outlierTrim: readonly [number, number];
  readonly hotelIds?: readonly number[];
}

export interface RollupResult {
  readonly rowsWritten: number;
  readonly levelCounts: Record<BaselineLevel, number>;
  readonly durationMs: number;
}

/**
 * Grouping expressions per level. `NULL` marks a stratum the level ignores;
 * the unique index uses NULLS NOT DISTINCT so those still deduplicate.
 */
const LEVEL_GROUPING: Record<BaselineLevel, { season: string; dow: string; lead: string }> = {
  L0: {
    season: 'o.stay_season_band',
    dow: 'o.stay_dow_bucket',
    lead: 'lead_bucket(o.lead_time_days)',
  },
  L1: { season: 'o.stay_season_band', dow: 'o.stay_dow_bucket', lead: 'NULL' },
  L2: { season: 'o.stay_season_band', dow: 'NULL::dow_bucket_t', lead: 'NULL' },
  L3: { season: 'NULL::season_band_t', dow: 'NULL::dow_bucket_t', lead: 'NULL' },
  L4: { season: 'NULL::season_band_t', dow: 'NULL::dow_bucket_t', lead: 'NULL' },
};

/** Lead-bucket boundaries as a SQL CASE, kept in step with LEAD_BUCKETS. */
function leadBucketSql(): string {
  const branches = LEAD_BUCKETS.filter((b) => b.maxDays !== Number.MAX_SAFE_INTEGER).map(
    (b) => `WHEN days BETWEEN ${b.minDays} AND ${b.maxDays} THEN '${b.key}'`,
  );
  return `CREATE OR REPLACE FUNCTION lead_bucket(days INT) RETURNS TEXT AS $$
            SELECT CASE ${branches.join(' ')} ELSE '121+' END
          $$ LANGUAGE SQL IMMUTABLE;`;
}

export async function ensureRollupFunctions(q?: Queryable): Promise<void> {
  await db(q).query(leadBucketSql());
}

/**
 * The room-type scope for a level.
 *
 * L0–L3 use the room type itself. L4 borrows from sibling room types — same
 * room class, adjacent tier — which is the rung that lets a brand-new room type
 * be scored at all, at a heavy confidence penalty.
 */
function roomScopeSql(level: BaselineLevel): string {
  if (level !== 'L4') return 'o.room_type_id = target.id';
  return `o.room_type_id <> target.id
          AND o.room_type_id IN (
            SELECT sib.id FROM room_type sib
             WHERE sib.hotel_id = target.hotel_id
               AND sib.room_class = target.room_class
               AND sib.is_active
               AND (target.tier_ordinal IS NULL OR sib.tier_ordinal IS NULL
                    OR abs(COALESCE(sib.tier_ordinal,0) - COALESCE(target.tier_ordinal,0)) <= 1)
          )`;
}

function buildQuery(level: BaselineLevel, filterHotels: boolean): string {
  const g = LEVEL_GROUPING[level];
  return `
    WITH scoped AS (
      SELECT target.id   AS room_type_id,
             target.hotel_id,
             o.comparability_class,
             o.currency,
             ${g.season} AS season_band,
             ${g.dow}    AS dow_bucket,
             ${g.lead}   AS lead_bucket,
             o.nightly_amount_minor,
             o.match_confidence,
             o.source_id,
             o.observed_date,
             (o.comparability_class = 'UNRESOLVED') AS unresolved
        FROM room_type target
        JOIN rate_observation o
          ON o.hotel_id = target.hotel_id
         AND ${roomScopeSql(level)}
       WHERE target.is_active
         AND o.is_available
         AND o.match_confidence >= $1
         AND o.observed_at >= now() - ($2 || ' days')::interval
         ${filterHotels ? 'AND target.hotel_id = ANY($5::bigint[])' : ''}
    ),
    bounds AS (
      SELECT room_type_id, hotel_id, comparability_class, currency,
             season_band, dow_bucket, lead_bucket,
             percentile_cont($3) WITHIN GROUP (ORDER BY nightly_amount_minor) AS lo,
             percentile_cont($4) WITHIN GROUP (ORDER BY nightly_amount_minor) AS hi,
             count(*) AS n_raw
        FROM scoped
       GROUP BY 1,2,3,4,5,6,7
    ),
    trimmed AS (
      SELECT s.*, b.n_raw
        FROM scoped s
        -- IS NOT DISTINCT FROM, not USING: the coarser levels leave stratum
        -- columns NULL, and NULL = NULL is never true, so a USING join silently
        -- returns zero rows for every level above L0.
        JOIN bounds b
          ON b.room_type_id        = s.room_type_id
         AND b.hotel_id            = s.hotel_id
         AND b.comparability_class = s.comparability_class
         AND b.currency            = s.currency
         AND b.season_band IS NOT DISTINCT FROM s.season_band
         AND b.dow_bucket  IS NOT DISTINCT FROM s.dow_bucket
         AND b.lead_bucket IS NOT DISTINCT FROM s.lead_bucket
       WHERE s.nightly_amount_minor BETWEEN b.lo AND b.hi
    )
    SELECT room_type_id, hotel_id, comparability_class, currency,
           season_band, dow_bucket, lead_bucket,
           count(*)::int                                       AS n_observations,
           (max(n_raw) - count(*))::int                        AS n_outliers_excluded,
           percentile_cont(0.10) WITHIN GROUP (ORDER BY nightly_amount_minor) AS p10,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY nightly_amount_minor) AS p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY nightly_amount_minor) AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY nightly_amount_minor) AS p75,
           percentile_cont(0.90) WITHIN GROUP (ORDER BY nightly_amount_minor) AS p90,
           min(nightly_amount_minor)                           AS min_minor,
           max(nightly_amount_minor)                           AS max_minor,
           avg(nightly_amount_minor)                           AS mean_minor,
           COALESCE(stddev_pop(nightly_amount_minor), 0)       AS stddev_minor,
           count(DISTINCT source_id)::int                      AS n_sources,
           avg(match_confidence)                               AS mean_match_conf,
           avg(CASE WHEN unresolved THEN 1 ELSE 0 END)         AS unresolved_share,
           min(observed_date)                                  AS window_start,
           max(observed_date)                                  AS window_end
      FROM trimmed
     GROUP BY 1,2,3,4,5,6,7
    HAVING count(*) >= 1`;
}

export async function refreshBaselines(
  options: RollupOptions,
  q?: Queryable,
): Promise<RollupResult> {
  const started = Date.now();
  await ensureRollupFunctions(q);

  const levels: BaselineLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];
  const levelCounts = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 } as Record<BaselineLevel, number>;
  let rowsWritten = 0;

  const filterHotels = (options.hotelIds?.length ?? 0) > 0;

  for (const level of levels) {
    const params: unknown[] = [
      options.minMatchConfidence,
      options.lookbackDays,
      options.outlierTrim[0],
      options.outlierTrim[1],
    ];
    if (filterHotels) params.push(options.hotelIds);

    const { rows } = await db(q).query(buildQuery(level, filterHotels), params);

    for (const row of rows) {
      const mean = Number(row.mean_minor);
      const stddev = Number(row.stddev_minor);
      await upsertBaseline(
        {
          hotelId: row.hotel_id as number,
          roomTypeId: row.room_type_id as number,
          comparabilityClass: row.comparability_class as string,
          baselineLevel: level,
          seasonBand: (row.season_band as string) ?? null,
          dowBucket: (row.dow_bucket as string) ?? null,
          leadBucket: (row.lead_bucket as string) ?? null,
          currency: row.currency as string,
          nObservations: row.n_observations as number,
          nOutliersExcluded: Math.max(0, row.n_outliers_excluded as number),
          p10: Math.round(Number(row.p10)),
          p25: Math.round(Number(row.p25)),
          p50: Math.round(Number(row.p50)),
          p75: Math.round(Number(row.p75)),
          p90: Math.round(Number(row.p90)),
          min: row.min_minor as number,
          max: row.max_minor as number,
          mean: Math.round(mean),
          stddev: Math.round(stddev),
          cv: mean === 0 ? 0 : Number((stddev / mean).toFixed(4)),
          nSources: row.n_sources as number,
          meanMatchConfidence: Number(Number(row.mean_match_conf).toFixed(2)),
          // Cross-source agreement needs at least two sources to mean anything.
          crossSourceCv: (row.n_sources as number) > 1 ? Number((stddev / mean).toFixed(4)) : null,
          unresolvedShare: Number(Number(row.unresolved_share).toFixed(3)),
          windowStart: (row.window_start as Date).toISOString().slice(0, 10),
          windowEnd: (row.window_end as Date).toISOString().slice(0, 10),
        },
        q,
      );
      rowsWritten += 1;
      levelCounts[level] += 1;
    }
  }

  return { rowsWritten, levelCounts, durationMs: Date.now() - started };
}
