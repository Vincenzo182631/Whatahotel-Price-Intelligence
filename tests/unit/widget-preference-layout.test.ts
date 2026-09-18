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
