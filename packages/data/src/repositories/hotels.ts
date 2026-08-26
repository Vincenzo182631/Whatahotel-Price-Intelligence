import { DEFAULT_CONFIG } from '@wahpi/core';

import { db, type Queryable } from '../client.js';

export interface HotelRow {
  readonly id: number;
  readonly wahHotelId: string;
  readonly name: string;
  readonly brand: string | null;
  readonly destination: string | null;
  readonly destinationId: number | null;
  readonly luxuryTier: number | null;
  readonly starRating: number | null;
  readonly baseCurrency: string;
  readonly collectionTier: string;
}

export interface RoomTypeRow {
  readonly id: number;
  readonly hotelId: number;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly roomClass: string;
  readonly bedConfig: string;
  readonly viewType: string;
  readonly tierOrdinal: number | null;
}

const HOTEL_COLUMNS = `
    h.id, h.wah_hotel_id, h.name, h.brand, h.destination_id, d.name AS destination,
    h.luxury_tier, h.star_rating, h.base_currency, h.collection_tier`;

function toHotel(row: Record<string, unknown>): HotelRow {
  return {
    id: row.id as number,
    wahHotelId: row.wah_hotel_id as string,
    name: row.name as string,
    brand: (row.brand as string) ?? null,
    destination: (row.destination as string) ?? null,
    destinationId: (row.destination_id as number) ?? null,
    luxuryTier: (row.luxury_tier as number) ?? null,
    starRating: (row.star_rating as number) ?? null,
    baseCurrency: row.base_currency as string,
    collectionTier: row.collection_tier as string,
  };
}

export async function findHotelByWahId(
  wahHotelId: string,
  q?: Queryable,
): Promise<HotelRow | null> {
  const { rows } = await db(q).query(
    `SELECT ${HOTEL_COLUMNS}
       FROM hotel h LEFT JOIN destination d ON d.id = h.destination_id
      WHERE h.wah_hotel_id = $1 AND h.is_active`,
    [wahHotelId],
  );
  return rows[0] ? toHotel(rows[0]) : null;
}

/**
 * The comparables' identities, for fetching their rates from the source.
 *
 * Used by on-demand scoring: when a guest asks about a stay nothing has
 * collected, the subject hotel's rate alone gives no Comp-Set Index — the
 * comparables' rates for the SAME stay have to be fetched in the same pass.
 */
export async function findComparableIdentities(
  hotelId: number,
  limit: number,
  /**
   * Km radius the same-destination fallback may reach beyond the label —
   * the SAME widening the scoring-time comp set applies
   * (live.csi.radiusMiles), so the hotels we fetch are the hotels we will
   * compare against. 0 disables it.
   */
  // Miles→km at the caller; this takes km so the SQL stays in one unit. The
  // default is the ladder's FIRST rung: a caller that does not care which ring
  // it is asking about gets the primary competitive market, never the widest.
  nearbyRadiusKm: number = (DEFAULT_CONFIG.live.csi.radiusMiles[0] ?? 0) * 1.609344,
  q?: Queryable,
): Promise<{ hotelId: number; wahHotelId: string }[]> {
  const { rows } = await db(q).query(
    `SELECT h.id, h.wah_hotel_id
       FROM hotel_comparable c
       JOIN hotel h ON h.id = c.comparable_id
      WHERE c.hotel_id = $1 AND h.is_active AND h.collection_tier <> 'OFF'
      ORDER BY c.rank
      LIMIT $2`,
    [hotelId, limit],
  );
  if (rows.length > 0) {
    return rows.map((r) => ({ hotelId: r.id as number, wahHotelId: r.wah_hotel_id as string }));
  }

  // No curated comp set yet. `rebuildComparables` ranks on accrued baselines,
  // so a hotel enrolled minutes ago has none — and returning nothing here
  // would mean a brand-new destination could never produce a Comp-Set Index,
  // which is 45% of the live score. Same destination is the weaker but honest
  // stand-in: it is the same filter the curated set starts from, minus the
  // price and tier ranking it cannot compute yet. The curated set takes over
  // automatically on the first rollup that has baselines to rank.
  //
  // Tier OFF is deliberately NOT excluded here, unlike the curated branch
  // above. OFF means "not on the collection schedule", which is the normal
  // state of a sweep-discovered hotel; the caller fetches these hotels' rates
  // live for this exact stay, so being off the schedule says nothing about
  // whether the source will answer for them.
  const { rows: sameDestination } = await db(q).query(
    `SELECT h.id, h.wah_hotel_id
       FROM hotel h,
            (SELECT destination_id, latitude, longitude FROM hotel WHERE id = $1) s
      WHERE h.is_active
        AND h.id <> $1
        -- Distance first, label second — byte-for-byte the predicate the
        -- comp-set CTE applies. These two queries must not diverge: a fetch
        -- list narrower than the comparison fetches rates we never use while
        -- starving the ones we do, and a wider one spends the source's
        -- quota on hotels the comparison will discard.
        AND (
          CASE
            WHEN $3::float8 > 0
              AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
            THEN h.latitude IS NOT NULL AND h.longitude IS NOT NULL
              AND power(111.32 * (h.latitude - s.latitude)::float8, 2)
                + power(111.32 * cos(radians(s.latitude::float8))
                    * (h.longitude - s.longitude)::float8, 2)
                <= power($3::float8, 2)
            ELSE s.destination_id IS NOT NULL AND h.destination_id = s.destination_id
          END
        )
      -- Nearest first, then source ranking. Same order the scoring-time comp
      -- set uses, so the hotels we FETCH are the hotels we will compare against.
      ORDER BY (h.latitude IS NULL OR s.latitude IS NULL),
               (h.latitude - s.latitude) ^ 2 + (h.longitude - s.longitude) ^ 2,
               (h.city_rank IS NULL),
               h.city_rank DESC,
               h.id
      LIMIT $2`,
    [hotelId, limit, nearbyRadiusKm],
  );
  return sameDestination.map((r) => ({
    hotelId: r.id as number,
    wahHotelId: r.wah_hotel_id as string,
  }));
}

