/**
 * What counts as one site.
 *
 * Measured 2026-09-18 on the third real run: `com-miami.com` resolved for
 * three different hotels as `w.com-miami.com`, `east.com-miami.com` and
 * `ebhotelairport.com-miami.com`. The collision check compared full URLs, so
 * three distinct strings never collided and a directory serving three of our
 * hotels was invisible. All three stored zero claims, which is why no report
 * showed them and only the human review did.
 */
import { describe, expect, it } from 'vitest';
import { registrableDomain } from '../../packages/ingest/src/adapters/brave/resolve.js';

describe('registrableDomain', () => {
  it('collapses the subdomains one directory hands out per hotel', () => {
    const measured = ['w.com-miami.com', 'east.com-miami.com', 'ebhotelairport.com-miami.com'];
    expect(new Set(measured.map(registrableDomain))).toEqual(new Set(['com-miami.com']));
  });

  it('leaves a bare domain alone and ignores www and case', () => {
    expect(registrableDomain('halepuna.com')).toBe('halepuna.com');
    expect(registrableDomain('www.Halepuna.com')).toBe('halepuna.com');
  });

  it('keeps three labels where the public suffix is two', () => {
    // Otherwise every .co.uk hotel shares one "domain" and the whole of
    // Britain collides with itself.
    expect(registrableDomain('claridges.co.uk')).toBe('claridges.co.uk');
    expect(registrableDomain('book.claridges.co.uk')).toBe('claridges.co.uk');
    expect(registrableDomain('two.labels.com.au')).toBe('labels.com.au');
  });

  it('keeps two hotels under one country suffix apart', () => {
    // The dangerous direction. A missing suffix reduces every *.com.do host
    // to "com.do", so two unrelated Dominican hotels collide with each other
    // and BOTH have their research cleared for a domain they never shared.
    expect(registrableDomain('casadecampo.com.do')).toBe('casadecampo.com.do');
    expect(registrableDomain('casadecampo.com.do')).not.toBe(
      registrableDomain('otherresort.com.do'),
    );
  });

  it('does not merge two domains because one ends with the other', () => {
    // A suffix match on the STRING would read notipoolside.com as
    // ipoolside.com and clear a hotel nobody looked at.
    expect(registrableDomain('notipoolside.com')).not.toBe(registrableDomain('ipoolside.com'));
  });
});

/**
 * The review scorer's third-party-subdomain signal.
 *
 * It asks whether the host is somebody else's domain, and for that the
 * question is the REGISTRABLE domain, not the number of labels.
 */
import { reviewResolution } from '../../packages/ingest/src/adapters/brave/review.js';

const review = (name: string, url: string, city: string | null = null, claims = 3) =>
  reviewResolution({ name, city, websiteUrl: url, claims });

describe('reviewResolution · a public suffix is not somebody else s platform', () => {
  it('does not flag a hotel that owns its own two-part-suffix domain', () => {
    // Measured 2026-09-18 over 170 resolutions: all four of these were
    // flagged "third-party subdomain (co.uk)" by a labels.length > 2 test.
    for (const [name, url] of [
      ["Claridge's", 'https://claridges.co.uk/'],
      ['The Connaught', 'https://the-connaught.co.uk/'],
      ['Treetops Lodge & Estate', 'https://treetops.co.nz/'],
      ['Casa de Campo Resort & Villas', 'https://casadecampo.com.do/'],
    ] as const) {
      const r = review(name, url);
      expect(r.reasons.join(' ')).not.toContain('third-party subdomain');
    }
  });

  it('still flags a real subdomain, and names the domain rather than the suffix', () => {
    const r = review("Brown's Hotel London", 'https://browns.hotelslondon24.com/', 'London');
    expect(r.reasons.join(' ')).toContain('third-party subdomain (hotelslondon24.com)');
  });

  it('flags a two-part-suffix host that genuinely sits under someone else', () => {
    // The rule is about ownership, not about label counts in either
    // direction: four labels over a .co.uk is still a subdomain.
    const r = review('The Wellesley Knightsbridge', 'https://the-wellesley.hotels-of.co.uk/');
    expect(r.reasons.join(' ')).toContain('third-party subdomain (hotels-of.co.uk)');
  });
});
