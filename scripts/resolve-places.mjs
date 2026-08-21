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
import {
  PlacesClient,
  googleConfigured,
  googleSettings,
  sweepPlaces,
} from '../packages/ingest/dist/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const limit = Number(value('--limit', '200'));
const settings = googleSettings();

// The dry run comes FIRST, deliberately. Listing the queue is a database
// read — it calls Google for nothing — and "how many hotels are waiting, and
// which ones" is exactly the question worth answering BEFORE deciding whether
// to add a paid key. Gating it behind the key made the dry run useless in the
// one situation it was written for.
if (flag('--dry-run')) {
  const targets = await findResolutionTargets(limit, settings.refreshHours);
  const fresh = targets.filter((t) => !t.placeId).length;
  // Hotels a real run would skip without calling Google. This is the number
  // that decides whether the key is worth spending on, so it is on the
  // headline rather than inferable from the 25 rows printed below.
  const noGeo = targets.filter((t) => !t.placeId && t.latitude === null).length;
  console.log(
    `${targets.length} hotel(s) queued (limit ${limit}, refresh ${settings.refreshHours}h) — ` +
      `${fresh} never looked up, ${targets.length - fresh} due a refresh, ` +
      `${noGeo} unplaceable (skipped, no call made).`,
  );
  console.log(
    `A real run would make about ${fresh - noGeo} search call(s) and ` +
      `${targets.length - noGeo} details call(s).`,
  );
  for (const t of targets.slice(0, 25)) {
    console.log(
      `  ${t.hotelId}  ${t.name}${t.city ? ` — ${t.city}` : ''}${t.placeId ? '  [refresh]' : ''}` +
        `${t.latitude === null ? '  (no coordinates — cannot be verified)' : ''}`,
    );
  }
  if (targets.length > 25) console.log(`  … and ${targets.length - 25} more`);

  // Said last so it is the line a reader ends on, and said as a fact about
  // this run rather than as an error: an absent key is a supported state.
  if (!googleConfigured()) {
    console.log('\nGOOGLE_PLACES_API_KEY is not set — a real run would resolve none of these.');
  }
  await closePool();
  process.exit(0);
}

if (!googleConfigured()) {
  console.log('GOOGLE_PLACES_API_KEY is not set — nothing to do.');
  await closePool();
  process.exit(0);
}

// Distinct refusal reasons, printed once each. "45 failed" is a shrug;
// "403 PERMISSION_DENIED: Places API (New) has not been enabled" is a fix.
const seenErrors = new Set();
const client = PlacesClient.fromEnv({
  onRequest: ({ kind, ok, status, detail }) => {
    if (ok) return;
    const line = `${kind} ${status ?? 'no-response'}${detail ? `: ${detail}` : ''}`;
    if (!seenErrors.has(line)) {
      seenErrors.add(line);
      console.log(`  google error — ${line}`);
    }
  },
});

const started = Date.now();
const result = await sweepPlaces({
  limit,
  client,
  onHotel: ({ hotel, status, confidence, reasons }) => {
    const conf = confidence === null ? '' : ` ${confidence}`;
    console.log(`  ${status.padEnd(10)}${conf.padEnd(6)} ${hotel.name} — ${reasons.join('; ')}`);
  },
});

console.log(
  `\n${result.considered} considered in ${Math.round((Date.now() - started) / 1000)}s: ` +
    `${result.verified} verified, ${result.unverified} unverified, ` +
    `${result.noMatch} no match, ${result.failed} failed, ` +
    `${result.skippedNoGeo} skipped for want of coordinates.`,
);
if (result.failed > 0) {
  // Not an error exit: failures write nothing and are retried next sweep.
  console.log('Failed lookups were not recorded and stay in the queue.');
}
if (result.skippedNoGeo > 0) {
  // Named as a catalogue problem, because that is what it is. Nothing about
  // reputation can be fixed by trying harder here.
  console.log(
    `${result.skippedNoGeo} hotel(s) have no coordinates, so no Google result could clear ` +
      'the match threshold. They were not asked about and not recorded, and they resolve ' +
      'on their own once the catalogue carries their location.',
  );
}

await closePool();
