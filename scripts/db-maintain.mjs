// Reclaim database space without touching a single scoring-relevant fact.
//
// Written for the day the Neon project hit its 512 MB ceiling and every
// write — scheduled collection, on-demand rescue, rollups — began failing
// with "could not extend file because project size limit has been
// exceeded", which surfaced to guests as NO_CURRENT_RATE on every stay.
//
// What takes the space is not the facts but the AUDIT PAYLOADS:
//   - rate_observation.raw carries the source's full room object per row,
//     needed only while the row is fresh (booking codes are read from the
//     freshest capture; older raw is diagnostics we have never once read
//     back). Nulling raw on old rows frees the bulk of the table.
//   - ingest_reject stores full raw payloads for review; reviewed or not,
//     they are re-creatable by the next run that hits the same reject.
//
// Order matters on a FULL project: TRUNCATE first — it returns whole files
// to the quota without needing to extend anything — and only then run the
// batched UPDATEs, which need headroom for new row versions.
//
//   node scripts/db-maintain.mjs             # measure only
//   node scripts/db-maintain.mjs --apply     # truncate + slim + vacuum
//   node scripts/db-maintain.mjs --squeeze   # TRUNCATE observations, migrate
//   node scripts/db-maintain.mjs --market 6792 2026-08-30 1 2
//                                            # read-only market probe: why does
//                                            # this hotel's comp pool look the
//                                            # way it does for that stay?
//
// --squeeze is the free-tier reset (see migration 0015): the slim-and-vacuum
// ratchet cannot save a project that is already full, because on Neon only
// TRUNCATE and DROP lower the project-size counter. The squeeze truncates
// rate_observation outright — baselines, analyses and the catalogue persist;
// the observations themselves are re-collected by the next runs — then applies
// pending migrations so 0015 can replace the monthly partitions with daily
// ones while they are empty. Ongoing retention is migrate's job, driven by
// RATE_OBSERVATION_RETAIN_DAYS on every collection run.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. This maintains a real database or nothing.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const SQUEEZE = process.argv.includes('--squeeze');
const KEEP_DAYS = Number(process.env.RAW_KEEP_DAYS ?? 14);
const BATCH = Number(process.env.RAW_BATCH ?? 20_000);

