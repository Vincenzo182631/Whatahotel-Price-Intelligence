/**
 * Which currency an unpinned request is answered in (rule 18).
 *
 * The source prices in the HOTEL's currency — Doha in QAR, Paris in EUR — and
 * every stored-rate query filters on currency, correctly, because mixing them
 * would compare 1,600 QAR to 1,600 USD. So a hard-coded USD default does not
 * return a wrong price, it returns NO price: the endpoint reports "no rate for
 * these dates" while holding a perfectly good rate it refused to look at.
 *
 * The scoring path was fixed for this in August; the supporting endpoints kept
 * the old default until 2026-09-16, when asking the comparables endpoint about
 * Four Seasons Paris George V answered empty for a stay we held three
 * euro-priced peers for.
 */

import { describe, expect, it } from 'vitest';

import { currencyFor } from '../../apps/api/src/http.js';

const url = (qs = ''): URL => new URL(`https://api.test/api/v1/thing${qs}`);

describe('the currency an answer is given in', () => {
  it("defaults to the hotel's own currency, not the caller's", () => {
    expect(currencyFor(url(), 'EUR')).toBe('EUR');
    expect(currencyFor(url(), 'QAR')).toBe('QAR');
  });

  it('obeys an explicit pin exactly', () => {
    // Pinning means what it says: that currency or nothing. We hold no FX
    // rates, and inventing one would put a fabricated number in front of a
    // customer, so a pin is never silently substituted.
    expect(currencyFor(url('?currency=USD'), 'EUR')).toBe('USD');
    expect(currencyFor(url('?currency=eur'), 'QAR')).toBe('EUR');
  });

  it('falls back to USD only for a hotel we have never priced', () => {
    expect(currencyFor(url(), null)).toBe('USD');
  });

  it('treats an empty currency parameter as unpinned', () => {
    // ?currency= is what a form submits when the field was left blank, and
    // reading it as a pin would answer in a currency nobody asked for.
    expect(currencyFor(url('?currency='), 'EUR')).toBe('EUR');
  });
});
