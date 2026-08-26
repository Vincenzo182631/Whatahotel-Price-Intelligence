#!/usr/bin/env node
/**
 * Minimal forward-only migration runner.
 *
 * Applies db/migrations/*.sql in filename order inside a transaction each,
 * recording applied versions in schema_migration. Seeds under db/seeds are
 * applied after migrations when --seed is passed.
 *
 * Usage:
 *   node scripts/migrate.mjs            apply pending migrations
 *   node scripts/migrate.mjs --seed     apply migrations, then seeds
 *   node scripts/migrate.mjs --reset    drop and recreate the schema first
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wahpi:wahpi@localhost:5433/wahpi';

const args = new Set(process.argv.slice(2));
const doReset = args.has('--reset');
const doSeed = args.has('--seed') || doReset;

async function psql(sql) {
  const { stdout } = await run('psql', [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Surface what a migration says about itself.
 *
 * psql writes RAISE NOTICE to STDERR, and this helper used to destructure
 * stdout alone — so migration 0017 reported the number of rows it repaired
 * and the run log showed nothing. A data migration that cannot say what it
 * did is a migration nobody can verify, which defeats the point of reporting.
 *
 * Only NOTICE lines are echoed. psql is chatty on stderr (connection notices,
 * "CREATE INDEX will create implicit index" and friends), and reprinting all
 * of it would bury the one line worth reading.
 */
function noticesIn(stderr) {
  return (
    (stderr ?? '')
      .split('\n')
      .filter((line) => /NOTICE:/i.test(line))
      // Strip psql's "psql:<file>:<line>: " prefix, keeping the notice itself.
      // The line number matters: a non-greedy .*? stops at the FIRST colon and
      // leaves "52: NOTICE: …" behind.
      .map((line) => line.replace(/^\s*psql:\S*:\d+:\s*/i, '').trim())
  );
}

async function psqlFile(path) {
  const { stdout, stderr } = await run(
    'psql',
    [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-1', '-f', path],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return { stdout, notices: noticesIn(stderr) };
}

async function listSql(dir) {
  try {
    const files = await readdir(join(root, dir));
    return files.filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

async function main() {
  if (doReset) {
    console.log('• Dropping and recreating schema public');
    await psql('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  }

  await psql(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version    TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum   TEXT        NOT NULL
    );
  `);

  const applied = new Set(
    (await psql('SELECT version FROM schema_migration ORDER BY version;'))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('version') && !l.startsWith('-') && !l.includes('row')),
  );

  const migrations = await listSql('db/migrations');
  let count = 0;

  for (const file of migrations) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const path = join(root, 'db/migrations', file);
    const sql = await readFile(path, 'utf8');
    const checksum = await sha256(sql);

    process.stdout.write(`• Applying ${file} … `);
    const { notices } = await psqlFile(path);
    await psql(
      `INSERT INTO schema_migration (version, checksum) VALUES ('${version}', '${checksum}');`,
    );
    console.log('ok');
    // After the "ok", so a notice reads as a detail of a completed step rather
    // than an interruption of one.
    for (const notice of notices) console.log(`    ${notice}`);
    count += 1;
  }

  console.log(count === 0 ? '• No pending migrations' : `• Applied ${count} migration(s)`);

  await ensurePartitions();
  await enforceRetention();

  if (doSeed) {
    for (const file of await listSql('db/seeds')) {
      process.stdout.write(`• Seeding ${file} … `);
      const { notices } = await psqlFile(join(root, 'db/seeds', file));
      console.log('ok');
      for (const notice of notices) console.log(`    ${notice}`);
    }
  }
}

/**
 * Keep the rate_observation partitions ahead of the data.
 *
 * Runs on EVERY invocation, not only when 0009 is first applied — the whole
 * point is that a database left alone for a few months still has somewhere to
 * put tomorrow's observations. The collection workflow calls this script on
 * every run, so the horizon maintains itself.
 *
 * Skipped silently on a database that predates the function, so an older
 * checkout can still migrate forward.
 */
async function ensurePartitions() {
  const exists = (
    await psql(
      "SELECT 1 FROM pg_proc WHERE proname = 'ensure_rate_observation_partitions' LIMIT 1;",
    )
  ).includes('1');
  if (!exists) return;

  const out = await psql(
    "SELECT partition_name || ' — ' || action FROM ensure_rate_observation_partitions();",
  );
  const rows = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('rate_observation_'));

  if (rows.length === 0) {
    console.log('• Partitions already cover the working window');
  } else {
    for (const row of rows) console.log(`• Partition ${row}`);
  }
}

/**
 * Drop observation partitions older than the retention window — but ONLY when
 * RATE_OBSERVATION_RETAIN_DAYS says so. Production's collect workflow sets it
 * because the Neon free tier caps the whole project at 512 MB and DROP is the
 * only operation that gives that space back (see migration 0015). A developer
 * database never sets it, so seeded 90-day history survives every migrate.
 */
async function enforceRetention() {
  const days = Number(process.env.RATE_OBSERVATION_RETAIN_DAYS || '');
  if (!Number.isInteger(days) || days <= 0) return;

  const exists = (
    await psql(
      "SELECT 1 FROM pg_proc WHERE proname = 'enforce_rate_observation_retention' LIMIT 1;",
    )
  ).includes('1');
  if (!exists) return;

  const out = await psql(
    `SELECT partition_name || ' — ' || action FROM enforce_rate_observation_retention(${days});`,
  );
  const rows = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('rate_observation_'));

  if (rows.length === 0) {
    console.log(`• Retention (${days}d): nothing old enough to drop`);
  } else {
    for (const row of rows) console.log(`• Retention (${days}d): ${row}`);
  }
}

async function sha256(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

main().catch((err) => {
  console.error('\nMigration failed:');
  console.error(err.stderr ?? err.message);
  process.exit(1);
});
