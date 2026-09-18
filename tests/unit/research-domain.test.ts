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

  it('does not merge two domains because one ends with the other', () => {
    // A suffix match on the STRING would read notipoolside.com as
    // ipoolside.com and clear a hotel nobody looked at.
    expect(registrableDomain('notipoolside.com')).not.toBe(registrableDomain('ipoolside.com'));
  });
});
