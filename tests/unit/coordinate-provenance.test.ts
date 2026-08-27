/**
 * Placing a hotel from its Google match, without letting Google confirm itself.
 *
 * Two failures are guarded here, and they pull in opposite directions.
 *
 * The first is the one production had: 17 active hotels were
 * google_match_status = 'VERIFIED' and still carried no coordinates, because
 * ResolutionOutcome dropped the position that both field masks already
 * request. An unplaced hotel is rejected at every rung of the competitive
 * ladder — 2, 3 and 5 miles alike — so it reads as "no comparables" when the
 * truth is "position unknown".
 *
 * The second is the failure that a careless fix introduces: if Google's
 * coordinates are written back and then used to score the NEXT Google
 * candidate, the match corroborates itself and the confidence it earns means
 * nothing. That is the same error the street-address rule exists to prevent,
 * which is why google_formatted_address is deliberately kept apart from the
 * merchant's own street_address.
 *
 * Pure — no key, no network, no database.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveHotel,
  type ResolvableHotel,
} from '../../packages/ingest/src/adapters/google/resolve.js';
import type { PlaceCandidate } from '../../packages/ingest/src/adapters/google/match.js';
import type { PlacesClient } from '../../packages/ingest/src/adapters/google/places.js';

const MIN = 0.7;

const candidate = (over: Partial<PlaceCandidate> = {}): PlaceCandidate => ({
  placeId: 'place-1',
  displayName: 'Four Seasons Hotel Miami',
  formattedAddress: '1435 Brickell Ave, Miami, FL',
  latitude: 25.7664,
  longitude: -80.1903,
  ...over,
});

const UNPLACED: ResolvableHotel = {
  hotelId: 1,
  name: 'Four Seasons Hotel Miami',
  city: 'Miami',
  latitude: null,
  longitude: null,
  // A house number is what lifts the no-coordinates ceiling. See match.ts.
  streetAddress: '1435 Brickell Ave',
  coordinateSource: null,
  placeId: null,
};

/** Records what was asked, so a test can assert nothing was asked at all. */
function spyClient(over: Partial<Record<'search' | 'details', unknown>>): {
  client: PlacesClient;
  searches: string[];
} {
  const searches: string[] = [];
  const client = {
    searchText: async (q: string) => {
      searches.push(q);
      return over.search as never;
    },
    details: async () => (over.details ?? null) as never,
  } as unknown as PlacesClient;
  return { client, searches };
}

describe('a verified match carries the place position', () => {
  it('returns the coordinates Google returned, on a fresh match', async () => {
    const { client } = spyClient({
      search: [candidate()],
      details: { ...candidate(), rating: 4.6, userRatingCount: 3200, mapsUri: null },
    });
    const outcome = await resolveHotel(client, UNPLACED, MIN);

    expect(outcome.status).toBe('VERIFIED');
    if (outcome.status !== 'VERIFIED') return;
    expect(outcome.latitude).toBeCloseTo(25.7664, 4);
    expect(outcome.longitude).toBeCloseTo(-80.1903, 4);
  });

  it('returns them on a REFRESH too, which is how an already-verified hotel gets placed', async () => {
    // The production case exactly: the mapping was made before the outcome
    // carried a position, so the hotel holds a place_id and no coordinates.
    // Nothing needs re-matching — Details has been returning a location all
    // along and the ordinary refresh now stores it.
    const { client, searches } = spyClient({
      details: { ...candidate(), rating: 4.6, userRatingCount: 10, mapsUri: null },
    });
    const outcome = await resolveHotel(client, { ...UNPLACED, placeId: 'place-1' }, MIN);

    expect(outcome.status).toBe('VERIFIED');
    if (outcome.status !== 'VERIFIED') return;
    expect(outcome.latitude).toBeCloseTo(25.7664, 4);
    // And it costs no Text Search call: a refresh never re-decides the match.
    expect(searches).toEqual([]);
  });

  it('holds no position on a doubtful match', async () => {
    const { client } = spyClient({ search: [candidate({ displayName: 'Unrelated Inn' })] });
    const outcome = await resolveHotel(client, UNPLACED, MIN);

    expect(outcome.status).toBe('UNVERIFIED');
    if (outcome.status !== 'UNVERIFIED') return;
    // A place we did not trust enough to store a rating for is not one to
    // take a position from either.
    expect(outcome.latitude).toBeNull();
    expect(outcome.longitude).toBeNull();
  });

  it('holds no position when Google returned nothing', async () => {
    const { client } = spyClient({ search: [] });
    const outcome = await resolveHotel(client, UNPLACED, MIN);

    expect(outcome.status).toBe('NO_MATCH');
    if (outcome.status !== 'NO_MATCH') return;
    expect(outcome.latitude).toBeNull();
  });
});

describe('Google-derived coordinates cannot corroborate a Google candidate', () => {
  // The narrow path: a hotel placed by an earlier match, whose place_id was
  // later cleared to request a re-match. Its coordinates are Google's own
  // claim, so they are not evidence about the hotel.
  const RE_MATCHED: ResolvableHotel = {
    ...UNPLACED,
    latitude: 25.7664,
    longitude: -80.1903,
    coordinateSource: 'GOOGLE',
    streetAddress: null,
    placeId: null,
  };

  it('does not ask Google at all when the only geography we hold came from Google', async () => {
    const { client, searches } = spyClient({ search: [candidate()] });
    const outcome = await resolveHotel(client, RE_MATCHED, MIN);

    // Identical to a hotel that was never placed: no usable independent
    // geography, so no candidate could honestly clear the bar.
    expect(outcome.status).toBe('SKIPPED_NO_GEO');
    // And crucially, no billed call was made to discover that.
    expect(searches).toEqual([]);
  });

  it('still asks when an independent street address is held', async () => {
    const { client, searches } = spyClient({
      search: [candidate()],
      details: { ...candidate(), rating: 4.4, userRatingCount: 90, mapsUri: null },
    });
    // The address comes from the merchant's own page, not from Google, so it
    // is independent evidence and the ask is honest.
    const outcome = await resolveHotel(
      client,
      { ...RE_MATCHED, streetAddress: '1435 Brickell Ave' },
      MIN,
    );

    expect(searches).toHaveLength(1);
    expect(outcome.status).toBe('VERIFIED');
  });

  it('treats SOURCE coordinates as the real evidence they are', async () => {
    const { client, searches } = spyClient({
      search: [candidate()],
      details: { ...candidate(), rating: 4.6, userRatingCount: 3200, mapsUri: null },
    });
    const outcome = await resolveHotel(client, { ...RE_MATCHED, coordinateSource: 'SOURCE' }, MIN);

    expect(searches).toHaveLength(1);
    expect(outcome.status).toBe('VERIFIED');
  });

  it('reads an absent provenance as SOURCE, so pre-0018 rows are unaffected', async () => {
    // Every row placed before the migration came from the catalogue, and the
    // migration backfills them to say so. A caller that omits the field must
    // not have its hotel silently retired from matching.
    const { client, searches } = spyClient({
      search: [candidate()],
      details: { ...candidate(), rating: 4.6, userRatingCount: 3200, mapsUri: null },
    });
    const { coordinateSource: _omitted, ...withoutProvenance } = RE_MATCHED;
    const outcome = await resolveHotel(client, withoutProvenance, MIN);

    expect(searches).toHaveLength(1);
    expect(outcome.status).toBe('VERIFIED');
  });
});
