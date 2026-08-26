/**
 * V4 — the gate that keeps a verdict about the PRICE from becoming a verdict
 * about the HOTEL.
 *
 * The distinction is the whole point, so the tests are paired: each rejected
 * phrase sits beside the measurement it was trying to express, and that
 * measurement must still pass. A gate that also silenced the finding would be
 * dishonesty of the opposite kind.
 */

import { describe, expect, it } from 'vitest';

import { validateNarrative } from '../../packages/core/src/explanation/validate.js';

const constraints = { allowed_numbers: [12, 38, 450], max_sentences: 4 };
const check = (text: string) => validateNarrative(text, constraints);

describe('a premium may be stated, never adjudicated', () => {
  it('passes the measurement', () => {
    for (const text of [
      'This room is priced above every comparable hotel checked.',
      'You are paying about 12% more per night than the comparable median.',
      'Premium-priced relative to nearby alternatives.',
      'Priced above the local competitive set.',
      'A higher-priced option with stronger property positioning.',
    ]) {
      expect(check(text).ok, text).toBe(true);
    }
  });

  it('rejects the verdict', () => {
    for (const text of [
      'This hotel is overpriced for what it offers.',
      'Honestly it is not worth it at this rate.',
      'A bad deal compared with the alternatives.',
      'This room is too expensive.',
      'Poor value for the money.',
    ]) {
      const r = check(text);
      expect(r.ok, text).toBe(false);
      expect(r.violations.join(' ')).toMatch(/verdict about the hotel/);
    }
  });

  it('does not soften the finding it is protecting', () => {
    // The gate must not become a reason to stop reporting premiums. The
    // strongest true statement the engine can make still ships intact.
    const strongest =
      'This room is priced 38% above the comparable median, and above every comparable hotel checked.';
    expect(check(strongest).ok).toBe(true);
  });

  it('leaves the other gates doing their own jobs', () => {
    // V1 numbers, V2 prediction, V3 data apology — each still fires on its
    // own terms, and V4 has not swallowed any of them.
    expect(check('Rates will rise next week.').ok).toBe(false);
    expect(check('The price is 999 per night.').ok).toBe(false);
    expect(check('We do not have enough data to compare.').ok).toBe(false);
  });
});
