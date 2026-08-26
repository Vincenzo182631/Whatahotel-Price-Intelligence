/**
 * Comp-set construction (U12).
 *
 * A comparable is a hotel a traveler would plausibly consider instead: same
 * destination, similar luxury tier, overlapping price band. Similarity is a
 * transparent weighted score rather than a learned model, because a customer
 * may reasonably ask why a given hotel was used as a comparison.
 */

import { DEFAULT_CONFIG } from '@wahpi/core';
import { db, upsertComparables, type Queryable } from '@wahpi/data';

export interface ComparableBuildOptions {
  readonly maxPerHotel: number;
  readonly minSimilarity: number;
  /** Tier difference beyond which two hotels are not comparable at all. */
  readonly maxTierDistance: number;
  /** Price-band ratio beyond which two hotels are not comparable at all. */
  readonly maxPriceRatio: number;
  /**
   * Kilometres beyond which two hotels are not comparable, however alike
   * their price band.
   *
   * A shared destination label is not a shared market: labels span whole
   * metro areas, so a peer set chosen on price within a label could pair a
   * prime-district hotel with a suburban one. Defaults to the outermost rung
   * of the live radius ladder (live.csi.radiusMiles), so a curated set can
   * never reach further than the destination fallback would.
   */
  readonly maxDistanceKm: number;
}

export const DEFAULT_COMPARABLE_OPTIONS: ComparableBuildOptions = {
  maxPerHotel: 8,
  minSimilarity: 0.35,
  maxTierDistance: 1,
  maxPriceRatio: 2.0,
  maxDistanceKm:
    Math.max(...DEFAULT_CONFIG.live.csi.radiusMiles, 0) * 1.609344 || Number.POSITIVE_INFINITY,
};

export const COMPARABLE_BASIS = 'DESTINATION_TIER_PRICEBAND';

interface HotelProfile {
  readonly id: number;
  readonly destinationId: number | null;
  readonly luxuryTier: number | null;
  readonly typicalNightlyMinor: number | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}

/**
 * Equirectangular kilometres — the same approximation the comp-set query uses,
 * so a hotel is not admitted here and rejected there.
 *
 * Null when either side lacks coordinates: 5% of the catalogue has none, and
 * an unplaceable hotel must not be silently dropped from a peer set built on
 * price. Unknown distance is unknown, never "far".
 */
function distanceKmBetween(a: HotelProfile, b: HotelProfile): number | null {
  if (a.latitude === null || a.longitude === null) return null;
  if (b.latitude === null || b.longitude === null) return null;
  const dLat = 111.32 * (b.latitude - a.latitude);
  const dLon = 111.32 * Math.cos((a.latitude * Math.PI) / 180) * (b.longitude - a.longitude);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Weighted, and deliberately simple:
 *   0.50  price proximity  — the strongest signal that two hotels compete
 *   0.30  luxury tier      — a five-star and a three-star are not alternatives
 *   0.20  brand difference — a hotel is not its own comparable
 */
export function similarityBetween(a: HotelProfile, b: HotelProfile): number {
  if (a.destinationId === null || a.destinationId !== b.destinationId) return 0;
  if (a.typicalNightlyMinor === null || b.typicalNightlyMinor === null) return 0;

  const ratio =
    Math.max(a.typicalNightlyMinor, b.typicalNightlyMinor) /
    Math.min(a.typicalNightlyMinor, b.typicalNightlyMinor);
  const priceScore = Math.max(0, 1 - (ratio - 1));

  const tierDistance =
    a.luxuryTier === null || b.luxuryTier === null ? 1 : Math.abs(a.luxuryTier - b.luxuryTier);
  const tierScore = Math.max(0, 1 - tierDistance / 2);

  return 0.5 * priceScore + 0.3 * tierScore + 0.2;
}

export interface ComparableBuildResult {
  readonly hotelsProcessed: number;
  readonly pairsWritten: number;
  readonly hotelsWithoutComparables: number;
}

export async function rebuildComparables(
  options: ComparableBuildOptions = DEFAULT_COMPARABLE_OPTIONS,
  q?: Queryable,
): Promise<ComparableBuildResult> {
  const { rows } = await db(q).query(
    `SELECT h.id, h.destination_id, h.luxury_tier, h.latitude, h.longitude,
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY b.p50_minor)
               FROM rate_baseline b
              WHERE b.hotel_id = h.id AND b.baseline_level = 'L3') AS typical
       FROM hotel h
      WHERE h.is_active`,
  );

  const profiles: HotelProfile[] = rows.map((r) => ({
    id: r.id as number,
    destinationId: (r.destination_id as number) ?? null,
    luxuryTier: (r.luxury_tier as number) ?? null,
    typicalNightlyMinor: r.typical === null ? null : Math.round(Number(r.typical)),
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
  }));

  let pairsWritten = 0;
  let withoutComparables = 0;

  for (const subject of profiles) {
    const scored = profiles
      .filter((other) => other.id !== subject.id)
      .filter((other) => {
        if (subject.typicalNightlyMinor === null || other.typicalNightlyMinor === null)
          return false;
        const ratio =
          Math.max(subject.typicalNightlyMinor, other.typicalNightlyMinor) /
          Math.min(subject.typicalNightlyMinor, other.typicalNightlyMinor);
        if (ratio > options.maxPriceRatio) return false;
        // Distance is a hard filter, not a weight: past the outermost rung of
        // the live ladder the two hotels are not alternatives however alike
        // their price. A pair we cannot place is kept — unknown is not far.
        const km = distanceKmBetween(subject, other);
        if (km !== null && km > options.maxDistanceKm) return false;
        if (
          subject.luxuryTier !== null &&
          other.luxuryTier !== null &&
          Math.abs(subject.luxuryTier - other.luxuryTier) > options.maxTierDistance
        ) {
          return false;
        }
        return true;
      })
      .map((other) => ({ other, similarity: similarityBetween(subject, other) }))
      .filter((s) => s.similarity >= options.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, options.maxPerHotel);

    if (scored.length === 0) {
      withoutComparables += 1;
      continue;
    }

    await upsertComparables(
      subject.id,
      scored.map((s, index) => ({
        comparableId: s.other.id,
        similarity: Number(s.similarity.toFixed(3)),
        rank: index + 1,
      })),
      COMPARABLE_BASIS,
      q,
    );
    pairsWritten += scored.length;
  }

  return {
    hotelsProcessed: profiles.length,
    pairsWritten,
    hotelsWithoutComparables: withoutComparables,
  };
}