async function sql(query) {
  const { stdout } = await run('psql', [DATABASE_URL, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function measure(label) {
  console.log(`\n── ${label} ──`);
  console.log('database size:', await sql('SELECT pg_size_pretty(pg_database_size(current_database()))'));
  const top = await sql(`
    SELECT relname || ' ' || pg_size_pretty(pg_total_relation_size(c.oid))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','i','t')
     ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`);
  console.log('largest relations:\n  ' + top.split('\n').join('\n  '));
  const rawStats = await sql(`
    SELECT count(*) || ' rows, ' || pg_size_pretty(COALESCE(sum(pg_column_size(raw)),0)::bigint) || ' of raw'
      FROM rate_observation
     WHERE observation_slot < now() - interval '${KEEP_DAYS} days' AND raw IS NOT NULL`);
  console.log(`raw older than ${KEEP_DAYS}d:`, rawStats);
  console.log('ingest_reject:', await sql(`SELECT count(*) || ' rows, ' || pg_size_pretty(pg_total_relation_size('ingest_reject'))  FROM ingest_reject`));
}

// Read-only market probe. Answers, from the database itself, the question the
// API cannot: which hotels the comp-set CTE can even SEE around a subject, and
// what each of them holds for one stay. Exists because diagnosing this through
// the public API means guessing — comps_used says how many survived, never who
// was excluded or why.
const MARKET = process.argv.indexOf('--market');
if (MARKET !== -1) {
  const [wahId, checkIn, nights, adults] = process.argv.slice(MARKET + 1, MARKET + 5);
  if (!wahId || !checkIn || !nights || !adults) {
    console.error('usage: --market <wahHotelId> <checkIn> <nights> <adults>');
    process.exit(1);
  }
  console.log(`\n── market probe: hotel ${wahId}, ${checkIn} × ${nights}n × ${adults}a ──`);
  console.log(
    await sql(`
      SELECT 'subject: id=' || h.id || ' active=' || h.is_active || ' tier=' || h.collection_tier
          || ' dest_id=' || COALESCE(h.destination_id::text, 'NULL')
          || ' dest=' || COALESCE(d.slug, 'NULL')
          || ' lat=' || COALESCE(h.latitude::text, 'NULL')
          || ' lng=' || COALESCE(h.longitude::text, 'NULL')
          || ' curated_comps=' || (SELECT count(*) FROM hotel_comparable c WHERE c.hotel_id = h.id)
        FROM hotel h LEFT JOIN destination d ON d.id = h.destination_id
       WHERE h.wah_hotel_id = '${wahId.replace(/'/g, '')}'`),
  );
  console.log('\ncandidates (same destination or within 30 km), with their stay data:');
  console.log(
    await sql(`
      WITH s AS (
        SELECT id, destination_id, latitude, longitude FROM hotel
         WHERE wah_hotel_id = '${wahId.replace(/'/g, '')}'
      )
      SELECT h.wah_hotel_id || ' ' || left(h.name, 34)
          || ' | active=' || h.is_active
          || ' | dest=' || COALESCE(d.slug, 'NULL')
          || ' | coords=' || (h.latitude IS NOT NULL)
          || ' | km=' || COALESCE(round(sqrt(
                 power(111.32 * (h.latitude - s.latitude)::float8, 2)
               + power(111.32 * cos(radians(s.latitude::float8))
                   * (h.longitude - s.longitude)::float8, 2))::numeric, 1)::text, '?')
          || ' | fresh_obs=' || (
               SELECT count(*) FROM rate_observation o
                WHERE o.hotel_id = h.id AND o.check_in = '${checkIn.replace(/'/g, '')}'::date
                  AND o.nights = ${Number(nights)} AND o.adults = ${Number(adults)}
                  AND o.observed_at >= now() - interval '24 hours')
          || ' | avail=' || COALESCE((
               SELECT o.is_available::text FROM rate_observation o
                WHERE o.hotel_id = h.id AND o.check_in = '${checkIn.replace(/'/g, '')}'::date
                  AND o.nights = ${Number(nights)} AND o.adults = ${Number(adults)}
                ORDER BY o.observed_at DESC LIMIT 1), 'none')
          || ' | attempt=' || COALESCE((
               SELECT a.last_outcome || 'x' || a.consecutive_failures FROM collection_attempt a
                WHERE a.hotel_id = h.id AND a.check_in = '${checkIn.replace(/'/g, '')}'::date
                  AND a.nights = ${Number(nights)} AND a.adults = ${Number(adults)}
                LIMIT 1), 'none')
        FROM hotel h
        JOIN s ON h.id <> s.id
        LEFT JOIN destination d ON d.id = h.destination_id
       WHERE (s.destination_id IS NOT NULL AND h.destination_id = s.destination_id)
          OR (s.latitude IS NOT NULL AND h.latitude IS NOT NULL
              AND power(111.32 * (h.latitude - s.latitude)::float8, 2)
                + power(111.32 * cos(radians(s.latitude::float8))
                    * (h.longitude - s.longitude)::float8, 2) <= power(30, 2))
       ORDER BY h.wah_hotel_id`),
  );
  process.exit(0);
}

await measure('before');

if (SQUEEZE) {
  // Whole files back to the quota. TRUNCATE needs no free space, which is the
  // point: this works on a project where every INSERT and UPDATE fails.
  console.log('\nTRUNCATE rate_observation (baselines, analyses and the catalogue persist) …');
  await sql('TRUNCATE rate_observation');
  console.log('TRUNCATE ingest_reject …');
  await sql('TRUNCATE ingest_reject');

  // Apply pending migrations while the partitions are empty — 0015 swaps the
  // monthly partitions for daily ones, and refuses to run over data.
  console.log('Applying migrations (node scripts/migrate.mjs) …');
  const { stdout } = await run('node', ['scripts/migrate.mjs'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  console.log(stdout.trim());

  await measure('after');
  console.log(
    '\nSqueeze done. Dispatch the collection workflow now — the grid refills ' +
      'over the next cycles, and on-demand scoring works as soon as a guest asks.',
  );
  process.exit(0);
}

if (!APPLY) {
  console.log('\nMeasure-only run. Re-run with --apply to reclaim.');
  process.exit(0);
}

// 1. Whole files back to the quota, no extension needed even when full.
console.log('\nTRUNCATE ingest_reject …');
await sql('TRUNCATE ingest_reject');

// 2. Old audit payloads — as a RATCHET, because on a genuinely full
// project even a modest UPDATE cannot extend a file. An UPDATE only adds
// new tuple versions; the space comes back when VACUUM reclaims the old
// ones and their TOASTed raw values. So: small batch, VACUUM the
// partition, grow the batch as headroom accumulates; on a size-limit
// error, halve and vacuum again. The first batches squeeze into whatever
// TRUNCATE just freed, and each round makes the next one roomier.
console.log(`Slimming raw older than ${KEEP_DAYS} days (adaptive batches, target ${BATCH}) …`);
const partitions = (
  await sql(`
    SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'rate_observation'::regclass ORDER BY c.relname`)
).split('\n').filter(Boolean);

let total = 0;
let batch = 500;
let failures = 0;
for (;;) {
  let n = 0;
  try {
    const out = await sql(`
      WITH victims AS (
        SELECT id, observation_slot FROM rate_observation
         WHERE observation_slot < now() - interval '${KEEP_DAYS} days' AND raw IS NOT NULL
         LIMIT ${batch})
      UPDATE rate_observation o SET raw = NULL
        FROM victims v
       WHERE o.id = v.id AND o.observation_slot = v.observation_slot
      RETURNING 1`);
    n = out === '' ? 0 : out.split('\n').length;
  } catch (err) {
    if (String(err).includes('size limit')) {
      failures += 1;
      batch = Math.max(50, Math.floor(batch / 2));
      console.log(`  size limit hit — batch down to ${batch}, vacuuming …`);
      for (const part of partitions) await sql(`VACUUM ${part}`).catch(() => {});
      if (failures > 12) throw new Error('cannot reclaim: repeated size-limit failures at minimum batch');
      continue;
    }
    throw err;
  }
  total += n;
  console.log(`  batch of ${batch}: ${n} slimmed (total ${total})`);
  if (n === 0) break;
  // The ratchet: reclaim what this batch freed, then try a bigger bite.
  for (const part of partitions) await sql(`VACUUM ${part}`).catch(() => {});
  batch = Math.min(BATCH, batch * 2);
}

// 3. A final pass with ANALYZE so the planner sees the new shape.
console.log('VACUUM ANALYZE rate_observation …');
await sql('VACUUM ANALYZE rate_observation');

await measure('after');
console.log('\nDone. Note: freed pages are reused by new writes; the project size figure itself shrinks only as files are truncated or rewritten.');
