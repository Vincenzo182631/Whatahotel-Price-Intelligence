/**
 * Researching one hotel, and the outcomes that write nothing.
 *
 * Every path is named because a silent skip is indistinguishable from a
 * property that genuinely offers nothing — the same reason
 * syncHotelAmenities names its six (rule 29). And every failure path still
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
