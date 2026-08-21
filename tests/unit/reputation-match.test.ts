/**
 * Matching a hotel to a Google place, and refusing to when unsure.
 *
 * The failure this guards against is quiet: a plausible mismatch shows one
 * property's reputation on another property's page, and nothing about the
 * rendered result looks wrong. So the tests are mostly about the cases where
 * the right answer is "no".
 *
 * Pure — no key, no network, no database.
 */

import { describe, expect, it } from 'vitest';

import {
  bestMatch,
  distanceKm,
  normalizeName,
  scoreMatch,
  type PlaceCandidate,
} from '../../packages/ingest/src/adapters/google/match.js';
import {
  resolveHotel,
  searchQuery,
  type ResolvableHotel,
} from '../../packages/ingest/src/adapters/google/resolve.js';
import type { PlacesClient } from '../../packages/ingest/src/adapters/google/places.js';

const MIN = 0.7;

const MIAMI: ResolvableHotel = {
  hotelId: 1,
  name: 'Four Seasons Hotel Miami',
  city: 'Miami',
  latitude: 25.7663,
  longitude: -80.1902,
  placeId: null,
};

const candidate = (over: Partial<PlaceCandidate> = {}): PlaceCandidate => ({
  placeId: 'place-1',
  displayName: 'Four Seasons Hotel Miami',
  formattedAddress: '1435 Brickell Ave, Miami, FL',
  latitude: 25.7664,
  longitude: -80.1903,
  ...over,
});

describe('normalizeName', () => {
  it('strips the words every hotel name contains', () => {
    expect(normalizeName('The Ritz-Carlton Hotel & Spa, Key Biscayne')).toBe(
      'ritz carlton key biscayne',
    );
  });

  it('folds accents rather than treating them as different letters', () => {
    expect(normalizeName('Hôtel Café Royal')).toBe(normalizeName('Hotel Cafe Royal'));
  });
});

describe('distanceKm', () => {
  it('is metres-accurate over short spans', () => {
    // ~0.011km — the two coordinate sets above.
    expect(distanceKm(25.7663, -80.1902, 25.7664, -80.1903)).toBeLessThan(0.05);
  });
});

describe('scoreMatch', () => {
  it('is confident when the name agrees and the coordinates coincide', () => {
    const score = scoreMatch(MIAMI, candidate());
    expect(score.confidence).toBeGreaterThanOrEqual(MIN);
  });

  it('rejects a same-brand property in another city outright', () => {
    // Palm Beach is ~100km up the coast. The names share most of their words,
    // which is exactly why distance has to be able to overrule them.
    const score = scoreMatch(MIAMI, {
      ...candidate({
        placeId: 'place-2',
        displayName: 'Four Seasons Resort Palm Beach',
        formattedAddress: '2800 S Ocean Blvd, Palm Beach, FL',
        latitude: 26.6706,
        longitude: -80.0364,
      }),
    });
    expect(score.confidence).toBe(0);
  });

  it('will not clear the bar without coordinates, however well the name reads', () => {
    const blind = { ...MIAMI, latitude: null, longitude: null };
    const score = scoreMatch(blind, candidate());
    // The city bonus must not lift it back over the ceiling — the ceiling
    // exists precisely because the decisive evidence is missing.
    expect(score.confidence).toBeLessThanOrEqual(0.65);
    expect(score.confidence).toBeLessThan(MIN);
  });

  it('does not let a shared city rescue a name that does not match', () => {
    const score = scoreMatch(MIAMI, {
      ...candidate({ displayName: 'Mandarin Oriental Miami', placeId: 'place-3' }),
      latitude: 25.7663,
      longitude: -80.1902,
    });
    // Same coordinates would be decisive corroboration for a matching name;
    // here the name carries nothing, so the total stays below the bar.
    expect(score.confidence).toBeLessThan(MIN);
  });
});

describe('bestMatch', () => {
  it('returns nothing when the best candidate is still below the bar', () => {
    expect(bestMatch(MIAMI, [candidate({ displayName: 'Some Other Place' })], MIN)).toBeNull();
  });

  it('picks the strongest candidate, not the first', () => {
    const match = bestMatch(
      MIAMI,
      [candidate({ placeId: 'weak', displayName: 'Four Seasons Residences' }), candidate()],
      MIN,
    );
    expect(match?.candidate.placeId).toBe('place-1');
  });
});

/** A PlacesClient stand-in. No key, no network, no fetch. */
function fakeClient(over: Partial<Record<'search' | 'details', unknown>>): PlacesClient {
  return {
    searchText: async () => over.search as never,
    details: async () => (over.details ?? null) as never,
  } as unknown as PlacesClient;
}

describe('resolveHotel', () => {
  it('names the hotel and its city in the query', () => {
    expect(searchQuery(MIAMI)).toBe('Four Seasons Hotel Miami Miami');
  });

  it('VERIFIES a strong match and carries the rating through', async () => {
    const outcome = await resolveHotel(
      fakeClient({
        search: [candidate()],
        details: {
          ...candidate(),
          rating: 4.6,
          userRatingCount: 3200,
          mapsUri: 'https://maps.google.com/?cid=1',
        },
      }),
      MIAMI,
      MIN,
    );
    expect(outcome.status).toBe('VERIFIED');
    if (outcome.status !== 'VERIFIED') return;
    expect(outcome.rating).toBe(4.6);
    expect(outcome.userRatingCount).toBe(3200);
  });

  it('records UNVERIFIED with no data when nothing clears the bar', async () => {
    const outcome = await resolveHotel(
      fakeClient({ search: [candidate({ displayName: 'Unrelated Inn' })] }),
      MIAMI,
      MIN,
    );
    expect(outcome.status).toBe('UNVERIFIED');
    if (outcome.status === 'FAILED') return;
    // A doubtful match's data is never kept — not even provisionally.
    expect(outcome.placeId).toBeNull();
    expect(outcome.rating).toBeNull();
  });

  it('records NO_MATCH when Google answers and knows of nothing', async () => {
    const outcome = await resolveHotel(fakeClient({ search: [] }), MIAMI, MIN);
    expect(outcome.status).toBe('NO_MATCH');
  });

  it('writes NOTHING when the call itself failed', async () => {
    // The distinction that matters: recording NO_MATCH on a timeout would
    // retire the hotel from reputation forever over a four-second blip,
    // because the queue deliberately never revisits a NO_MATCH.
    const outcome = await resolveHotel(fakeClient({ search: null }), MIAMI, MIN);
    expect(outcome.status).toBe('FAILED');
  });

  it('refreshes an existing mapping without re-searching', async () => {
    let searched = false;
    const client = {
      searchText: async () => {
        searched = true;
        return [];
      },
      details: async () => ({
        ...candidate(),
        rating: 4.4,
        userRatingCount: 1200,
        mapsUri: null,
      }),
    } as unknown as PlacesClient;

    const outcome = await resolveHotel(client, { ...MIAMI, placeId: 'place-1' }, MIN);
    expect(searched).toBe(false);
    expect(outcome.status).toBe('VERIFIED');
    if (outcome.status === 'FAILED') return;
    // Null confidence: a refresh does not re-earn the original match's score,
    // and the repository leaves the stored value alone when given null.
    expect(outcome.confidence).toBeNull();
  });

  it('leaves a refresh that failed unwritten rather than clearing the mapping', async () => {
    const outcome = await resolveHotel(
      fakeClient({ details: null }),
      { ...MIAMI, placeId: 'place-1' },
      MIN,
    );
    expect(outcome.status).toBe('FAILED');
  });
});
