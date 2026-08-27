import { db, type Queryable } from '../client.js';

/**
 * Cached Google reputation for a hotel.
 *
 * Only ever constructed from a VERIFIED row (migration 0013). An UNVERIFIED or
 * NO_MATCH hotel has no reputation as far as everything downstream is
 * concerned — not a low one, not a zero one. `rating` and `userRatingCount`
 * travel together because one without the other is misleading: 4.9 from 32
 * reviews and 4.7 from 4,500 are not the same claim.
 */
export interface HotelReputation {
  readonly hotelId: number;
  readonly placeId: string;
  readonly rating: number | null;
  readonly userRatingCount: number | null;
  readonly displayName: string | null;
  readonly formattedAddress: string | null;
  readonly mapsUri: string | null;
  /** Google's own short description of the place. Never our words. */
  readonly editorialSummary: string | null;
  /**
   * Theme tags measured over the review SAMPLE Google returns (<=5 reviews,
   * positive ones only). "Recent reviewers mention", never "guests say".
   */
  readonly reviewThemes: readonly string[];
  readonly fetchedAt: string | null;
}

/** A hotel that needs resolving, with everything the matcher compares on. */
export interface ResolutionTarget {
  readonly hotelId: number;
  readonly name: string;
  readonly city: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  /** From the public hotel page. Lifts the matcher's no-coordinates cap. */
  readonly streetAddress: string | null;
  /**
   * Where the coordinates came from (migration 0018). GOOGLE means a previous
   * match supplied them, so they cannot corroborate a Google candidate; the
   * resolver treats them as absent when scoring a fresh match.
   */
  readonly coordinateSource: 'SOURCE' | 'GOOGLE' | null;
  readonly placeId: string | null;
}

export interface ResolutionResult {
  readonly status: 'VERIFIED' | 'UNVERIFIED' | 'NO_MATCH';
  readonly confidence: number | null;
  readonly placeId?: string | null;
  readonly rating?: number | null;
  readonly userRatingCount?: number | null;
  readonly displayName?: string | null;
  readonly formattedAddress?: string | null;
  readonly mapsUri?: string | null;
  /**
   * The place's coordinates, as Google returned them.
   *
   * Written ONLY to a hotel that has none — see saveResolution. Google
   * supplements the catalogue, it never overwrites it.
   */
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly editorialSummary?: string | null;
  readonly reviewThemes?: readonly string[] | null;
}

const toReputation = (row: Record<string, unknown>): HotelReputation => ({
  hotelId: row.id as number,
  placeId: row.google_place_id as string,
  // NUMERIC comes back as a string from node-postgres; parse where we know
  // the range rather than installing a global type parser that would change
  // how money is read elsewhere.
  rating: row.google_rating === null ? null : Number(row.google_rating),
  userRatingCount: (row.google_user_rating_count as number) ?? null,
  displayName: (row.google_display_name as string) ?? null,
  formattedAddress: (row.google_formatted_address as string) ?? null,
  mapsUri: (row.google_maps_uri as string) ?? null,
  editorialSummary: (row.google_editorial_summary as string) ?? null,
  reviewThemes: (row.google_review_themes as string[]) ?? [],
  fetchedAt: row.google_fetched_at ? (row.google_fetched_at as Date).toISOString() : null,
});

/**
 * Reputation for these hotels, VERIFIED only.
 *
 * The filter lives in SQL rather than in the caller on purpose: every call
 * site that forgets it would be a call site that shows one property's rating
 * on another property's page.
 */
export async function findVerifiedReputations(
  hotelIds: readonly number[],
  q?: Queryable,
): Promise<Map<number, HotelReputation>> {
  const out = new Map<number, HotelReputation>();
  if (hotelIds.length === 0) return out;

  const { rows } = await db(q).query(
    `SELECT id, google_place_id, google_rating, google_user_rating_count,
            google_display_name, google_formatted_address, google_maps_uri,
            google_editorial_summary, google_review_themes, google_fetched_at
       FROM hotel
      WHERE id = ANY($1::int[])
        AND google_match_status = 'VERIFIED'
        AND google_place_id IS NOT NULL`,
    [[...hotelIds]],
  );

  for (const row of rows) out.set(row.id as number, toReputation(row));
  return out;
}

