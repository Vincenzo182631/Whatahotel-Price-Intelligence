/**
 * HOTEL_ONLY: the answer when the source will not price a stay for us.
 *
 * The mode exists because the honest alternatives were both bad. Rendering
 * nothing wasted evidence we already hold and had already validated; the old
 * 409 copy went further and told the guest the hotel was "not bookable online
 * for these dates", which during the source outage was usually FALSE — a
 * negative claim about a property, produced by our own upstream fault
 * (rules 24 and 26).
 *
 * What these tests pin is the boundary: the mode may say what we measured
 * about the hotel, and it may not say anything about a price we never got.
 */

import { describe, expect, it } from 'vitest';

import {
  deterministicHotelValue,
  hotelOnlyFacts,
  hotelValueConfidence,
  supportingSignals,
} from '../../packages/core/src/explanation/hotelValue.js';
import { buildSupportingSignals } from '../../packages/core/src/explanation/liveBundle.js';

import { readFileSync } from 'node:fs';

const WIDGET = readFileSync(new URL('../../apps/web/public/widget.js', import.meta.url), 'utf8');

/**
 * The widget with its comments removed.
 *
 * Retired copy is quoted in the comments on purpose — why a sentence was
 * withdrawn is the part that stops it coming back. The assertions below are
 * about what a CUSTOMER can read, so they run against the code alone.
 */
const WIDGET_CODE = WIDGET.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const REPUTATION = {
  source: 'GOOGLE',
  rating: 4.6,
  review_count: 1820,
  display_name: 'Hotel Under Test',
} as const;

const facts = (over: Partial<Parameters<typeof hotelOnlyFacts>[0]> = {}) =>
  hotelOnlyFacts({
    preference: 'GENERAL_VALUE',
    city: 'Miami',
    reputation: REPUTATION,
    perks: ['Breakfast for two', 'Hotel credit'],
    reviewThemes: ['service', 'pool'],
    ...over,
  });

/**
 * Anything that would be a claim about money.
 *
 * "Guests RATE this property 4.6" is the verb and is fine, so the noun is
 * matched only behind a determiner — the thing we must never describe is
 * "the rate", not the act of rating.
 */
const PRICE_WORDS =
  /(\$|\b(?:price[ds]?|cost[s]?|cheaper|expensive|premium|deal|discount|saving|per night|nightly)\b|\b(?:the|this|that|a|its|our)\s+rates?\b)/i;

describe('the hotel-only fact set', () => {
  it('carries no price, rate or comparison fields at all', () => {
    // Structural, not editorial: a renderer cannot leak a price it was never
    // handed, and no future edit can reach one through this object.
    const json = JSON.stringify(facts());
    expect(json).not.toMatch(/amount|minor|currency|csi|comp_set|score|index/i);
  });

  it('says nothing about a room or availability, because no rate was priced', () => {
    const f = facts();
    expect(f.subject.room_view).toBeNull();
    expect(f.subject.room_class).toBeNull();
    expect(f.availability.selected_position).toBeNull();
    expect(f.availability.available_categories).toBe(0);

    // The room and availability sentences of the shared reader must not fire
    // on zeroes — rule 9: an unmeasured thing is excluded, not scored.
    const value = deterministicHotelValue(f);
    expect(value?.summary).not.toMatch(/room categor|availability|higher room/i);
  });

  it('writes no sentence that mentions price in any form', () => {
    const value = deterministicHotelValue(facts());
    expect(value).not.toBeNull();
    expect(value?.summary, value?.summary).not.toMatch(PRICE_WORDS);
    expect(value?.headline, value?.headline).not.toMatch(PRICE_WORDS);
  });

  it('never narrates our own data gaps', () => {
    // Validator V3's rule, stated here as a property of what we generate:
    // the guest reads about the hotel, not about our outage.
    const value = deterministicHotelValue(facts());
    expect(value?.summary).not.toMatch(
      /not enough|insufficient|could not|unable|unavailable|unfortunately|no data|sorry/i,
    );
  });

  it('builds the same chips as a scored answer would, from the same facts', () => {
    // One vocabulary across the modes. Two spellings of a measured fact would
    // reject a model citing the other, and would read as two different
    // products to a guest who moved a date.
    expect(supportingSignals(facts())).toEqual(
      buildSupportingSignals({
        reputation: REPUTATION,
        perks: ['Breakfast for two', 'Hotel credit'],
        reviewThemes: ['service', 'pool'],
      }),
    );
  });

  it('renders nothing rather than an empty card when nothing was measured', () => {
    // Rule 3's principle: absent evidence is absent, never a hollow shell.
    const nothing = hotelOnlyFacts({ preference: 'GENERAL_VALUE', city: 'Miami' });
    expect(deterministicHotelValue(nothing)).toBeNull();
  });

  it('grades confidence from evidence, not from the mode', () => {
    expect(hotelValueConfidence(facts())).toBe('HIGH');
    expect(
      hotelValueConfidence(hotelOnlyFacts({ preference: 'GENERAL_VALUE', reputation: REPUTATION })),
    ).toBe('MEDIUM');
  });

  it('states the rating the reputation carries and nothing stronger', () => {
    const value = deterministicHotelValue(facts());
    expect(value?.summary).toContain('4.6');
    expect(value?.summary).toMatch(/recent reviewers mention/i);
  });
});

describe('what the widget says when no rate came back', () => {
  it('never claims a hotel is unbookable on the strength of a failed fetch', () => {
    // The old 409 title. A rates fault and a genuinely unbookable property
    // are indistinguishable from the error path, so asserting the second
    // from the first put a false negative claim on the hotel's own page.
    expect(WIDGET_CODE).not.toContain('Not bookable online for these dates');
  });

  it('keeps the advisor route, phrased about the stay rather than the hotel', () => {
    expect(WIDGET_CODE).toContain('Check these dates with an advisor');
    expect(WIDGET_CODE).toMatch(/advisors can check availability directly/);
  });

  it('states unbookability only where the hotel page itself said so', () => {
    // rule 24: NULL means the page did not say. The only place the widget
    // may say it is behind an explicit false from the API.
    expect(WIDGET_CODE).toMatch(/bookable_online === false/);
    expect(WIDGET_CODE).toContain('This property is not bookable online.');
  });

  it('does not call the card a rate comparison when it holds no rate', () => {
    // The header is a claim too. "Live Rate Comparison" over a card with no
    // rate is the same failure as the old unbookable notice, in smaller type.
    expect(WIDGET_CODE).toMatch(/renderBrand\('Hotel Insight'\)/);
    expect(WIDGET_CODE).toMatch(/function renderBrand\(subtitle\)/);
  });

  it('does not point a hotel-only card at a score it never shows', () => {
    expect(WIDGET_CODE).toContain('context, not our assessment');
  });

  it('routes a hotel-only body away from the market renderer', () => {
    // Every block in renderLive describes a rate; this body has none.
    expect(WIDGET_CODE).toMatch(/intelligence_mode === 'HOTEL_ONLY'/);
    expect(WIDGET_CODE).toMatch(/renderHotelOnly\(root, result\.body\)/);
  });
});
