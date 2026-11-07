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
 * It cannot guess which hotel an answer describes, because it no longer has
 * to. The sweep calls `method=infoid`, which is keyed on the hotel id, so the
 * REQUEST establishes identity and the response is about that property by
 * construction. The old name-keyed `info` could not say, which is why this
 * file used to refuse any answer whose `amadeus.codes` did not match a stored
 * `ama-property` — and why it skipped most of the catalogue, since that
 * column was only introduced on 2026-09-18 and is still NULL on rows written
 * before it.
 *
 * The code comparison survives as corroboration: where both sides are
 * present and disagree, the amenities are still written and the
 * disagreement is reported below. Measured 2026-09-18 over 30 hotels: 28
 * agreed, 0 disagreed, 2 answered on neither side.
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
const disagreements = [];

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
    if (result.codeDisagreement) {
      // Not a refusal: infoid is keyed on the id, so the answer is this
      // hotel's whatever our column says. Almost certainly a stale stored
      // code, and rare enough (0 of 28 measured) that a run full of them
      // would mean something changed upstream.
      disagreements.push(
        `${target.hotelId} ${target.name}: stored ${result.storedCode} vs infoid ${result.responseCode}`,
      );
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const summary = [...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([outcome, n]) => `${outcome} ${n}`)
  .join(', ');
console.log(`amenities: ${written} row(s) written across ${targets.length} hotel(s) — ${summary}`);
for (const line of disagreements.slice(0, 20)) console.log(`  code disagreement: ${line}`);
if (disagreements.length > 20)
  console.log(`  … and ${disagreements.length - 20} more code disagreements`);

await closePool();
