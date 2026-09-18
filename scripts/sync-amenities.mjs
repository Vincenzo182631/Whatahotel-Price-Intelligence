#!/usr/bin/env node
/**
 * Fill `hotel_amenity` from `method=info` (migration 0021).
 *
 *   WAH_API_KEY=... npm run amenities
 *   WAH_API_KEY=... npm run amenities -- --limit 500
 *   WAH_API_KEY=... npm run amenities -- --dry-run   # show the queue, call nothing
 *
 * Rule 21 recorded that this source states no amenities, because `info`
 * answered 500 for our key. Matt fixed that on 2026-09-17 and it now answers
 * for 18 of 20 sampled hotels, with a CODED per-room amenity list that
 * genuinely varies per property. This sweep is how that reaches the
 * preference layer, which today says "limited information is available" for
 * four of its ten options.
 *
 * What it will NOT do is guess which hotel an answer describes. `info` is
 * keyed on name + city and returns no hotel name, so `syncHotelAmenities`
 * writes only when the response's `amadeus.codes` matches the
 * `ama-property` the by-id lookup stored for that hotel. Every other outcome
 * is counted and named below rather than written, because attaching one
 * hotel's amenities to another is silent and permanent.
 *
 * Amenities are not a score. Nothing under packages/core/src/scoring reads
 * this table — rule 21 keeps included value as the only quality evidence
 * inside the number.
 */

import {
  closePool,
  findHotelsNeedingAmenities,
  findAmadeusProperty,
  upsertHotelAmenities,
} from '../packages/data/dist/index.js';
import { WahClient, syncHotelAmenities } from '../packages/ingest/dist/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const limit = Number(value('--limit', '200'));
const concurrency = Math.max(1, Math.min(4, Number(value('--concurrency', '2'))));

const targets = await findHotelsNeedingAmenities(limit);

if (flag('--dry-run')) {
  console.log(`${targets.length} hotel(s) queued (limit ${limit})`);
  for (const t of targets.slice(0, 25)) console.log(`  ${t.hotelId}  ${t.name} — ${t.city}`);
  if (targets.length > 25) console.log(`  … and ${targets.length - 25} more`);
  await closePool();
  process.exit(0);
}

// Gentle on purpose: this is a sweep over the whole catalogue against an API
// whose rate limit is still unknown (U15), and nothing downstream is waiting
// on it. The 30s timeout is the client default; a hang costs one hotel.
const client = WahClient.fromEnv({ concurrency });

const counts = new Map();
let written = 0;
const mismatches = [];

const queue = [...targets];
async function worker() {
  for (;;) {
    const target = queue.shift();
    if (!target) return;
    const result = await syncHotelAmenities(target, {
      client,
      findAmadeusProperty,
      upsertHotelAmenities,
    });
    counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
    written += result.written;
    if (result.outcome === 'CODE_MISMATCH') {
      // Worth a human's eye: either our stored code is stale or the source
      // answered about a different property for this name and city. Both are
      // findings, and both are why nothing was written.
      mismatches.push(`${target.hotelId} ${target.name}: stored ${result.storedCode} vs info ${result.responseCode}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const summary = [...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([outcome, n]) => `${outcome} ${n}`)
  .join(', ');
console.log(`amenities: ${written} row(s) written across ${targets.length} hotel(s) — ${summary}`);
for (const line of mismatches.slice(0, 20)) console.log(`  mismatch: ${line}`);
if (mismatches.length > 20) console.log(`  … and ${mismatches.length - 20} more mismatches`);

await closePool();
