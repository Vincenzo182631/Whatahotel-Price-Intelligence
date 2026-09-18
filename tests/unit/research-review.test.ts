/**
 * Ranking a resolution for human attention.
 *
 * A prompt, never an automatic rejection. It should sooner flag a correct
 * resolution than reject one silently: a wrong rejection is invisible, and a
 * flagged-but-fine resolution costs somebody five seconds.
 */
import { describe, expect, it } from 'vitest';
import { reviewResolution } from '../../packages/ingest/src/adapters/brave/review.js';

const at = (name: string, websiteUrl: string, city = 'Miami', claims = 3) =>
  reviewResolution({ name, city, websiteUrl, claims });

describe('reviewResolution', () => {
  it('is quiet when the name plainly explains the host', () => {
    expect(at('Halekulani', 'https://halekulani.com/', 'Honolulu').score).toBe(0);
    expect(at('The Kahala Resort', 'https://kahalaresort.com/', 'Honolulu').score).toBe(0);
  });

  it('flags a host explained only by the location', () => {
    // The measured case: "Mr. C Miami - Coconut Grove" resolved to
    // coconutgrove.com, because the hotel's name contains its neighbourhood.
    // Nothing collided and no pattern fired, which is why a human looks.
    const r = reviewResolution({
      name: 'Mr. C Miami - Coconut Grove',
      city: 'Coconut Grove',
      websiteUrl: 'https://coconutgrove.com/',
      claims: 1,
    });
    expect(r.score).toBeGreaterThan(30);
    expect(r.reasons.join(' ')).toContain('only the location');
  });

  it('flags a host the name does not appear in at all', () => {
    const r = at('EB Hotel Miami', 'https://someplaceelse.example/');
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.reasons.join(' ')).toContain('no word of the name');
  });

  it('notices a third-party subdomain', () => {
    // moanasurfrider.ipoolside.com is a booking platform, not the hotel's own
    // site. Real, and worth a look rather than a rejection.
    const r = at('Moana Surfrider', 'https://moanasurfrider.ipoolside.com/', 'Honolulu');
    expect(r.reasons.join(' ')).toContain('third-party subdomain');
  });

  it('notices a claim count that looks like a city guide', () => {
    // EB Hotel Miami stored 11 claims from the Greater Miami tourism board
    // before the destination patterns caught it.
    const r = at('EB Hotel Miami', 'https://ebhotelmiami.example/', 'Miami', 11);
    expect(r.reasons.join(' ')).toContain('directory or city page');
  });

  it('does not punish a hotel for its category words', () => {
    // "Resort", "Hotel" and "Suites" identify a category, not a property, so
    // their absence from a host means nothing.
    expect(
      at('The Ritz-Carlton, Key Biscayne', 'https://keybiscayne.example/', 'Miami').score,
    ).toBe(0);
  });

  it('does not punish a sub-brand for naming its parent', () => {
    // Halepuna is Halekulani's sister property, so the name's longest word is
    // the PARENT brand and halepuna.com rightly does not contain it. An
    // earlier version of this scorer flagged it, which would have surfaced
    // exactly the hotels whose domains are most clearly their own.
    expect(at('Halepuna Waikiki by Halekulani', 'https://halepuna.com/', 'Honolulu').score).toBe(0);
  });

  it('never throws on a malformed url', () => {
    expect(at('Anything', 'not-a-url').score).toBe(100);
  });
});
