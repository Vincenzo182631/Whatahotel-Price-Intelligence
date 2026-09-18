#!/usr/bin/env node
/**
 * Research hotels: find each property's own site, read it, store what it says.
 *
 *   BRAVE_API_KEY=... npm run research
 *   BRAVE_API_KEY=... npm run research -- --limit 50
 *   BRAVE_API_KEY=... npm run research -- --dry-run
 *
 * Owner requirement (2026-09-18), built the way the owner chose: Brave FINDS
 * the page, we FETCH it, and every stored claim cites the URL we read and the
 * time we read it. One search per hotel, not one per motivator — all ten are
 * assessed from the one document, which is better evidence and the difference
 * between 125 and 1,000 hotels inside Brave's free monthly credit.
 *
 * PACING. Brave's free tier is roughly one request a second and $5 of monthly
 * credit is about 1,000 requests, so the default limit is small and the run
 * sleeps between hotels. A sweep that ignores the rate limit looks exactly
 * like a broken key.
 *
 * WHAT IT NEVER WRITES. A hotel whose site cannot be resolved or read stores
 * no claims — never a claim of absence. An unreadable page is a cookie wall
 * or a timeout, not a property without a spa, and rendering the difference
 * would be rule 28's false negative.
 */
import {
  clearHotelResearch,
  closePool,
  findHotelWebsite,
  findOtherHotelsWithWebsite,
  findRejectedHosts,
  purgeSharedWebsites,
  findHotelsNeedingResearch,
  replaceResearchClaims,
  saveHotelResearchTarget,
} from '../packages/data/dist/index.js';
import { BraveClient, researchHotel } from '../packages/ingest/dist/index.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const limit = Number(value('--limit', '25'));
const staleDays = Number(value('--stale-days', '90'));
const pauseMs = Number(value('--pause-ms', '1200'));

const targets = await findHotelsNeedingResearch(limit, staleDays);

if (flag('--dry-run')) {
  console.log(`${targets.length} hotel(s) queued (limit ${limit}, stale after ${staleDays}d)`);
  for (const t of targets.slice(0, 25)) console.log(`  ${t.hotelId}  ${t.name} — ${t.city ?? '?'}`);
  if (targets.length > 25) console.log(`  … and ${targets.length - 25} more`);
  await closePool();
  process.exit(0);
}

const client = BraveClient.fromEnv();
if (!client) {
  console.error('BRAVE_API_KEY is not set. Research calls the real API or it does nothing.');
  await closePool();
  process.exit(1);
}

// Loaded once per run: a human's judgements outrank every automated check,
// and re-reading them per hotel would be a query for nothing.
const rejectedHosts = await findRejectedHosts();
if (rejectedHosts.size > 0) {
  console.log(`${rejectedHosts.size} host(s) previously rejected by review will be skipped.`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const counts = new Map();
let claimsWritten = 0;
const sites = [];

for (const target of targets) {
  const result = await researchHotel(target, {
    client,
    findHotelWebsite,
    saveHotelResearchTarget,
    replaceResearchClaims,
    findOtherHotelsWithWebsite,
    clearHotelResearch,
    rejectedHosts,
  });
  counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  claimsWritten += result.claims.length;
  if (result.outcome === 'STORED') {
    sites.push(`${target.hotelId} ${target.name}: ${result.claims.length} claim(s) from ${result.websiteUrl}`);
  }
  await sleep(pauseMs);
}

// Reconcile the FINISHED state, which the per-hotel check cannot.
//
// That check asks "does another hotel already hold this URL" and so depends
// on run order. Measured 2026-09-18: hotel 3 resolved ritzcarlton.com with
// nothing to collide against, hotel 7 collided and cleared both, hotel 22
// then resolved the same domain into the empty slot and stood. Two
// Ritz-Carltons survived on one brand domain, and which two was an accident
// of sequence. Asked of the finished state, the question has no such hole.
const purged = await purgeSharedWebsites();
for (const p of purged) {
  console.log(`  shared domain dropped: ${p.websiteUrl} was claimed by ${p.hotelIds.join(', ')}`);
}

const summary = [...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([o, n]) => `${o} ${n}`)
  .join(', ');
console.log(
  `research: ${claimsWritten} claim(s) across ${targets.length} hotel(s) — ${summary || 'nothing queued'}` +
    (purged.length > 0 ? `, ${purged.length} shared domain(s) purged after` : ''),
);
for (const line of sites.slice(0, 25)) console.log(`  ${line}`);
if (sites.length > 25) console.log(`  … and ${sites.length - 25} more`);

await closePool();
