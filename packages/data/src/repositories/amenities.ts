/**
 * Per-hotel amenities from `method=info` (migration 0021).
 *
 * Not a fact table for scoring. Nothing under `packages/core/src/scoring` may
 * read this — rule 21 keeps included value as the only validated quality
 * evidence inside the score, and amenities entering it would be an
 * uncalibrated term nobody reviewed. This exists so the preference layer can
 * say something true instead of "limited information is available".
 */
import { db, type Queryable } from '../client.js';

export interface HotelAmenity {
  readonly code: string;
  readonly label: string;
}

/**
 * The Amadeus property code from the by-ID hotel lookup.
 *
 * The identity `info` cannot supply about itself. Null means we have not run
 * the lookup or the source gave none, and a caller must read that as "cannot
 * verify" rather than "verified".
 */
export async function findAmadeusProperty(hotelId: number, q?: Queryable): Promise<string | null> {
  const { rows } = await db(q).query('SELECT amadeus_property FROM hotel WHERE id = $1', [hotelId]);
  const code = rows[0]?.amadeus_property as string | null | undefined;
  return code && code.trim() !== '' ? code.trim() : null;
}

/** Record what the by-ID lookup said, so a later name lookup can be checked. */
export async function setAmadeusProperty(
  hotelId: number,
  amadeusProperty: string | null,
  q?: Queryable,
): Promise<void> {
  // Never overwrite a known code with null. A response that omitted the block
  // is not evidence the mapping was withdrawn, and forgetting it would
  // silently disable the identity check for that hotel.
  if (amadeusProperty === null || amadeusProperty.trim() === '') return;
  await db(q).query('UPDATE hotel SET amadeus_property = $2 WHERE id = $1', [
    hotelId,
    amadeusProperty.trim(),
  ]);
}

/**
 * Store the amenities `info` stated for this hotel.
 *
 * ADDITIVE by design. An amenity the source stops reporting is not deleted,
 * because we cannot tell "the hotel removed it" from "this response was
 * thin", and a customer-facing list that flickers with upstream noise is
 * worse than one that is occasionally stale. `last_seen` is what a reader
 * filters on; nothing here ever silently drops a row.
 *
 * Returns the number of rows written, so a caller can report real work.
 */
export async function upsertHotelAmenities(
  hotelId: number,
  amenities: readonly HotelAmenity[],
  q?: Queryable,
): Promise<number> {
  if (amenities.length === 0) return 0;
  const codes = amenities.map((a) => a.code);
  const labels = amenities.map((a) => a.label);
  const { rowCount } = await db(q).query(
    `INSERT INTO hotel_amenity (hotel_id, code, label)
     SELECT $1, c, l
       FROM unnest($2::text[], $3::text[]) AS t(c, l)
     ON CONFLICT (hotel_id, code) DO UPDATE
        SET label = EXCLUDED.label,
            last_seen = now()`,
    [hotelId, codes, labels],
  );
  return rowCount ?? 0;
}

/** What this hotel offers, for the preference layer. Alphabetical, stable. */
export async function findHotelAmenities(
  hotelId: number,
  q?: Queryable,
): Promise<readonly HotelAmenity[]> {
  const { rows } = await db(q).query(
    `SELECT code, label FROM hotel_amenity
      WHERE hotel_id = $1
      ORDER BY label`,
    [hotelId],
  );
  return rows.map((r) => ({ code: r.code as string, label: r.label as string }));
}

/**
 * Hotels worth asking `info` about: catalogued, placed, and not yet answered.
 *
 * Ordered by whether we have ever stored an amenity for them, so a first
 * pass covers ground rather than refreshing the same hotels.
 */
export async function findHotelsNeedingAmenities(
  limit: number,
  q?: Queryable,
): Promise<readonly { hotelId: number; name: string; city: string }[]> {
  const { rows } = await db(q).query(
    `SELECT h.id, h.name, d.name AS city
       FROM hotel h
       JOIN destination d ON d.id = h.destination_id
      WHERE h.is_active
        AND h.name IS NOT NULL
        AND d.name IS NOT NULL
        -- The name lookup is rejected outright for non-ASCII (measured:
        -- "Château Saint-Martin", "Mont d'Arbois", "Saturnia (Grosseto)").
        -- Skipping them here costs one query rather than a 400 per hotel,
        -- and we do NOT transliterate: an altered name is a different name,
        -- and answering about a different hotel is this method's whole risk.
        AND h.name ~ '^[[:ascii:]]+$'
        AND d.name ~ '^[[:ascii:]]+$'
      ORDER BY (SELECT count(*) FROM hotel_amenity a WHERE a.hotel_id = h.id) ASC,
               h.id ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    hotelId: r.id as number,
    name: r.name as string,
    city: r.city as string,
  }));
}
