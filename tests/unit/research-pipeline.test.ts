/**
 * Researching one hotel, and the outcomes that write nothing.
 *
 * Every path is named because a silent skip is indistinguishable from a
 * property that genuinely offers nothing — the same reason
 * syncHotelAmenities names each of its own (rule 29). And every failure path still
 * stamps researched_at, so a hotel that cannot be resolved backs off rather
 * than costing a search on every page view (rule 16).
 */
import { describe, expect, it, vi } from 'vitest';
import { researchHotel } from '../../packages/ingest/src/pipeline/research.js';

const hotel = { hotelId: 7, name: 'Pink Palace Resort', city: 'Honolulu' };

function deps(over: Partial<Parameters<typeof researchHotel>[1]> = {}) {
  return {
    client: {
      search: vi.fn(async () => ({
        web: { results: [{ url: 'https://www.pinkpalaceresort.com/rooms' }] },
      })),
    } as never,
    findHotelWebsite: vi.fn(async () => null),
    saveHotelResearchTarget: vi.fn(async () => {}),
    replaceResearchClaims: vi.fn(async () => 0),
    findOtherHotelsWithWebsite: vi.fn(async () => [] as readonly number[]),
    clearHotelResearch: vi.fn(async () => {}),
    fetchPage: vi.fn(async () => '<html><body><p>Our private beach and spa.</p></body></html>'),
    ...over,
  };
}

