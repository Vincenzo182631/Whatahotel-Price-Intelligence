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
