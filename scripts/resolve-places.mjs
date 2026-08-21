#!/usr/bin/env node
/**
 * Resolve hotels to Google places and refresh their guest ratings.
 *
 *   npm run places                        # one sweep, default batch
 *   npm run places -- --limit 500
 *   npm run places -- --dry-run           # show the queue, call nothing
 *
 * Needs GOOGLE_PLACES_API_KEY. Without it the sweep reports NOT_CONFIGURED and
 * exits 0 — reputation is an enhancement, and a missing enhancement is not a
 * failed run.
 *
 * What the sweep is for, and what it is NOT for: the rating it stores is
 * evidence for the reasoning layer and a fact shown beside the price. It is
 * not a term in any score. Nothing in packages/core/src/scoring reads it, and
 * a change that made it do so would be a change to what the product claims.
 */

import { findResolutionTargets, closePool } from '../packages/data/dist/index.js';
import { googleConfigured, googleSettings, sweepPlaces } from '../packages/ingest/dist/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const limit = Number(value('--limit', '200'));
const settings = googleSettings();

if (!googleConfigured()) {
  console.log('GOOGLE_PLACES_API_KEY is not set — nothing to do.');
  await closePool();
  process.exit(0);
}

if (flag('--dry-run')) {
  const targets = await findResolutionTargets(limit, settings.refreshHours);
  console.log(`${targets.length} hotel(s) queued (limit ${limit}, refresh ${settings.refreshHours}h):`);
  for (const t of targets.slice(0, 25)) {
    console.log(`  ${t.hotelId}  ${t.name}${t.city ? ` — ${t.city}` : ''}${t.placeId ? '  [refresh]' : ''}`);
  }
  if (targets.length > 25) console.log(`  … and ${targets.length - 25} more`);
  await closePool();
  process.exit(0);
}

const started = Date.now();
const result = await sweepPlaces({
  limit,
  onHotel: ({ hotel, status, confidence, reasons }) => {
    const conf = confidence === null ? '' : ` ${confidence}`;
    console.log(`  ${status.padEnd(10)}${conf.padEnd(6)} ${hotel.name} — ${reasons.join('; ')}`);
  },
});

console.log(
  `\n${result.considered} considered in ${Math.round((Date.now() - started) / 1000)}s: ` +
    `${result.verified} verified, ${result.unverified} unverified, ` +
    `${result.noMatch} no match, ${result.failed} failed.`,
);
if (result.failed > 0) {
  // Not an error exit: failures write nothing and are retried next sweep.
  console.log('Failed lookups were not recorded and stay in the queue.');
}

await closePool();