/**
 * The same, keyed by the SOURCE's hotel id.
 *
 * The comp set travels as WhataHotel ids, not internal ones — a comparable is
 * identified by the id the source answers for — so a caller holding a comp set
 * would otherwise have to round-trip through `hotel` to ask this question.
 */
export async function findVerifiedReputationsByWahIds(
  wahHotelIds: readonly string[],
  q?: Queryable,
): Promise<Map<string, HotelReputation>> {
  const out = new Map<string, HotelReputation>();
  if (wahHotelIds.length === 0) return out;

  const { rows } = await db(q).query(
    `SELECT id, wah_hotel_id, google_place_id, google_rating, google_user_rating_count,
            google_display_name, google_formatted_address, google_maps_uri,
            google_editorial_summary, google_review_themes, google_fetched_at
       FROM hotel
      WHERE wah_hotel_id = ANY($1::text[])
        AND google_match_status = 'VERIFIED'
        AND google_place_id IS NOT NULL`,
    [[...wahHotelIds]],
  );

  for (const row of rows) out.set(row.wah_hotel_id as string, toReputation(row));
  return out;
}

/**
 * Hotels to resolve or refresh, never-looked-at first.
 *
 * Never-looked (`google_match_status IS NULL`) outranks stale, because a hotel
 * with no reputation at all is missing a signal while a stale one merely holds
 * an older version of it. UNVERIFIED and NO_MATCH are deliberately excluded:
 * re-asking Google the same question every day buys the same answer and bills
 * for it. Clearing the status is how a retry is requested.
 */
export async function findResolutionTargets(
  limit: number,
  refreshHours: number,
  q?: Queryable,
): Promise<ResolutionTarget[]> {
  const { rows } = await db(q).query(
    `SELECT h.id, h.name, d.name AS city, h.latitude, h.longitude,
            h.coordinate_source, h.street_address, h.google_place_id
       FROM hotel h
       LEFT JOIN destination d ON d.id = h.destination_id
      WHERE h.is_active
        AND (
          h.google_match_status IS NULL
          OR (h.google_match_status = 'VERIFIED'
              AND (h.google_fetched_at IS NULL
                   OR h.google_fetched_at < now() - ($2 || ' hours')::interval))
        )
      ORDER BY (h.google_match_status IS NOT NULL), h.google_fetched_at NULLS FIRST, h.id
      LIMIT $1`,
    [limit, refreshHours],
  );

  return rows.map((row) => ({
    hotelId: row.id as number,
    name: row.name as string,
    city: (row.city as string) ?? null,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    streetAddress: (row.street_address as string) ?? null,
    coordinateSource: (row.coordinate_source as 'SOURCE' | 'GOOGLE') ?? null,
    placeId: (row.google_place_id as string) ?? null,
  }));
}

/**
 * The hotels a verified match already knows the position of, and we do not.
 *
 * These arose from the bug migration 0018 fixes: every VERIFIED match carried
 * Google's own coordinates and the write path discarded them. They cannot be
 * reached through findResolutionTargets in any affordable way — it orders
 * never-looked hotels first and the refresh tail behind them is every VERIFIED
 * hotel in the catalogue, so draining to these few means paying for thousands
 * of Place Details calls to find seventeen.
 *
 * Asking for them directly costs one Details call each and no Text Search at
 * all: they hold a place_id, so resolveHotel refreshes rather than re-matching.
 * Served by hotel_verified_unplaced_idx.
 *
 * Deliberately NOT merged into findResolutionTargets. That queue answers "what
 * is stale"; this one answers "what did we drop on the floor", and folding the
 * second into the first would make an ordinary sweep quietly re-fetch a
 * backfill population forever.
 */
