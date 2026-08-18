#!/usr/bin/env node
/**
 * Retire room types whose names are offer prose.
 *
 *   npm run cleanup:roomtypes              # plan only — prints, writes nothing
 *   npm run cleanup:roomtypes -- --apply   # do it
 *
 * The audit of 2026-08-18 sized the damage: six room types across two hotels
 * (three "PER STAY. 30USD DAILY BREAKFAST CREDIT FOR" at Kimpton EPIC Miami,
 * three "perks" at InterContinental Miami), 181+ observations attached. The
 * ingest reject stops new ones; this retires the existing ones.
 *
 * WHAT IT DOES, and the reasoning:
 *
 *   1. `is_active = false` on each poisoned type. The true room names never
 *      arrived — the source field itself carried the garbage — so renaming
 *      would be a guess and deletion would orphan real rates. Deactivation is
 *      the honest middle: the type stops being offered to guests, stops
 *      anchoring baselines, stops pricing competitor comparisons (all three
 *      paths filter on is_active), and its history stays auditable.
 *   2. DELETE its rate_baseline rows. A baseline for a fake room is not a
 *      degraded statistic, it is a statistic about nothing; and the rollup
 *      only refreshes active types, so stale rows would otherwise sit there
 *      looking current.
 *   3. KEEP its rate_observation rows. They are real prices really returned
 *      by the source — evidence, even where unattributable. Deleting evidence
 *      to tidy a table is how the next investigation starts blind.
 *
 * Driven by the SAME looksLikeOfferProse the pipeline rejects with, not a
 * hardcoded ID list: IDs differ between databases, and a list goes stale the
 * next time the source misbehaves. Idempotent — a second run finds the types
 * already inactive with no baselines and changes nothing.
 *
 * Writes only with --apply. The default is the plan, because a data change to
 * production should print what it is about to do at least once.
 */

import { looksLikeOfferProse } from '../packages/core/dist/index.js';
import { closePool, getPool, withTransaction } from '../packages/data/dist/index.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — nothing to clean.');
    process.exit(2);
  }

  const db = getPool();
  const { rows } = await db.query(`
    SELECT rt.id, rt.canonical_name, rt.is_active, h.name AS hotel_name, h.wah_hotel_id,
           (SELECT count(*) FROM rate_baseline b WHERE b.room_type_id = rt.id)    AS baselines,
           (SELECT count(*) FROM rate_observation o WHERE o.room_type_id = rt.id) AS observations
      FROM room_type rt
      JOIN hotel h ON h.id = rt.hotel_id
     ORDER BY rt.id
  `);

  const poisoned = rows.filter((r) => looksLikeOfferProse(r.canonical_name));

  console.log(`Room-type cleanup — ${APPLY ? 'APPLY' : 'plan only'}\n`);

  if (poisoned.length === 0) {
    console.log('Nothing trips the detector. Nothing to do.');
    await closePool();
    return;
  }

  for (const r of poisoned) {
    const state = r.is_active ? 'active' : 'already inactive';
    console.log(`  #${r.id}  ${r.hotel_name} (${r.wah_hotel_id})  [${state}]`);
    console.log(`      "${r.canonical_name}"`);
    console.log(
      `      will deactivate · delete ${r.baselines} baseline row(s) · ` +
        `keep ${r.observations} observation(s)`,
    );
  }

  if (!APPLY) {
    console.log('\nPlan only — nothing written. Re-run with --apply to execute.');
    await closePool();
    return;
  }

  const ids = poisoned.map((r) => r.id);
  await withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE room_type SET is_active = false WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    const del = await client.query(
      `DELETE FROM rate_baseline WHERE room_type_id = ANY($1::bigint[])`,
      [ids],
    );
    console.log(
      `\n✓ Deactivated ${upd.rowCount} room type(s), deleted ${del.rowCount} baseline row(s). ` +
        'Observations untouched.',
    );
  });

  await closePool();
}

main().catch((err) => {
  console.error(`Cleanup failed: ${err?.message ?? err}`);
  closePool().finally(() => process.exit(1));
});