describe('researchHotel', () => {
  it('resolves, reads and stores claims that cite the page', async () => {
    const d = deps();
    const result = await researchHotel(hotel, d);
    expect(result.outcome).toBe('STORED');
    expect(result.websiteUrl).toBe('https://pinkpalaceresort.com/');
    expect(result.claims.every((c) => c.sourceUrl === result.websiteUrl)).toBe(true);
    expect(result.claims.some((c) => c.motivator === 'BEACH_RESORT')).toBe(true);
  });

  it('spends no search when the site is already resolved', async () => {
    // Resolution is the expensive half; re-reading the page is free.
    const d = deps({ findHotelWebsite: vi.fn(async () => 'https://known.example/') });
    await researchHotel(hotel, d);
    expect(d.client.search).not.toHaveBeenCalled();
  });

  it('records an unresolvable hotel so it backs off', async () => {
    const d = deps({
      client: { search: vi.fn(async () => ({ web: { results: [] } })) } as never,
    });
    const result = await researchHotel(hotel, d);
    expect(result.outcome).toBe('NO_WEBSITE');
    // Stamped anyway, or every page view pays for the same failed search.
    expect(d.saveHotelResearchTarget).toHaveBeenCalledWith(7, null);
    expect(d.replaceResearchClaims).not.toHaveBeenCalled();
  });

  it('keeps an unreadable page apart from a page that said nothing', async () => {
    const unreadable = deps({ fetchPage: vi.fn(async () => null) });
    expect((await researchHotel(hotel, unreadable)).outcome).toBe('UNREADABLE');
    // Nothing is written: a cookie wall is not a hotel without a spa.
    expect(unreadable.replaceResearchClaims).not.toHaveBeenCalled();

    const silent = deps({ fetchPage: vi.fn(async () => '<html><body>Welcome.</body></html>') });
    expect((await researchHotel(hotel, silent)).outcome).toBe('NOTHING_STATED');
  });

  it("never attaches another property's website", async () => {
    // "Four Seasons Hotel Miami" and "Four Seasons Resort Palm Beach" share
    // most of their words (rule 22). A result the name cannot corroborate is
    // skipped rather than guessed at.
    const d = deps({
      client: {
        search: vi.fn(async () => ({
          web: { results: [{ url: 'https://someotherhotel.example/' }] },
        })),
      } as never,
    });
    expect((await researchHotel(hotel, d)).outcome).toBe('NO_WEBSITE');
  });

  it('skips aggregators however well they rank', async () => {
    const d = deps({
      client: {
        search: vi.fn(async () => ({
          web: {
            results: [
              { url: 'https://www.booking.com/hotel/pinkpalaceresort.html' },
              { url: 'https://www.tripadvisor.com/pinkpalaceresort' },
              { url: 'https://www.pinkpalaceresort.com/' },
            ],
          },
        })),
      } as never,
    });
    const result = await researchHotel(hotel, d);
    expect(result.websiteUrl).toBe('https://pinkpalaceresort.com/');
  });

  it('asks the collision question about the DOMAIN, not the URL', async () => {
    // Measured 2026-09-18, third run: com-miami.com served three hotels as
    // w.com-miami.com, east.com-miami.com and ebhotelairport.com-miami.com.
    // Three distinct URL strings never collided with each other, so a
    // directory holding three of our hotels was invisible to the check.
    const d = deps({
      findHotelWebsite: vi.fn(async () => 'https://east.pinkpalaceresort.com/'),
    });
    await researchHotel(hotel, d);
    expect(d.findOtherHotelsWithWebsite).toHaveBeenCalledWith(7, 'pinkpalaceresort.com');
  });

  it('honours a rejection of the directory a subdomain belongs to', async () => {
    // A human rejecting com-miami.com rejects the directory; w.com-miami.com
    // is the same directory wearing one hotel's subdomain.
    const d = deps({
      findHotelWebsite: vi.fn(async () => 'https://east.pinkpalaceresort.com/'),
      rejectedHosts: new Set(['pinkpalaceresort.com']),
    });
    expect((await researchHotel(hotel, d)).outcome).toBe('REJECTED_HOST');
  });

  it('refuses a domain another hotel already claims, and clears both', async () => {
    // Measured 2026-09-18: four separate Ritz-Carltons resolved to
    // ritzcarlton.com and would have shown a guest identical "evidence" for
    // Key Biscayne, Coconut Grove, Turtle Bay and Waikiki. A host claimed by
    // more than one hotel is a brand domain, because no property's own site
    // is shared.
    const d = deps({
      findOtherHotelsWithWebsite: vi.fn(async () => [41, 42] as readonly number[]),
    });
    const result = await researchHotel(hotel, d);
    expect(result.outcome).toBe('SHARED_HOST');
    expect(result.websiteUrl).toBeNull();
    // Both sides go: keeping the first would just reward whichever hotel was
    // researched earliest.
    expect(d.clearHotelResearch).toHaveBeenCalledWith(7);
    expect(d.clearHotelResearch).toHaveBeenCalledWith(41);
    expect(d.clearHotelResearch).toHaveBeenCalledWith(42);
    expect(d.replaceResearchClaims).not.toHaveBeenCalled();
  });

  it('refuses a brand newsroom and a destination marketing site', async () => {
    // press.fourseasons.com is about the chain; miamiandbeaches.com is the
    // Greater Miami tourism board, which stored 11 claims about a city
    // against one hotel.
    for (const url of [
      'https://press.pinkpalaceresort.com/',
      'https://pinkpalaceresortandbeaches.com/',
    ]) {
      const d = deps({
        client: { search: vi.fn(async () => ({ web: { results: [{ url }] } })) } as never,
      });
      expect((await researchHotel(hotel, d)).outcome).toBe('NO_WEBSITE');
    }
  });

  it("honours a human's rejection above every automated check", async () => {
    // The review loop's whole point: automated rules cover what generalises,
    // a person covers the rest, and nobody has to invent a pattern for it.
    const d = deps({ rejectedHosts: new Set(['pinkpalaceresort.com']) });
    const result = await researchHotel(hotel, d);
    expect(result.outcome).toBe('REJECTED_HOST');
    expect(result.claims).toEqual([]);
    expect(d.replaceResearchClaims).not.toHaveBeenCalled();
  });

  it('reports a thrown search as FAILED rather than as an empty hotel', async () => {
    const d = deps({
      client: {
        search: vi.fn(async () => {
          throw new Error('429 rate limited');
        }),
      } as never,
    });
    const result = await researchHotel(hotel, d);
    expect(result.outcome).toBe('FAILED');
    expect(result.claims).toEqual([]);
  });
});
