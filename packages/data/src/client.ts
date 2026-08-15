/**
 * Postgres connection handling.
 *
 * All SQL in the project lives under packages/data. `packages/core` stays pure
 * so scores remain reproducible from stored inputs alone.
 */

import pg from 'pg';

const { Pool, types } = pg;

// int8 arrives as a string by default to avoid precision loss. Every BIGINT we
// read is a minor-unit amount or a row count, all far inside Number.MAX_SAFE_INTEGER,
// and silently receiving strings where the engine expects numbers would produce
// string concatenation instead of arithmetic.
types.setTypeParser(20, (value: string) => Number(value));
// numeric → number, for confidence and similarity columns.
types.setTypeParser(1700, (value: string) => Number(value));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (pool) return pool;
  const url =
    connectionString ?? process.env.DATABASE_URL ?? 'postgres://wahpi:wahpi@localhost:5433/wahpi';
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  poolOverride?: pg.Pool,
): Promise<T> {
  const client = await (poolOverride ?? getPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export function db(override?: Queryable): Queryable {
  return override ?? getPool();
}
