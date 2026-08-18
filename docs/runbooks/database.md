# Runbook — the production database

The collection workflow and the API both need one Postgres. This is how it gets
created, prepared, and kept healthy.

> **Why this matters more than it looks.** This source has no rate history (U3):
> it answers "what is the rate now", never "what was it". Every observation this
> database holds is one that cannot be re-fetched. A restore from a week-old
> backup loses a week of baseline permanently.

---

## 1. Requirements

|              |                                                                  |
| ------------ | ---------------------------------------------------------------- |
| Version      | **PostgreSQL 16 or newer**                                       |
| Extensions   | `pg_trgm`, `btree_gist` (created by migration 0001)              |
| Reachability | A public endpoint, if collection runs from GitHub-hosted runners |
| TLS          | **Required.** `?sslmode=require` in the URL                      |
| Size         | Small. See §5 — the fact table grows slowly                      |

Any managed Postgres meets this. The choice is about operational preference, not
capability.

**We use [Neon](https://neon.tech).** It scales to zero between the 6-hourly
collection runs, which suits an intermittent cron better than an always-on
instance, and the free tier is comfortably above what §5 projects. Nothing in
this project depends on Neon specifically — the only provider-shaped detail is
the pooled-endpoint trap below, and that applies to Supabase too.

## 2. Getting the connection string to the runner

**Do not paste the URL into a terminal, a chat window, or an issue.** It carries
the password.

1. Create the database with your provider.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**, name `DATABASE_URL`, paste the URL there.
3. Append `?sslmode=require` if the provider's URL does not already have it.

That is the only place the credential needs to exist.

### On Neon, concretely

1. Create a project. **Postgres 16 or 17**, region **AWS US East (Ohio)** or
   **N. Virginia** — GitHub-hosted runners are mostly US East, and the collector
   makes thousands of small round trips per run, so latency there is worth more
   than it looks.
2. On the dashboard's connection widget, **turn "Connection pooling" OFF**. The
   URL should read `…@ep-something.us-east-2.aws.neon.tech/neondb` with **no**
   `-pooler` in the host. See below for why.
3. Neon appends `?sslmode=require` already. Keep it.
4. Leave autosuspend at its default. A cold start costs the first query of a run
   a few hundred milliseconds, which is nothing against a 45-minute timeout.

### Pooled vs direct URLs

Several providers offer two endpoints — a direct connection and a transaction
pooler (Neon's `-pooler` host, Supabase's port 6543). **Use the direct URL for
`DATABASE_URL`.** A `-pooler` host in the secret is the single most likely way
for this setup to go wrong, and it fails confusingly rather than cleanly. Migrations run DDL and the schema checks run inside a single
transaction; a transaction pooler can hand consecutive statements to different
backends, which breaks both. The API's connection volume is nowhere near needing
a pooler.

## 3. First-time setup

Run the **Database setup** workflow (Actions → Database setup → Run workflow)
with `confirm: apply`.

It refuses to proceed unless the server is 16+, the connection is encrypted, and
both extensions are available — so a wrong URL fails in the first ten seconds
rather than halfway through migration 0001. Then it applies migrations, seeds
reference data, runs the schema behaviour checks, and prints a readiness report.

Running it with anything other than `apply` reports what it would do and changes
nothing.

It is safe to re-run. Migrations are forward-only and recorded in
`schema_migration`; the seeds upsert. **There is deliberately no reset option.**

Equivalent by hand, if you are operating the database directly:

```bash
export DATABASE_URL='postgres://…?sslmode=require'
node scripts/migrate.mjs --seed
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/checks/schema_checks.sql
```

## 4. Turning collection on

In order, because each step proves the one before it:

1. Set the `WAH_API_KEY` secret (see [collection.md](./collection.md) §Setting up
   the API key).
2. Run **Database setup** with `confirm: apply`. Readiness report should show
   9+ migrations, 8 benefits, config version 4.
3. Run **Collect rates** with `dry_run: true`. This proves the API key and the
   database connection without spending a single rate call.
4. Run **Collect rates** with `dry_run: false` once. This populates the hotel
   catalogue and the first observations.
5. Uncomment the two `schedule:` lines in `.github/workflows/collect.yml`.

Expect `INSUFFICIENT_DATA` from the history model for roughly two weeks — that
is the design working, not a fault. The **live model answers immediately**, as
soon as one collection has run across a comp set.

## 5. Partitions — the one piece of routine maintenance

`rate_observation` is partitioned monthly on `observation_slot`. Migration 0003
created three months and a `DEFAULT`.

**`DEFAULT` is what makes this dangerous rather than merely untidy.** It accepts
anything, so running past the last real partition is silent: collection keeps
reporting healthy while every new row piles into one unpruned heap. And those
rows then _block_ the partition that should have held them — Postgres validates
`DEFAULT` against a new partition's bounds and refuses to create one whose range
is already represented there:

```
ERROR:  updated partition constraint for default partition
        "rate_observation_default" would be violated by some row
```

Migration 0009 fixes this permanently:

- `ensure_rate_observation_partitions(months_ahead)` creates whatever is missing
  from the current month forward, and **moves any rows already stranded in
  `DEFAULT` into the partition that should hold them** — carrying their ids, so
  the trail back to the ingest batch survives the repair.
- `scripts/migrate.mjs` calls it on **every** invocation, and the collection
  workflow calls that script on every run. The horizon maintains itself.
- Schema check 10 fails if the horizon drops under 3 months; check 11 fails if
  anything is sitting in `DEFAULT`.

So there is nothing to do routinely. If check 10 or 11 ever fails, the fix is
`node scripts/migrate.mjs`.

### Growth

The grid is 46 stays per hotel (23 lead times × 2 stay lengths). At the current
nine-hotel catalogue and the 6-hour cadence that is **at most** ~1.7k rows a day
— fewer in practice, since only the HOT tier refreshes every 6 hours while WARM
is 24h and COLD 72h. Under a million rows a year, a few hundred MB with indexes. The
free tier of any managed provider is ample for the MVP. Growth is linear in
hotels × grid size, so revisit if the catalogue grows past a few hundred hotels.

## 6. Backups

The provider's automated backups are enough — but **check the retention
window**, and remember what §0 says: restoring to yesterday loses a day of
baseline that cannot be re-fetched. Point-in-time recovery is worth having here
in a way it would not be for a database you can rebuild from source.

`analysis` rows are reproducible from `rate_observation` plus the
`scoring_config` version they record. `rate_observation` is not reproducible from
anything.

## 7. When something is wrong

| Symptom                                          | Cause                                          | Fix                                                                                    |
| ------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Setup fails on TLS                               | URL has no `sslmode`                           | Append `?sslmode=require`                                                              |
| Setup fails on an extension                      | Provider does not offer `pg_trgm`/`btree_gist` | Use a different provider — 0001 needs both                                             |
| `password authentication failed`                 | Secret has a stale password                    | Rotate at the provider, update the secret                                              |
| Migration hangs                                  | `DATABASE_URL` points at a transaction pooler  | Use the direct URL (§2)                                                                |
| Check 10 or 11 fails                             | Partition horizon missed                       | `node scripts/migrate.mjs`                                                             |
| API returns `NO_CURRENT_RATE` for everything     | No collection has run yet                      | §4 steps 3–4                                                                           |
| `/api/v1/health` reports `provenance: SYNTHETIC` | Synthetic seed was pointed at this database    | **Stop.** Rebuild it — synthetic rows are indistinguishable from real ones once stored |
