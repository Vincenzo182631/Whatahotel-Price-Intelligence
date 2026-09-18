/**
 * Researched claims: what a hotel's own website says, and where we read it
 * (migration 0022).
 *
 * Not a fact table for scoring. Nothing under `packages/core/src/scoring` may
 * read this, for rule 21's reason — it would be an uncalibrated term nobody
 * reviewed. It informs what a guest reads about a property, never the number.
 */
import { db, type Queryable } from '../client.js';

export interface ResearchClaimRow {
  readonly motivator: string;
  readonly claim: string;
  readonly sourceUrl: string;
}

/** The site we resolved for this hotel, or null when we have not resolved one. */
export async function findHotelWebsite(hotelId: number, q?: Queryable): Promise<string | null> {
  const { rows } = await db(q).query('SELECT website_url FROM hotel WHERE id = $1', [hotelId]);
  const url = rows[0]?.website_url as string | null | undefined;
  return url && url.trim() !== '' ? url : null;
}

/**
 * Record the resolved site and that research ran.
 *
 * `researched_at` is stamped whether or not anything was found, so a hotel
 * whose site cannot be resolved backs off instead of costing a search on
 * every page view — the same reason `collection_attempt` exists (rule 16).
 * A null URL never overwrites a known one: failing to resolve today is not
 * evidence that yesterday's answer was wrong.
 */
export async function saveHotelResearchTarget(
  hotelId: number,
  websiteUrl: string | null,
  q?: Queryable,
): Promise<void> {
  await db(q).query(
    `UPDATE hotel
        SET website_url = COALESCE($2, website_url),
            researched_at = now()
      WHERE id = $1`,
    [hotelId, websiteUrl],
  );
}

/**
 * Replace this hotel's claims with what the latest read found.
 *
 * REPLACE rather than accumulate, which is the opposite of `hotel_amenity`
 * (rule 29) and deliberately so. An amenity list is the source stating its
 * own inventory, and a thin response is indistinguishable from a removal. A
 * website is a live document: when a property closes its spa it takes the
 * word off the page, and a claim we keep citing after that is one a guest
 * can open the link and disprove. Freshness beats completeness when the
 * citation is checkable.
 *
 * One transaction, so a hotel is never left with half its claims.
 */
export async function replaceResearchClaims(
  hotelId: number,
  claims: readonly ResearchClaimRow[],
  q?: Queryable,
): Promise<number> {
  const runner = db(q);
  await runner.query('DELETE FROM hotel_research_claim WHERE hotel_id = $1', [hotelId]);
  if (claims.length === 0) return 0;
  const { rowCount } = await runner.query(
    `INSERT INTO hotel_research_claim (hotel_id, motivator, claim, source_url)
     SELECT $1, m, c, u
       FROM unnest($2::text[], $3::text[], $4::text[]) AS t(m, c, u)
     ON CONFLICT (hotel_id, motivator, claim) DO UPDATE
        SET source_url = EXCLUDED.source_url,
            fetched_at = now()`,
    [
      hotelId,
      claims.map((c) => c.motivator),
      claims.map((c) => c.claim),
      claims.map((c) => c.sourceUrl),
    ],
  );
  return rowCount ?? 0;
}

/** Everything researched for this hotel, for the serving path. */
export async function findResearchClaims(
  hotelId: number,
  q?: Queryable,
): Promise<readonly ResearchClaimRow[]> {
  const { rows } = await db(q).query(
    `SELECT motivator, claim, source_url
       FROM hotel_research_claim
      WHERE hotel_id = $1
      ORDER BY motivator, claim`,
    [hotelId],
  );
  return rows.map((r) => ({
    motivator: r.motivator as string,
    claim: r.claim as string,
    sourceUrl: r.source_url as string,
  }));
}

/**
 * Hotels worth researching: catalogued, active, and never researched or long
 * stale.
 *
 * Ordered never-researched first, so a first pass covers ground rather than
 * refreshing the same properties. A hotel's own website changes on the
 * timescale of a redesign, so the default interval is long — every search
 * and every fetch is spend, and Brave's free credit is 1,000 requests a
 * month.
 */
export async function findHotelsNeedingResearch(
  limit: number,
  staleAfterDays = 90,
  q?: Queryable,
): Promise<readonly { hotelId: number; name: string; city: string | null }[]> {
  const { rows } = await db(q).query(
    `SELECT h.id, h.name, d.name AS city
       FROM hotel h
       LEFT JOIN destination d ON d.id = h.destination_id
      WHERE h.is_active
        AND h.name IS NOT NULL
        AND (h.researched_at IS NULL OR h.researched_at < now() - ($2 || ' days')::interval)
      ORDER BY h.researched_at ASC NULLS FIRST, h.id ASC
      LIMIT $1`,
    [limit, String(staleAfterDays)],
  );
  return rows.map((r) => ({
    hotelId: r.id as number,
    name: r.name as string,
    city: (r.city as string | null) ?? null,
  }));
}

/**
 * Other hotels already pointing at this website.
 *
 * The check that generalises. A host claimed by more than one hotel is a
 * BRAND domain by definition — no property's own site is shared — and that
 * is how four separate Ritz-Carltons all came to resolve to ritzcarlton.com
 * on 2026-09-18, each passing a name check that "ritzcarlton" satisfies for
 * every Ritz-Carlton on earth.
 *
 * Returns the other hotels' ids so the caller can clear THEIRS too: if two
 * hotels claim one domain, neither claim is right, and leaving the first one
 * standing would keep whichever hotel happened to be researched first.
 */
export async function findOtherHotelsWithWebsite(
  hotelId: number,
  websiteUrl: string,
  q?: Queryable,
): Promise<readonly number[]> {
  const { rows } = await db(q).query('SELECT id FROM hotel WHERE website_url = $2 AND id <> $1', [
    hotelId,
    websiteUrl,
  ]);
  return rows.map((r) => r.id as number);
}

/** Forget a resolved site and everything read from it. */
export async function clearHotelResearch(hotelId: number, q?: Queryable): Promise<void> {
  const runner = db(q);
  await runner.query('DELETE FROM hotel_research_claim WHERE hotel_id = $1', [hotelId]);
  await runner.query('UPDATE hotel SET website_url = NULL WHERE id = $1', [hotelId]);
}
