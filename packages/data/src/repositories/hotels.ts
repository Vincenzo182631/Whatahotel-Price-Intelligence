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
