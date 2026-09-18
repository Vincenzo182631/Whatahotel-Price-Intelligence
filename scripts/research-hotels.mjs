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
  closePool,
  findHotelWebsite,
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
  });
  counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
  claimsWritten += result.claims.length;
  if (result.outcome === 'STORED') {
    sites.push(`${target.hotelId} ${target.name}: ${result.claims.length} claim(s) from ${result.websiteUrl}`);
  }
  await sleep(pauseMs);
}

const summary = [...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([o, n]) => `${o} ${n}`)
  .join(', ');
console.log(
  `research: ${claimsWritten} claim(s) across ${targets.length} hotel(s) — ${summary || 'nothing queued'}`,
);
for (const line of sites.slice(0, 25)) console.log(`  ${line}`);
if (sites.length > 25) console.log(`  … and ${sites.length - 25} more`);

await closePool();
