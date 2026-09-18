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
 * The stored URL's host, as SQL.
 *
 * Every stored URL is `https://<host>/` (see `resolveHotelWebsite`), so this
 * is a strip rather than a parse: drop the scheme and a leading `www.`, then
 * take everything before the first slash. Kept in one constant because three
 * queries below have to agree on what a host is, and a copy that disagreed
 * would silently match a different set of hotels than the check beside it.
 */
const HOST_SQL = `split_part(regexp_replace(lower(website_url), '^https?://(www\\.)?', ''), '/', 1)`;

/**
 * Other hotels already sitting under this DOMAIN.
 *
 * The check that generalises. A domain claimed by more than one hotel is a
 * BRAND or DIRECTORY domain by definition — no property's own site is shared
 * — and that is how four separate Ritz-Carltons all came to resolve to
 * ritzcarlton.com on 2026-09-18, each passing a name check that
 * "ritzcarlton" satisfies for every Ritz-Carlton on earth.
 *
 * It compares the registrable DOMAIN, not the URL. Measured 2026-09-18,
 * third run: `com-miami.com` served three hotels as `w.com-miami.com`,
 * `east.com-miami.com` and `ebhotelairport.com-miami.com`. Three distinct
 * strings never collided, so a directory holding three of our hotels was
 * invisible to a check comparing full URLs — and all three stored zero
 * claims, which is why no report showed them and only the human review did.
 *
 * The caller supplies the domain because the rule for computing it lives
 * with the resolver (`registrableDomain`); matching a host against a given
 * domain needs no such rule, only an exact match or a dotted suffix, which
 * is what the predicate below is.
 *
 * Returns the other hotels' ids so the caller can clear THEIRS too: if two
 * hotels claim one domain, neither claim is right, and leaving the first one
 * standing would keep whichever hotel happened to be researched first.
 */
export async function findOtherHotelsWithWebsite(
  hotelId: number,
  domain: string,
  q?: Queryable,
): Promise<readonly number[]> {
  const { rows } = await db(q).query(
    `SELECT id FROM hotel
      WHERE website_url IS NOT NULL
        AND id <> $1
        AND (${HOST_SQL} = $2 OR ${HOST_SQL} LIKE '%.' || $2)`,
    [hotelId, domain.toLowerCase()],
  );
  return rows.map((r) => r.id as number);
}

export interface HotelWebsite {
  readonly hotelId: number;
  readonly websiteUrl: string;
}

/** Every resolution we currently hold, for a caller that reconciles them. */
export async function findAllHotelWebsites(q?: Queryable): Promise<readonly HotelWebsite[]> {
  const { rows } = await db(q).query(
    'SELECT id, website_url FROM hotel WHERE website_url IS NOT NULL ORDER BY id',
  );
  return rows.map((r) => ({ hotelId: r.id as number, websiteUrl: r.website_url as string }));
}

/**
 * Forget resolved sites and everything read from them, in bulk.
 *
 * `researched_at` is deliberately LEFT SET: the hotel was researched, the
 * answer was wrong, and re-resolving it on the next run would spend a search
 * to reach the same brand domain. It backs off until the interval expires,
 * which is rule 16's principle.
 */
export async function clearResearchForHotels(
  hotelIds: readonly number[],
  q?: Queryable,
): Promise<void> {
  if (hotelIds.length === 0) return;
  const runner = db(q);
  const ids = [...hotelIds];
  await runner.query('DELETE FROM hotel_research_claim WHERE hotel_id = ANY($1::int[])', [ids]);
  await runner.query('UPDATE hotel SET website_url = NULL WHERE id = ANY($1::int[])', [ids]);
}

/** Forget a resolved site and everything read from it. */
export async function clearHotelResearch(hotelId: number, q?: Queryable): Promise<void> {
  const runner = db(q);
  await runner.query('DELETE FROM hotel_research_claim WHERE hotel_id = $1', [hotelId]);
  await runner.query('UPDATE hotel SET website_url = NULL WHERE id = $1', [hotelId]);
}

/** Hosts a human has judged not to be any property's own site (migration 0023). */
export async function findRejectedHosts(q?: Queryable): Promise<ReadonlySet<string>> {
  const { rows } = await db(q).query('SELECT host FROM research_rejected_host');
  return new Set(rows.map((r) => (r.host as string).toLowerCase()));
}

/**
 * Record a human's judgement and clear what it invalidates.
 *
 * Never called automatically. The automated checks handle what generalises;
 * this is for the cases that do not, and a row here is evidence that somebody
 * looked rather than that a pattern fired.
 */
export async function rejectResearchHost(
  host: string,
  reason: string,
  q?: Queryable,
): Promise<readonly number[]> {
  const runner = db(q);
  const clean = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  await runner.query(
    `INSERT INTO research_rejected_host (host, reason) VALUES ($1, $2)
     ON CONFLICT (host) DO UPDATE SET reason = EXCLUDED.reason, rejected_at = now()`,
    [clean, reason],
  );
  // Everything already read from it goes, and researched_at stays SET so the
  // affected hotels back off rather than re-resolving immediately (rule 16).
  //
  // Matched on the HOST, exactly or as a dotted suffix — never as a substring
  // of the URL. `ILIKE '%ipoolside.com%'` also rejects `notipoolside.com`,
  // and a rejection is a human's judgement about ONE domain; widening it
  // silently would clear hotels nobody looked at.
  const { rows } = await runner.query(
    `SELECT id FROM hotel
      WHERE website_url IS NOT NULL
        AND (${HOST_SQL} = $1 OR ${HOST_SQL} LIKE '%.' || $1)`,
    [clean],
  );
  const ids = rows.map((r) => r.id as number);
  await clearResearchForHotels(ids, runner);
  return ids;
}

export interface ResolutionForReview {
  readonly hotelId: number;
  readonly name: string;
  readonly city: string | null;
  readonly websiteUrl: string;
  readonly claims: number;
}

/** Every current resolution, for a human to rank and judge. */
export async function findResolutionsForReview(
  q?: Queryable,
): Promise<readonly ResolutionForReview[]> {
  const { rows } = await db(q).query(
    `SELECT h.id, h.name, d.name AS city, h.website_url,
            (SELECT count(*) FROM hotel_research_claim c WHERE c.hotel_id = h.id) AS claims
       FROM hotel h
       LEFT JOIN destination d ON d.id = h.destination_id
      WHERE h.website_url IS NOT NULL
      ORDER BY h.id`,
  );
  return rows.map((r) => ({
    hotelId: r.id as number,
    name: r.name as string,
    city: (r.city as string | null) ?? null,
    websiteUrl: r.website_url as string,
    claims: Number(r.claims),
  }));
}
