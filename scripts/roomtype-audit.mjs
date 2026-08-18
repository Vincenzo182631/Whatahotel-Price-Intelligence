#!/usr/bin/env node
/**
 * Room-type audit — how much offer prose is already in the catalogue?
 *
 *   npm run diagnose:roomtypes
 *
 * The OFFER_PROSE_AS_ROOM_NAME reject (see pipeline.ts) stops new offer text
 * from becoming a room type. It does nothing about rows ingested before the
 * check existed — the probe already caught one rendering to a customer at
 * Kimpton EPIC Miami ("PER STAY. 30USD DAILY BREAKFAST CREDIT FOR").
 *
 * This measures the blast radius so the cleanup can be sized before it is
 * designed: how many room types trip the same detector the pipeline now uses,
 * and how many observations and baselines hang off each. Deleting a poisoned
 * room type orphans real rates; renaming merges them into some other type.
 * Which is right depends on the numbers this prints, which is why it prints
 * them instead of deciding.
 *
 * Uses the SAME looksLikeOfferProse the pipeline rejects with — a second
 * vocabulary here would drift, and the drifted half would be the one nobody
 * looks at.
 *
 * Read-only. SELECTs only. Safe against production.
 */

import { looksLikeOfferProse } from '../packages/core/dist/index.js';
import { closePool, getPool } from '../packages/data/dist/index.js';

const ROOM_TYPES_QUERY = `
  SELECT rt.id,
         rt.hotel_id,
         h.name AS hotel_name,
         h.wah_hotel_id,
         rt.canonical_name,
         rt.is_active,
         (SELECT count(*) FROM rate_observation o WHERE o.room_type_id = rt.id)  AS observations,
         (SELECT count(*) FROM rate_baseline b WHERE b.room_type_id = rt.id)     AS baselines,
         (SELECT max(o.observed_at) FROM rate_observation o
           WHERE o.room_type_id = rt.id)                                         AS last_seen
    FROM room_type rt
    JOIN hotel h ON h.id = rt.hotel_id
   ORDER BY rt.hotel_id, rt.id
`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — this reads real data or it reads nothing.');
    process.exit(2);
  }

  const db = getPool();
  const { rows } = await db.query(ROOM_TYPES_QUERY);

  console.log('Room-type audit\n');
  console.log(`${rows.length} room type(s) in the catalogue\n`);

  const poisoned = rows.filter((r) => looksLikeOfferProse(r.canonical_name));

  if (poisoned.length === 0) {
    console.log('No room type trips the offer-prose detector. Nothing to clean up.');
  } else {
    console.log(`POISONED — ${poisoned.length} room type(s) named with offer prose:\n`);
    let obsTotal = 0;
    let blTotal = 0;
    for (const r of poisoned) {
      obsTotal += Number(r.observations);
      blTotal += Number(r.baselines);
      console.log(
        `  #${r.id}  ${r.hotel_name} (${r.wah_hotel_id})${r.is_active ? '' : '  [inactive]'}`,
      );
      console.log(`      "${r.canonical_name}"`);
      console.log(
        `      ${r.observations} observation(s) · ${r.baselines} baseline row(s) · ` +
          `last seen ${r.last_seen ? new Date(r.last_seen).toISOString().slice(0, 16) : 'never'}`,
      );
    }
    console.log(
      `\n  Total attached: ${obsTotal} observation(s), ${blTotal} baseline row(s) — ` +
        'these are what a cleanup decision has to account for.',
    );
    console.log(
      '  With the ingest reject in place these types receive no NEW observations,\n' +
        '  so the numbers above are final unless the source changes.',
    );
  }

  // The near-misses matter as much as the hits: names the detector does NOT
  // flag but that look suspiciously un-roomlike (very short, all digits, or
  // starting with punctuation). Printed so a human can eyeball whether the
  // vocabulary needs another pattern — extending it is a code review decision,
  // never something this script does on its own.
  const odd = rows.filter(
    (r) =>
      !looksLikeOfferProse(r.canonical_name) &&
      (r.canonical_name.trim().length < 6 || /^[^A-Za-z]/.test(r.canonical_name.trim())),
  );
  if (odd.length > 0) {
    console.log(`\nWORTH A HUMAN LOOK — ${odd.length} name(s) the detector does not flag:\n`);
    for (const r of odd.slice(0, 15)) {
      console.log(`  #${r.id}  ${r.hotel_name}: "${r.canonical_name}"`);
    }
    if (odd.length > 15) console.log(`  … and ${odd.length - 15} more`);
  }

  await closePool();
  // Exit 0 either way: this is a measurement, not a gate. Making it red on
  // findings would train people to ignore a red diagnostics workflow.
}

main().catch((err) => {
  console.error(`Audit failed: ${err?.message ?? err}`);
  closePool().finally(() => process.exit(1));
});
