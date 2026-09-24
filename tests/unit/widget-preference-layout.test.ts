/**
 * Where the preference answer lands, and how wide a chip is.
 *
 * Both of these were measured in a real browser against production on
 * 2026-09-18, and neither could have been caught by reading the API: the
 * response was correct in both cases and the page was wrong.
 *
 * They are the same class of failure. The widget is embedded in somebody
 * else's page and collapsed into somebody else's layout, so a block that is
 * technically rendered is not the same thing as a block a guest can read.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const WIDGET = readFileSync(new URL('../../apps/web/public/widget.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../../apps/web/public/widget.css', import.meta.url), 'utf8');

/** One function's body, comments and all, by name. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf('function ' + name + '(');
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

describe('the preference answer renders where the guest is looking', () => {
  const renderLive = functionBody(WIDGET, 'renderLive');

  it('is not appended into the collapsed SEE MORE block', () => {
    // It used to be. Pressing a chip then lit the chip and put its answer
    // behind a collapsed disclosure, so the one interaction whose entire
    // purpose is to change what is on screen changed nothing the guest
    // could see.
    expect(renderLive).not.toMatch(/append\(\s*more,\s*renderLivePersonalization/);
  });

  it('is appended to the open panel, above the disclosure', () => {
    const answer = renderLive.indexOf('append(root, renderLivePersonalization(data))');
    const more = renderLive.indexOf("var more = el('div', 'wahpi__more')");
    expect(answer).toBeGreaterThan(-1);
    expect(more).toBeGreaterThan(-1);
    expect(answer).toBeLessThan(more);
  });

  it('lands in the same place in the mode that holds no rate', () => {
    // One layout whichever mode answered. HOTEL_ONLY has no disclosure at
    // all, so the only way the two can drift is the scored path moving.
    const hotelOnly = functionBody(WIDGET, 'renderHotelOnly');
    expect(hotelOnly).toMatch(/append\(root, renderLivePersonalization\(data\)\)/);
  });
});

describe('a host page does not get to lay out our chips', () => {
  /** The declarations inside one rule, by selector. */
  function rule(selector: string): string {
    const at = CSS.indexOf(selector + ' {');
    expect(at).toBeGreaterThan(-1);
    return CSS.slice(at, CSS.indexOf('}', at));
  }

  it('states the preference chip width rather than inheriting it', () => {
    // Measured on the demo harness, whose own unscoped `button` rule sets
    // width: 100%. The ten chips became ten full-width stacked rows and
    // pushed the price below the fold. A widget button that declares no
    // width of its own has no say in the matter.
    expect(rule('.wahpi__pref-chip')).toMatch(/width:\s*auto/);
  });

  it('does the same for every other button meant to sit inline', () => {
    for (const selector of [
      '.wahpi__chart-btn',
      '.wahpi__table-toggle',
      '.wahpi__alternative-view',
    ])
      expect(rule(selector)).toMatch(/width:\s*auto/);
  });

  it('leaves the full-width ones full width', () => {
    // The defence is about buttons that sit in a row. A block button that
    // is meant to span the panel still says so.
    for (const selector of ['.wahpi__see-more', '.wahpi__disclosure'])
      expect(rule(selector)).toMatch(/width:\s*100%/);
  });
});

/**
 * The measured comparison, on the face of the card.
 *
 * Greg, 2026-09-21: "We're NOT giving any IMPORTANT information to someone
 * who uses the WhataRate! tab." Verified against production the same day on
 * The Royal Hawaiian, 15-18 Oct, $447/night. The open card showed a 6/10,
 * "Market rate / Consider booking", and a paragraph of Google rating, review
 * themes and perks — every one of which the guest already has on the hotel
 * page this widget is embedded in. The one thing only we produce, "26% above
 * comparable rooms nearby", was inside the collapsed SEE MORE block.
 *
 * It is the same failure as the personalization placement above, one block
 * further down the same function, and it was there the whole time that one
 * was being fixed.
 */
describe('the comparison a guest cannot get anywhere else', () => {
  const renderLive = functionBody(WIDGET, 'renderLive');

  it('is not appended into the collapsed SEE MORE block', () => {
    expect(renderLive).not.toMatch(/append\(\s*more,\s*renderLiveReasons/);
  });

  it('sits directly under the score it explains', () => {
    // Adjacency is the point: the reasons justify the verdict, so anything
    // between them is something the guest reads first instead.
    const verdict = renderLive.indexOf('append(root, renderLiveVerdict(data))');
    const reasons = renderLive.indexOf('append(root, renderLiveReasons(data))');
    const whyChoose = renderLive.indexOf('append(root, renderLiveWhyChoose(data))');
    expect(verdict).toBeGreaterThan(-1);
    expect(reasons).toBeGreaterThan(verdict);
    expect(reasons).toBeLessThan(whyChoose);
  });

  it('is above the disclosure, not inside it', () => {
    const reasons = renderLive.indexOf('append(root, renderLiveReasons(data))');
    const more = renderLive.indexOf("var more = el('div', 'wahpi__more')");
    expect(reasons).toBeLessThan(more);
  });

  it('still renders nothing when the verdict carries no reasons', () => {
    // Every HOTEL_VALUE response. Moving the block must not put an empty
    // container on an unscored card.
    const body = functionBody(WIDGET, 'renderLiveReasons');
    expect(body).toMatch(/reasons\.length === 0\) return null/);
  });
});