export async function findUnplacedVerifiedTargets(
  limit: number,
  q?: Queryable,
): Promise<ResolutionTarget[]> {
  const { rows } = await db(q).query(
    `SELECT h.id, h.name, d.name AS city, h.latitude, h.longitude,
            h.coordinate_source, h.street_address, h.google_place_id
       FROM hotel h
       LEFT JOIN destination d ON d.id = h.destination_id
      WHERE h.is_active
        AND h.google_match_status = 'VERIFIED'
        AND h.google_place_id IS NOT NULL
        AND (h.latitude IS NULL OR h.longitude IS NULL)
      ORDER BY h.id
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    hotelId: row.id as number,
    name: row.name as string,
    city: (row.city as string) ?? null,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    streetAddress: (row.street_address as string) ?? null,
    coordinateSource: (row.coordinate_source as 'SOURCE' | 'GOOGLE') ?? null,
    placeId: (row.google_place_id as string) ?? null,
  }));
}

/**
 * Record the outcome of a resolution attempt.
 *
 * A non-VERIFIED outcome nulls the reputation columns rather than leaving the
 * previous values behind. If a match stops agreeing — the hotel was renamed,
 * the threshold moved, Google merged two places — the safe state is no data,
 * not yesterday's data attributed to a mapping we no longer trust.
 *
 * ── The position is the exception, in both directions ─────────────────────
 *
 * A VERIFIED match arrives holding the place's own coordinates, and they are
 * written ONLY to a hotel that has none, stamped coordinate_source = 'GOOGLE'
 * so the resolver knows never to let them corroborate a Google candidate
 * later. A hotel that already has coordinates keeps them: those are what
 * whatahotel.com says about its own property, and overwriting them with a
 * third party's reading would silently move a hotel nobody asked to move.
 *
 * And unlike the reputation columns, a non-VERIFIED outcome does NOT clear the
 * position. A hotel's location does not become unknown because a name match
 * stopped clearing a confidence threshold, and blanking it would drop the
 * hotel out of every competitive radius at once. Coordinates are only ever
 * added here, never removed.
 */
export async function saveResolution(
  hotelId: number,
  result: ResolutionResult,
  q?: Queryable,
): Promise<void> {
  const verified = result.status === 'VERIFIED';
  await db(q).query(
    `UPDATE hotel
        SET google_place_id          = $2,
            google_match_status      = $3::google_match_status_t,
            -- A refresh of an existing mapping passes null: the match was
            -- decided once and a refresh does not re-earn its confidence.
            -- A non-VERIFIED outcome clears it along with everything else.
            google_match_confidence  = CASE WHEN $3 = 'VERIFIED'
                                            THEN COALESCE($4, google_match_confidence)
                                            ELSE NULL END,
            google_rating            = $5,
            google_user_rating_count = $6,
            google_display_name      = $7,
            google_formatted_address = $8,
            google_maps_uri          = $9,
            google_editorial_summary = $10,
            google_review_themes     = $11,
            -- Add-only, and only from a VERIFIED match. COALESCE keeps an
            -- existing position untouched; the WHEN guards stop a doubtful
            -- match writing one at all.
            latitude                 = CASE WHEN $3 = 'VERIFIED'
                                            THEN COALESCE(latitude, $12)
                                            ELSE latitude END,
            longitude                = CASE WHEN $3 = 'VERIFIED'
                                            THEN COALESCE(longitude, $13)
                                            ELSE longitude END,
            -- Provenance follows the position it describes, so the CHECK
            -- constraint in migration 0018 holds on every path through here.
            coordinate_source        = CASE
                WHEN coordinate_source IS NOT NULL THEN coordinate_source
                WHEN $3 = 'VERIFIED' AND latitude IS NULL AND longitude IS NULL
                     AND $12::numeric IS NOT NULL AND $13::numeric IS NOT NULL
                    THEN 'GOOGLE'::hotel_coordinate_source_t
                ELSE coordinate_source END,
            google_fetched_at        = now()
      WHERE id = $1`,
    [
      hotelId,
      result.placeId ?? null,
      result.status,
      result.confidence ?? null,
      verified ? (result.rating ?? null) : null,
      verified ? (result.userRatingCount ?? null) : null,
      verified ? (result.displayName ?? null) : null,
      verified ? (result.formattedAddress ?? null) : null,
      verified ? (result.mapsUri ?? null) : null,
      verified ? (result.editorialSummary ?? null) : null,
      verified ? (result.reviewThemes ?? null) : null,
      verified ? (result.latitude ?? null) : null,
      verified ? (result.longitude ?? null) : null,
    ],
  );
}