/**
 * Move a catalogued-but-unscheduled hotel into scheduled collection.
 *
 * The full-inventory sweep enrolls every hotel the source has at tier OFF —
 * catalogued and scoreable on demand, but not in the collection grid: the
 * measured inventory is 3,202 hotels (2026-08-20), which at WARM is ~147k
 * stays and a collection cycle of roughly a month.
 * A guest actually looking at a hotel is the signal that its history is worth
 * accruing, so the first live request promotes it and the scheduler picks it
 * up on the next run. Idempotent, and it never touches HOT or an inactive row.
 *
 * Returns true only when this call performed the promotion.
 */
export async function promoteHotelForCollection(
  wahHotelId: string,
  q?: Queryable,
): Promise<boolean> {
  const { rowCount } = await db(q).query(
    `UPDATE hotel SET collection_tier = 'WARM', updated_at = now()
      WHERE wah_hotel_id = $1 AND is_active AND collection_tier = 'OFF'`,
    [wahHotelId],
  );
  return (rowCount ?? 0) > 0;
}

/** Whether a curated comp set exists, or the destination fallback is in play. */
export async function hasCuratedComparables(hotelId: number, q?: Queryable): Promise<boolean> {
  const { rows } = await db(q).query(
    `SELECT EXISTS (SELECT 1 FROM hotel_comparable WHERE hotel_id = $1) AS curated`,
    [hotelId],
  );
  return rows[0]?.curated === true;
}

export interface HotelSearchResult extends HotelRow {
  /** Whether this hotel has enough baseline coverage to be worth analysing. */
  readonly hasPriceIntelligence: boolean;
}

/**
 * Trigram search, or a plain listing when no term is given.
 *
 * `hasPriceIntelligence` exists so the UI can avoid walking a customer into a
 * guaranteed INSUFFICIENT_DATA result.
 */
export async function searchHotels(
  term: string | null,
  limit: number,
  minObservations: number,
  q?: Queryable,
): Promise<HotelSearchResult[]> {
  const hasTerm = term !== null && term.trim() !== '';

  // Every placeholder must be referenced: Postgres cannot infer the type of a
  // bound parameter that appears nowhere in the statement, so the two branches
  // bind different parameter lists rather than passing an unused dummy.
  const sql = hasTerm
    ? `SELECT ${HOTEL_COLUMNS},
              EXISTS (SELECT 1 FROM rate_baseline b
                       WHERE b.hotel_id = h.id AND b.n_observations >= $1) AS has_pi
         FROM hotel h LEFT JOIN destination d ON d.id = h.destination_id
        WHERE h.is_active
          AND (h.name ILIKE '%' || $2 || '%' OR similarity(h.name, $2) > 0.2)
        ORDER BY similarity(h.name, $2) DESC, h.name
        LIMIT $3`
    : `SELECT ${HOTEL_COLUMNS},
              EXISTS (SELECT 1 FROM rate_baseline b
                       WHERE b.hotel_id = h.id AND b.n_observations >= $1) AS has_pi
         FROM hotel h LEFT JOIN destination d ON d.id = h.destination_id
        WHERE h.is_active
        ORDER BY h.name
        LIMIT $2`;

  const params = hasTerm ? [minObservations, term, limit] : [minObservations, limit];

  const { rows } = await db(q).query(sql, params);
  return rows.map((r) => ({ ...toHotel(r), hasPriceIntelligence: r.has_pi === true }));
}

