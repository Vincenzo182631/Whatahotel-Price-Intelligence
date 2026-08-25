/**
 * Which elements the widget will mount into.
 *
 * This is a text assertion over widget.js rather than a DOM test, deliberately:
 * the widget is a framework-free IIFE that talks to the network on load, so
 * standing one up costs a jsdom, a fake fetch and a timer, and would test the
 * scoring path all over again. The thing that broke was one CSS selector
 * string, and that is what this pins.
 *
 * The staging embed came back as
 *
 *   <div id="widget" class="wahpi-wrapper wahpi" data-hotel-id="2008" …>
 *
 * — every stay attribute right, and the attribute we select on missing, so the
 * widget mounted nothing and read as dead. The selector now accepts the
 * conventions an integrator naturally reaches for.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WIDGET = readFileSync(new URL('../../apps/web/public/widget.js', import.meta.url), 'utf8');

/** The selector literal, read out of the source. */
function mountSelector(): string {
  const match = WIDGET.match(/var MOUNT_SELECTOR = '([^']+)'/);
  if (!match) throw new Error('MOUNT_SELECTOR is not declared in widget.js');
  return match[1] as string;
}

describe('room-category picker', () => {
  it('renders only when the stay has more than one bookable room', () => {
    // A one-option <select> is a control that cannot be used, and it implies a
    // choice the guest does not have.
    expect(WIDGET).toMatch(/options\.length < 2[^\n]*return null/);
  });

  it('re-requests instead of relabelling what is on screen', () => {
    // The comp set, the nearby-date series and the terms match all key off the
    // chosen room, so a category change is a different question. Patching the
    // room name in place would leave the old score beside the new room.
    expect(WIDGET).toMatch(/next\.roomTypeId = roomTypeId/);
    expect(WIDGET).toMatch(/mount\(root, next\)/);
  });

  it('drops a pinned room when the stay itself changes', () => {
    // A room_type_id is only meaningful for the dates it was priced for.
    expect(WIDGET).toMatch(/pinned\.stay === staySignature\(config\)/);
  });

  it('falls back to the engine pick when a pinned room disappears', () => {
    // Sold out, or the guest moved the dates. Showing "not found" for a hotel
    // that still has rates would be wrong twice over.
    expect(WIDGET).toMatch(/ROOM_TYPE_NOT_FOUND' && options\.roomTypeId/);
    expect(WIDGET).toMatch(/delete withoutRoom\.roomTypeId/);
  });
});

describe('WhataRate! Check branding (Phase 7)', () => {
  it('carries the official name and subtitle, exact words', () => {
    expect(WIDGET).toContain("'WhataRate!'");
    expect(WIDGET).toContain("' Check'");
    expect(WIDGET).toContain("'Live Rate Comparison'");
  });
});

describe('rate-plan picker (Phase 7)', () => {
  it('renders only when the room genuinely has more than one bookable offer', () => {
    expect(WIDGET).toMatch(/rate_options \|\| \[\];\s*\n\s*if \(options\.length < 2/);
  });

  it('re-requests with rate_id instead of repricing what is on screen', () => {
    expect(WIDGET).toMatch(/params\.set\('rate_id', String\(options\.rateId\)\)/);
    expect(WIDGET).toMatch(/next\.rateId = rateId/);
  });

  it('drops the rate pin when the room changes — a plan belongs to its room', () => {
    expect(WIDGET).toMatch(/delete next\.rateId/);
  });

  it('falls back to the cheapest plan when a pinned rate disappears', () => {
    expect(WIDGET).toMatch(/RATE_NOT_FOUND' && options\.rateId/);
    expect(WIDGET).toMatch(/delete withoutRate\.rateId/);
  });
});

describe('booking hand-off (Phase 7)', () => {
  it('uses the API booking URL and never fabricates one', () => {
    expect(WIDGET).toMatch(/options\.bookingUrl \|\| \(data\.booking && data\.booking\.url\)/);
    expect(WIDGET).toContain('Booking information is temporarily unavailable.');
  });

  it('never carries the source session tokens', () => {
    // cfid/cftoken are per-session credentials on the source's own links.
    expect(WIDGET).not.toMatch(/cfid|cftoken/);
  });
});

describe('Get Help (Phase 7)', () => {
  it('the advisor button is gone', () => {
    expect(WIDGET).not.toContain('Lorraine Travel advisor');
    expect(WIDGET).not.toContain('advisorUrl');
  });

  it('reuses the existing WhataHotel chatbot, one instance only', () => {
    expect(WIDGET).toContain("'https://vibss.io/plugin.js?v=2026-01-26'");
    // An already-rendered container short-circuits before any setup call.
    expect(WIDGET).toMatch(/if \(vibssContainer\(chatId\)\) return done\(true\)/);
  });

  it('reuses the page bot WHATEVER id the host installed it under', () => {
    // Verified live: whatahotel.com runs Vibss under its own bot id, not the
    // one this widget is configured with. Keying detection on our id would
    // stand up a second bot beside the real one.
    expect(WIDGET).toContain('[id^="vibss-webchat-"]');
  });

  it('prefill targets only a message composer, never a contact field', () => {
    // Verified live: the real bot opens with a Name/Email/Phone pre-chat
    // form, and "first text input" was the NAME field.
    expect(WIDGET).toMatch(/name\|email\|phone\|subject\|company/);
    expect(WIDGET).toMatch(/message\|chat\|type\|write\|ask/);
  });

  it('prefill is best-effort and never sends on the guest behalf', () => {
    // The guest sees the text in the box and chooses to send it.
    expect(WIDGET).toMatch(/dispatchEvent\(new Event\('input'/);
    expect(WIDGET).not.toMatch(/sendMessage|submit\(\)/);
    // And a box the guest already typed into is never overwritten.
    expect(WIDGET).toMatch(/never overwrite the guest/);
  });
});

describe('Google rating stars', () => {
  it('star fill tracks the actual rating — never a flat five', () => {
    // Five cells, each filled by clamp(rating - i, 0, 1): 4.3 paints four
    // full stars and 30% of the fifth. A fixed row of five ★ glyphs would
    // overstate every rating below 4.75.
    expect(WIDGET).toMatch(/Math\.max\(0, Math\.min\(1, rating - i\)\)/);
    expect(WIDGET).toMatch(/overlay\.style\.width = fill \* 100 \+ '%'/);
  });

  it('is compact, secondary, and never implies the rating is scored', () => {
    expect(WIDGET).toContain("'Google rating'");
    expect(WIDGET).toContain('Context only — not part of the score.');
    // Decoration is aria-hidden; the container carries the accessible label.
    expect(WIDGET).toMatch(/aria-label', 'Rated ' \+ rating\.toFixed\(1\) \+ ' out of 5'/);
  });
});

describe('widget mount selector', () => {
  it('accepts the documented marker attribute', () => {
    expect(mountSelector().split(',')).toContain('[data-wah-pi]');
  });

  it('accepts the class and id an integrator reaches for instead', () => {
    // Measured on the real staging embed: class="wahpi-wrapper wahpi".
    const parts = mountSelector().split(',');
    expect(parts).toContain('.wahpi');
    expect(parts).toContain('#wahpi');
    expect(parts).toContain('#wah-pi');
  });

  it('never mounts on data-hotel-id alone', () => {
    // A search-results page can carry that on every card. Mounting per card
    // would render a panel per row and hammer the API from one page view.
    expect(mountSelector()).not.toContain('[data-hotel-id]');
  });

  it('is the only selector the mount and observer paths use', () => {
    // The element is found in three places — initial mount, the remount pass
    // and the MutationObserver. A hardcoded selector left in any one of them
    // is a host page whose late-inserted panel never mounts.
    expect(WIDGET).not.toMatch(/querySelectorAll\('\[data-wah-pi\]'\)/);
    expect(WIDGET).not.toMatch(/matches\('\[data-wah-pi\]'\)/);
  });
});

describe('Superior Alternative (upsell) and the concise UI', () => {
  it('the section is the upsell, and the downsell card is gone', () => {
    expect(WIDGET).toContain("'SUPERIOR ALTERNATIVE'");
    expect(WIDGET).toContain("'CONSIDER THE UPGRADE'");
    expect(WIDGET).not.toContain('BETTER VALUE ALTERNATIVE');
  });

  it('the recommended hotel links out safely', () => {
    expect(WIDGET).toMatch(/link\.rel = 'noopener'/);
  });

  it('a room_code pin removes the in-panel choosers — the page is the chooser', () => {
    expect(WIDGET).toMatch(/if \(state\.options\.roomCode\) return null/);
    expect(WIDGET).toMatch(/params\.set\('room_code', String\(options\.roomCode\)\)/);
  });

  it('first paint is partial, with SEE MORE expanding in place', () => {
    expect(WIDGET).toContain("'SEE MORE ▼'");
    expect(WIDGET).toContain("'SEE LESS ▲'");
    expect(WIDGET).toMatch(/more\.hidden = !state\.seeMore/);
  });

  it('the room shows once, as category + bedding', () => {
    expect(WIDGET).toMatch(/function conciseRoomName/);
    expect(WIDGET).not.toContain('Showing the lowest available rate');
  });

  it('the timestamp wording is honest and dynamic', () => {
    expect(WIDGET).toContain("'This rate was last checked ' + relativeTime(");
    expect(WIDGET).not.toContain('live right now');
  });
});

describe('prefetch — warming a stay before the panel opens', () => {
  it('exposes prefetch() on the public API', () => {
    expect(WIDGET).toMatch(/prefetch: prefetch,/);
  });

  it('scans for [data-wah-pi-prefetch] markers at boot, before mounting', () => {
    expect(WIDGET).toContain("querySelectorAll('[data-wah-pi-prefetch]')");
    // Boot order: warming starts before the mount loop so a page that has
    // both gets the head start either way.
    const boot = WIDGET.indexOf('prefetchMarked();');
    // lastIndexOf: the same call literal appears earlier inside remountAll;
    // the mount loop that matters here is initAuto's, which is the final one.
    const mountLoop = WIDGET.lastIndexOf('autoMount(nodes[i]);');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(mountLoop);
  });

  it('warms each distinct stay once per page view and swallows failures', () => {
    expect(WIDGET).toMatch(/if \(prefetched\[url\]\) return;/);
    // Fire-and-forget: a rejected warm-up must never surface to the host page.
    expect(WIDGET).toMatch(/fetch\(url\)\.catch\(/);
  });
});
