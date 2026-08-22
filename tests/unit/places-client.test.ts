/**
 * The Google Places client: what it asks for, and what it does when refused.
 *
 * `fetch` is stubbed throughout — no key, no network, no billing. The
 * behaviours worth pinning are the ones that would otherwise be discovered in
 * production: the field mask (an omitted one is a 400, and a widened one is a
 * larger bill), the key living in a header rather than a URL, and every
 * failure path returning nothing rather than a zero.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlacesClient } from '../../packages/ingest/src/adapters/google/places.js';

const ok = (payload: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

const client = () =>
  new PlacesClient({
    apiKey: 'places-key-not-real',
    baseSearchUrl: 'https://example.invalid/search',
    baseDetailsUrl: 'https://example.invalid/places/',
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlacesClient.fromEnv', () => {
  it('is null without a key, so the disabled path cannot be forgotten', () => {
    const saved = process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    expect(PlacesClient.fromEnv()).toBeNull();
    if (saved !== undefined) process.env.GOOGLE_PLACES_API_KEY = saved;
  });
});

describe('searchText', () => {
  it('sends the key as a header and asks only for the fields we store', async () => {
    const spy = ok({ places: [] });
    vi.stubGlobal('fetch', spy);

    await client().searchText('Loews Miami Beach Miami');

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('places-key-not-real');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('places-key-not-real');
    // Places (New) bills by field. Widening this mask is a deliberate edit,
    // so the test names the exact list rather than checking it is non-empty.
    expect(headers['X-Goog-FieldMask']).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location',
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Without this, a search for a hotel returns the restaurant inside it —
    // which then matches on name.
    expect(body.includedType).toBe('lodging');
  });

  it('maps candidates and keeps coordinates, which are what settle a match', async () => {
    vi.stubGlobal(
      'fetch',
      ok({
        places: [
          {
            id: 'p1',
            displayName: { text: 'Loews Miami Beach Hotel' },
            formattedAddress: '1601 Collins Ave, Miami Beach, FL',
            location: { latitude: 25.79, longitude: -80.13 },
          },
        ],
      }),
    );

    const [first] = (await client().searchText('Loews')) ?? [];
    expect(first?.placeId).toBe('p1');
    expect(first?.latitude).toBe(25.79);
  });

  it('drops a candidate with no id or no name rather than inventing one', async () => {
    vi.stubGlobal('fetch', ok({ places: [{ displayName: { text: 'Nameless' } }, { id: 'p2' }] }));
    expect(await client().searchText('x')).toEqual([]);
  });

  it('distinguishes a failed call from an empty answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('quota', { status: 429 })),
    );
    // null, not []. The resolver relies on this: an empty answer is worth
    // recording as NO_MATCH, a quota refusal is not.
    expect(await client().searchText('x')).toBeNull();

    vi.stubGlobal('fetch', ok({}));
    expect(await client().searchText('x')).toEqual([]);
  });

  it('returns nothing when the call throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    expect(await client().searchText('x')).toBeNull();
  });
});

describe('details', () => {
  it('asks for the rating and its count together', async () => {
    const spy = ok({ id: 'p1', displayName: { text: 'X' }, rating: 4.6, userRatingCount: 3200 });
    vi.stubGlobal('fetch', spy);

    const place = await client().details('p1');
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Goog-FieldMask']).toBe(
      'id,displayName,formattedAddress,location,rating,userRatingCount,googleMapsUri,editorialSummary,reviews',
    );
    expect(place?.rating).toBe(4.6);
    expect(place?.userRatingCount).toBe(3200);
  });

  it('reports an unrated place as unrated, never as zero', async () => {
    vi.stubGlobal('fetch', ok({ id: 'p1', displayName: { text: 'X' } }));
    const place = await client().details('p1');
    expect(place?.rating).toBeNull();
    expect(place?.userRatingCount).toBeNull();
  });

  it('drops a rating outside 0–5 rather than storing a misread one', async () => {
    vi.stubGlobal('fetch', ok({ id: 'p1', displayName: { text: 'X' }, rating: 46 }));
    expect((await client().details('p1'))?.rating).toBeNull();
  });

  it('returns null on a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 403 })),
    );
    expect(await client().details('p1')).toBeNull();
  });
});
