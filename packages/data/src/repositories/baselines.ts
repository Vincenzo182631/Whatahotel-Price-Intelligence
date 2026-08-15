import type { BaselineDistribution, BaselineLevel } from '@wahpi/core';
import { selectBaselineLevel } from '@wahpi/core';

import { db, type Queryable } from '../client.js';

export interface BaselineCandidate {
  readonly level: BaselineLevel;
  readonly nObservations: number;
  readonly distribution: BaselineDistribution;
}

export interface BaselineLookup {
  readonly hotelId: number;
  readonly roomTypeId: number;
  readonly comparabilityClass: string;
  readonly currency: string;
  readonly seasonBand: string;
  readonly dowBucket: string;
  readonly leadBucket: string;
  readonly lookbackDays: number;
}

function toDistribution(row: Record<string, unknown>, lookbackDays: number): BaselineDistribution {
  return {
    level: row.baseline_level as BaselineLevel,
    nObservations: row.n_observations as number,
    nOutliersExcluded: row.n_outliers_excluded as number,
    min: row.min_minor as number,
    p10: row.p10_minor as number,
    p25: row.p25_minor as number,
    p50: row.p50_minor as number,
    p75: row.p75_minor as number,
    p90: row.p90_minor as number,
    max: row.max_minor as number,
    mean: row.mean_minor as number,
    stddev: row.stddev_minor as number,
    cv: row.cv as number,
    meanMatchConfidence: row.mean_match_conf as number,
    nSources: row.n_sources as number,
    crossSourceCv: (row.cross_source_cv as number) ?? null,
    unresolvedShare: (row.unresolved_share as number) ?? 0,
    lookbackDays,
    computedAt: (row.computed_at as Date).toISOString(),
  };
}

/**
 * Fetch every precomputed ladder level for this room and class, then let the
 * ladder pick. Levels are precomputed by the rollup (docs/mvp/01 §6), so this
 * is one indexed read — never a scan of the fact table on a page view.
 */
export async function resolveBaseline(
  lookup: BaselineLookup,
  minObsAbs: number,
  minObsTarget: number,
  q?: Queryable,
): Promise<{
  distribution: BaselineDistribution | null;
  rejected: ReadonlyArray<{ level: BaselineLevel; nObservations: number }>;
}> {
  const { rows } = await db(q).query(
    `SELECT * FROM rate_baseline
      WHERE hotel_id = $1 AND room_type_id = $2
        AND comparability_class = $3 AND currency = $4
        AND (
             (baseline_level = 'L0' AND stay_season_band = $5::season_band_t
                                   AND stay_dow_bucket = $6::dow_bucket_t
                                   AND lead_bucket = $7)
          OR (baseline_level = 'L1' AND stay_season_band = $5::season_band_t
                                   AND stay_dow_bucket = $6::dow_bucket_t)
          OR (baseline_level = 'L2' AND stay_season_band = $5::season_band_t)
          OR  baseline_level IN ('L3','L4')
        )`,
    [
      lookup.hotelId,
      lookup.roomTypeId,
      lookup.comparabilityClass,
      lookup.currency,
      lookup.seasonBand,
      lookup.dowBucket,
      lookup.leadBucket,
    ],
  );

  const candidates: BaselineCandidate[] = rows.map((row) => {
    const distribution = toDistribution(row, lookup.lookbackDays);
    return { level: distribution.level, nObservations: distribution.nObservations, distribution };
  });

  const selection = selectBaselineLevel(candidates, minObsAbs, minObsTarget);
  return {
    distribution: selection.selected?.distribution ?? null,
    rejected: selection.rejected,
  };
}

export interface BaselineUpsert {
  readonly hotelId: number;
  readonly roomTypeId: number;
  readonly comparabilityClass: string;
  readonly baselineLevel: BaselineLevel;
  readonly seasonBand: string | null;
  readonly dowBucket: string | null;
  readonly leadBucket: string | null;
  readonly currency: string;
  readonly nObservations: number;
  readonly nOutliersExcluded: number;
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly stddev: number;
  readonly cv: number;
  readonly nSources: number;
  readonly meanMatchConfidence: number;
  readonly crossSourceCv: number | null;
  readonly unresolvedShare: number;
  readonly windowStart: string;
  readonly windowEnd: string;
}

export async function upsertBaseline(b: BaselineUpsert, q?: Queryable): Promise<void> {
  await db(q).query(
    `INSERT INTO rate_baseline (
        hotel_id, room_type_id, comparability_class, baseline_level,
        stay_season_band, stay_dow_bucket, lead_bucket, currency,
        n_observations, n_outliers_excluded,
        p10_minor, p25_minor, p50_minor, p75_minor, p90_minor,
        min_minor, max_minor, mean_minor, stddev_minor, cv,
        n_sources, mean_match_conf, cross_source_cv, unresolved_share,
        window_start, window_end, computed_at
     ) VALUES (
        $1,$2,$3,$4,$5::season_band_t,$6::dow_bucket_t,$7,$8,
        $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26, now()
     )
     ON CONFLICT (hotel_id, room_type_id, comparability_class, baseline_level,
                  stay_season_band, stay_dow_bucket, lead_bucket, currency)
     DO UPDATE SET
        n_observations = EXCLUDED.n_observations,
        n_outliers_excluded = EXCLUDED.n_outliers_excluded,
        p10_minor = EXCLUDED.p10_minor, p25_minor = EXCLUDED.p25_minor,
        p50_minor = EXCLUDED.p50_minor, p75_minor = EXCLUDED.p75_minor,
        p90_minor = EXCLUDED.p90_minor, min_minor = EXCLUDED.min_minor,
        max_minor = EXCLUDED.max_minor, mean_minor = EXCLUDED.mean_minor,
        stddev_minor = EXCLUDED.stddev_minor, cv = EXCLUDED.cv,
        n_sources = EXCLUDED.n_sources, mean_match_conf = EXCLUDED.mean_match_conf,
        cross_source_cv = EXCLUDED.cross_source_cv,
        unresolved_share = EXCLUDED.unresolved_share,
        window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
        computed_at = now()`,
    [
      b.hotelId,
      b.roomTypeId,
      b.comparabilityClass,
      b.baselineLevel,
      b.seasonBand,
      b.dowBucket,
      b.leadBucket,
      b.currency,
      b.nObservations,
      b.nOutliersExcluded,
      b.p10,
      b.p25,
      b.p50,
      b.p75,
      b.p90,
      b.min,
      b.max,
      b.mean,
      b.stddev,
      b.cv,
      b.nSources,
      b.meanMatchConfidence,
      b.crossSourceCv,
      b.unresolvedShare,
      b.windowStart,
      b.windowEnd,
    ],
  );
}

export async function baselineMedianFor(
  hotelId: number,
  roomTypeId: number,
  comparabilityClass: string,
  currency: string,
  q?: Queryable,
): Promise<number | null> {
  const { rows } = await db(q).query(
    `SELECT p50_minor FROM rate_baseline
      WHERE hotel_id = $1 AND room_type_id = $2 AND comparability_class = $3
        AND currency = $4 AND baseline_level = 'L3'
      LIMIT 1`,
    [hotelId, roomTypeId, comparabilityClass, currency],
  );
  return rows[0] ? (rows[0].p50_minor as number) : null;
}

export async function countStaleBaselines(maxAgeHours: number, q?: Queryable): Promise<number> {
  const { rows } = await db(q).query(
    `SELECT count(*)::bigint AS n FROM rate_baseline
      WHERE computed_at < now() - ($1 || ' hours')::interval`,
    [maxAgeHours],
  );
  return (rows[0]?.n as number) ?? 0;
}
