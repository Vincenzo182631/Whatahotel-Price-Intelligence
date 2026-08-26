#!/usr/bin/env node
/**
 * Read each hotel's public whatahotel.com page and store what it states.
 *
 *   npm run pages                      # one sweep, default batch
 *   npm run pages -- --limit 500
 *   npm run pages -- --dry-run         # show the queue, fetch nothing
 *
 * Two facts, both absent from /data/api.cfm:
 *
 *   street_address    Google Places matching is decided by geography, so a
 *                     hotel with no coordinates can never clear the match
 *                     threshold and never earns a rating. The merchant's own
 *                     address answers the same question and comes from
 *                     outside Google, so it corroborates rather than
 *                     self-confirms.
 *
 *   bookable_online   The page says outright when a property cannot be booked
 *                     online. The rates API answers an ambiguous 500 for the
 *                     same stay, indistinguishable from an upstream fault.
 *
 * No API key: this is the public page, not the rates API. It is also our own
 * client's site, so the sweep stays deliberately gentle — small concurrency,
 * a long refresh interval, and no retry storm. Hotel page content changes
 * about twice a year; there is nothing to gain by asking more often.
 */

import {
  closePool,
  findHotelsNeedingPageFacts,
  saveHotelPageFacts,
} from '../packages/data/dist/index.js';
import { fetchHotelPage } from '../packages/ingest/dist/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const limit = Number(value('--limit', '200'));
const refreshHours = Number(value('--refresh-hours', '4320')); // ~180 days
const concurrency = Math.max(1, Math.min(4, Number(value('--concurrency', '3'))));

const targets = await findHotelsNeedingPageFacts(limit, refreshHours);

if (flag('--dry-run')) {
  console.log(`${targets.length} hotel page(s) queued (limit ${limit}, refresh ${refreshHours}h)`);
  for (const t of targets.slice(0, 25)) console.log(`  ${t.wahHotelId}  (hotel ${t.hotelId})`);
  if (targets.length > 25) console.log(`  … and ${targets.length - 25} more`);
  await closePool();
  process.exit(0);
}

let parsed = 0;
let addressed = 0;
let unbookable = 0;
let failed = 0;

const queue = [...targets];
async function worker() {
  for (;;) {
    const target = queue.shift();
    if (!target) return;
    const page = await fetchHotelPage(target.wahHotelId);
    if (!page) {
      // Unreadable, or not a hotel. Write nothing so it stays queued rather
      // than recording an absence we did not measure.
      failed += 1;
      continue;
    }
    await saveHotelPageFacts(target.hotelId, {
      streetAddress: page.streetAddress,
      postalCode: page.postalCode,
      bookableOnline: page.bookableOnline,
    });
    parsed += 1;
    if (page.streetAddress) addressed += 1;
    if (page.bookableOnline === false) unbookable += 1;
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

console.log(
  `pages: ${parsed} parsed, ${addressed} with an address, ` +
    `${unbookable} not bookable online, ${failed} unreadable`,
);

await closePool();