export async function listRoomTypes(hotelId: number, q?: Queryable): Promise<RoomTypeRow[]> {
  const { rows } = await db(q).query(
    `SELECT id, hotel_id, canonical_name, normalized_name, room_class,
            bed_config, view_type, tier_ordinal
       FROM room_type WHERE hotel_id = $1 AND is_active
      ORDER BY COALESCE(tier_ordinal, 99), canonical_name`,
    [hotelId],
  );
  return rows.map((row) => ({
    id: row.id as number,
    hotelId: row.hotel_id as number,
    canonicalName: row.canonical_name as string,
    normalizedName: row.normalized_name as string,
    roomClass: row.room_class as string,
    bedConfig: row.bed_config as string,
    viewType: row.view_type as string,
    tierOrdinal: (row.tier_ordinal as number) ?? null,
  }));
}

/** Sibling room types for the L4 rung of the widening ladder. */
export async function listSiblingRoomTypeIds(roomTypeId: number, q?: Queryable): Promise<number[]> {
  const { rows } = await db(q).query(
    `SELECT sib.id
       FROM room_type rt
       JOIN room_type sib
         ON sib.hotel_id = rt.hotel_id
        AND sib.room_class = rt.room_class
        AND sib.id <> rt.id
        AND sib.is_active
        AND (
          rt.tier_ordinal IS NULL OR sib.tier_ordinal IS NULL
          OR abs(COALESCE(sib.tier_ordinal, 0) - COALESCE(rt.tier_ordinal, 0)) <= 1
        )
      WHERE rt.id = $1`,
    [roomTypeId],
  );
  return rows.map((r) => r.id as number);
}

/** Facts read from a hotel's public page. See adapters/whatahotel/page.ts. */
export interface HotelPageFacts {
  readonly streetAddress: string | null;
  readonly postalCode: string | null;
  readonly bookableOnline: boolean | null;
}

/**
 * Hotels whose public page has never been read, or was read longest ago.
 *
 * Ordered so the ones that would unlock a Google match come first: a hotel
 * with no coordinates cannot be resolved at all until it has an address,
 * where one with coordinates is merely gaining a second opinion.
 */
export async function findHotelsNeedingPageFacts(
  limit: number,
  refreshHours: number,
  q?: Queryable,
): Promise<{ hotelId: number; wahHotelId: string }[]> {
  const { rows } = await db(q).query(
    `SELECT h.id, h.wah_hotel_id
       FROM hotel h
      WHERE h.is_active
        AND (h.page_fetched_at IS NULL
             OR h.page_fetched_at < now() - ($2 || ' hours')::interval)
      ORDER BY (h.latitude IS NOT NULL), h.page_fetched_at NULLS FIRST, h.id
      LIMIT $1`,
    [limit, refreshHours],
  );
  return rows.map((row) => ({
    hotelId: row.id as number,
    wahHotelId: row.wah_hotel_id as string,
  }));
}

/**
 * Store what the page said.
 *
 * `page_fetched_at` is stamped on every successful parse, including one that
 * found no address — that is a real answer about the page and must not leave
 * the hotel spinning at the front of the refresh queue forever. A FAILED
 * fetch never reaches here, so it stays queued. Same split as the Places
 * resolver, for the same reason.
 */
export async function saveHotelPageFacts(
  hotelId: number,
  facts: HotelPageFacts,
  q?: Queryable,
): Promise<void> {
  await db(q).query(
    `UPDATE hotel
        SET street_address  = COALESCE($2, street_address),
            postal_code     = COALESCE($3, postal_code),
            bookable_online = $4,
            page_fetched_at = now(),
            updated_at      = now()
      WHERE id = $1`,
    [hotelId, facts.streetAddress, facts.postalCode, facts.bookableOnline],
  );
}
