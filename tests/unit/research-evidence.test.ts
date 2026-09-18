/**
 * Reading motivator evidence from a page, and refusing to read what is not
 * there.
 *
 * Every claim must trace to a phrase a reader could find on the page. That is
 * what separates this from the failure rule 30 caught, where a documented
 * field looked like evidence and was a constant across every hotel sampled.
 */
import { describe, expect, it } from 'vitest';
import { extractClaims, visibleText } from '../../packages/ingest/src/adapters/brave/evidence.js';

describe('extractClaims', () => {
  it('claims only what the page actually says', () => {
    const claims = extractClaims(
      '<html><body><h1>A Resort</h1><p>Our private beach and beach club.</p></body></html>',
    );
    const beach = claims.filter((c) => c.motivator === 'BEACH_RESORT');
    expect(beach.length).toBeGreaterThan(0);
    // Both phrases are on the page; the ORDER is the phrase list's, not the
    // page's, so the assertion is about presence rather than position.
    expect(beach.map((c) => c.claim).join(' ')).toContain('private beach');
    // Nothing on this page speaks to business travel, so nothing is claimed.
    expect(claims.some((c) => c.motivator === 'BUSINESS_TRAVEL')).toBe(false);
  });

  it('never produces a claim of absence', () => {
    // A page that does not mention a spa is not a hotel without one. Pages
    // omit things, fetches hit cookie walls, and rule 28's line is that our
    // research gap is never rendered as the property's shortcoming.
    const claims = extractClaims('<html><body><p>Welcome.</p></body></html>');
    expect(claims).toEqual([]);
  });

  it('ignores text a reader could not see', () => {
    // A phrase inside a tracking script or a JSON blob is not the page
    // saying it, and a guest opening the link would not find it.
    const hidden = extractClaims(
      '<html><head><script>var x = "beachfront kids club";</script>' +
        '<style>.beachfront { color: red }</style></head><body><p>Hello.</p></body></html>',
    );
    expect(hidden).toEqual([]);
  });

  it('does not count an attribute as a statement', () => {
    const attr = extractClaims('<html><body><img alt="beachfront" src="a.jpg"></body></html>');
    expect(attr).toEqual([]);
  });

  it('caps repeats, because one page saying beachfront five ways is one fact', () => {
    const html =
      '<html><body>beachfront private beach beach club oceanfront water sports</body></html>';
    const beach = extractClaims(html).filter((c) => c.motivator === 'BEACH_RESORT');
    expect(beach).toHaveLength(2);
  });

  it('is not fooled by topic words that appear on every hotel page', () => {
    // "business hours" would fire Business Travel on the whole catalogue —
    // rule 9's failure, and the same shape as goodForChildren being true for
    // all 20 hotels Places was asked about.
    const claims = extractClaims('<html><body><p>Business hours: 9 to 5.</p></body></html>');
    expect(claims.some((c) => c.motivator === 'BUSINESS_TRAVEL')).toBe(false);

    const real = extractClaims(
      '<html><body><p>Our business center is open daily.</p></body></html>',
    );
    expect(real.some((c) => c.motivator === 'BUSINESS_TRAVEL')).toBe(true);
  });

  it('quotes the phrase, so the claim can be checked against the page', () => {
    const claims = extractClaims('<html><body><p>A full-service spa.</p></body></html>');
    const quiet = claims.find((c) => c.motivator === 'QUIET_RELAXATION');
    expect(quiet?.claim).toBe('The property\'s own site mentions "spa"');
  });
});

describe('visibleText', () => {
  it('drops markup and normalises entities', () => {
    expect(visibleText('<p>Beach&nbsp;&amp;&nbsp;Spa</p>')).toBe('beach & spa');
  });
});
