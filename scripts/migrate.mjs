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

async function psqlFile(path) {
  const { stdout } = await run('psql', [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-1', '-f', path], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
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
    await psqlFile(path);
    await psql(
      `INSERT INTO schema_migration (version, checksum) VALUES ('${version}', '${checksum}');`,
    );
    console.log('ok');
    count += 1;
  }

  console.log(count === 0 ? '• No pending migrations' : `• Applied ${count} migration(s)`);

  if (doSeed) {
    for (const file of await listSql('db/seeds')) {
      process.stdout.write(`• Seeding ${file} … `);
      await psqlFile(join(root, 'db/seeds', file));
      console.log('ok');
    }
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
