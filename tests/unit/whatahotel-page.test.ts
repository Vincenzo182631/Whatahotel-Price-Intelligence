/**
 * The public hotel page, and the address it lets the Google matcher use.
 *
 * Both fixtures are real captures. The tests that matter most are the ones
 * asserting what is NOT read and what an address is NOT allowed to do — a
 * street address that could reject a candidate, or an SEO constant that
 * reached the scoring layer, would each be a quiet correctness failure rather
 * than a visible one.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseHotelPage } from '../../packages/ingest/src/adapters/whatahotel/page.js';
import {
  addressCanConfirm,
  addressConfirms,
  scoreMatch,
} from '../../packages/ingest/src/adapters/google/match.js';
import type {
  HotelIdentity,
  PlaceCandidate,
} from '../../packages/ingest/src/adapters/google/match.js';

const page = (id: string): string =>
  readFileSync(new URL(`../fixtures/whatahotel/pages/hotel-${id}.html`, import.meta.url), 'utf8');

describe('parsing a hotel page', () => {
  it('reads the street address out of the structured data', () => {
    const parsed = parseHotelPage(page('1198'));
    expect(parsed.name).toBe('The Ritz-Carlton, Key Biscayne');
    expect(parsed.streetAddress).toBe('455 Grand Bay Drive');
    expect(parsed.locality).toBe('Miami');
    expect(parsed.country).toBe('USA');
  });

  it('reads the not-bookable notice', () => {
    expect(parseHotelPage(page('3094')).bookableOnline).toBe(false);
  });

  it('leaves bookability null when the page does not raise it', () => {
    // Absence of the notice is not a statement that the property IS bookable,
    // and storing it as one would put a claim in the database that nothing
    // measured.
    expect(parseHotelPage(page('1198')).bookableOnline).toBeNull();
  });

  it('returns nothing at all for a page with no hotel on it', () => {
    const parsed = parseHotelPage('<html><body><h1>Not found</h1></body></html>');
    expect(parsed.name).toBeNull();
    expect(parsed.streetAddress).toBeNull();
    expect(parsed.bookableOnline).toBeNull();
  });

  it('survives a malformed JSON-LD block by reading the next one', () => {
    const html =
      '<script type="application/ld+json">{ oops, }</script>' +
      '<script type="application/ld+json">' +
      '{"@type":"Hotel","name":"X","address":{"streetAddress":"1 Test St"}}' +
      '</script>';
    expect(parseHotelPage(html).streetAddress).toBe('1 Test St');
  });

  it('does NOT surface the SEO template fields as if they were data', () => {
    // starRating, priceRange and amenityFeature are byte-identical on every
    // hotel measured (5 / "$$$$" / the same five perks). They are in both
    // fixtures and must not be reachable: a constant that reads as a quality
    // signal is worse than no signal, because it looks like evidence.
    expect(page('1198')).toContain('starRating');
    expect(Object.keys(parseHotelPage(page('1198')))).toEqual([
      'streetAddress',
      'locality',
      'country',
      'postalCode',
      'bookableOnline',
      'name',
    ]);
  });
});

describe('street addresses as geographic evidence', () => {
  it('agrees across differing suffix spellings and trailing detail', () => {
    expect(
      addressConfirms('455 Grand Bay Drive', '455 Grand Bay Dr, Key Biscayne, FL 33149, USA'),
    ).toBe(true);
  });

  it('agrees where the house number trails the street, as most of Europe writes it', () => {
    expect(addressConfirms('Mitropoleos 49', 'Mitropoleos 49, Athina 105 56, Greece')).toBe(true);
  });

  it('needs BOTH a shared number and a shared street', () => {
    // Either alone is near-worthless: house number 1 is shared by half a city,
    // and one destination holds a dozen "Ocean Drive"s.
    expect(addressConfirms('455 Grand Bay Drive', '455 Collins Avenue, Miami Beach')).toBe(false);
    expect(addressConfirms('455 Grand Bay Drive', '1200 Grand Bay Drive, Miami')).toBe(false);
  });

  it('says nothing when either side states no house number', () => {
    // "Conference Centre Street, Doha" is a real catalogue address. Unknown is
    // the honest answer; it must not read as agreement.
    expect(addressConfirms('Conference Centre Street', 'Conference Centre St, Doha, Qatar')).toBe(
      false,
    );
    expect(addressConfirms(null, '455 Grand Bay Dr')).toBe(false);
  });
});

describe('what an address does to a match', () => {
  const candidate = (over: Partial<PlaceCandidate> = {}): PlaceCandidate => ({
    placeId: 'p1',
    displayName: 'The Ritz-Carlton Key Biscayne, Miami',
    formattedAddress: '455 Grand Bay Dr, Key Biscayne, FL 33149, USA',
    latitude: 25.6906,
    longitude: -80.1631,
    ...over,
  });
  const hotel = (over: Partial<HotelIdentity> = {}): HotelIdentity => ({
    name: 'The Ritz-Carlton, Key Biscayne',
    city: 'Miami',
    latitude: null,
    longitude: null,
    streetAddress: null,
    ...over,
  });

  it('lifts the no-coordinates ceiling that name similarity cannot', () => {
    const capped = scoreMatch(hotel(), candidate());
    expect(capped.confidence).toBeLessThanOrEqual(0.65);

    const withAddress = scoreMatch(hotel({ streetAddress: '455 Grand Bay Drive' }), candidate());
    expect(withAddress.confidence).toBeGreaterThan(0.7);
    expect(withAddress.reasons).toContain('street address agrees');
  });

  it('NEVER refutes — a disagreeing address leaves the candidate where it was', () => {
    // Two records of one property routinely differ on the house number, and a
    // false refutation is permanent: UNVERIFIED is never retried.
    const wrong = scoreMatch(hotel({ streetAddress: '101 Somewhere Else Road' }), candidate());
    const silent = scoreMatch(hotel(), candidate());
    expect(wrong.confidence).toBe(silent.confidence);
  });

  it('leaves distance as the arbiter wherever coordinates exist', () => {
    // A right-looking address must not rescue a candidate 40km away.
    const far = scoreMatch(
      hotel({ latitude: 25.69, longitude: -80.16, streetAddress: '455 Grand Bay Drive' }),
      candidate({ latitude: 26.1, longitude: -80.4 }),
    );
    expect(far.confidence).toBe(0);
  });
});

describe('whether an address is worth spending a lookup on', () => {
  // This gate is not an optimisation. UNVERIFIED is never re-queued, so a call
  // that cannot possibly clear the bar does not merely waste money — it spends
  // the hotel's ONE retry on an outcome fixed before the request left. Gating
  // on merely HAVING an address retired 35 hotels in a single production
  // sweep, which is precisely what SKIPPED_NO_GEO exists to prevent.
  it('says yes only when a house number is present to match on', () => {
    expect(addressCanConfirm('455 Grand Bay Drive')).toBe(true);
    expect(addressCanConfirm('Mitropoleos 49')).toBe(true);
    expect(addressCanConfirm('L.G. Smith Blvd # 103')).toBe(true);
  });

  it('says no to the addresses that can never lift the ceiling', () => {
    // All three are real catalogue addresses.
    expect(addressCanConfirm('Conference Centre Street')).toBe(false);
    expect(addressCanConfirm('Centre Park House')).toBe(false);
    expect(addressCanConfirm('Triple Bay')).toBe(false);
    expect(addressCanConfirm(null)).toBe(false);
    expect(addressCanConfirm('')).toBe(false);
  });

  it('agrees with addressConfirms — anything it rejects could never have matched', () => {
    for (const ours of ['Conference Centre Street', 'Centre Park House', 'Triple Bay']) {
      expect(addressCanConfirm(ours)).toBe(false);
      expect(addressConfirms(ours, '1 Conference Centre Street, Doha, Qatar')).toBe(false);
    }
  });
});
