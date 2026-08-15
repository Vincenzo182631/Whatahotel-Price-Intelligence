# WhataHotel Price Intelligence

An embedded hotel price-intelligence platform designed to help luxury travelers understand whether a hotel rate is genuinely attractive — and turn that insight into a booking or advisor conversation.

The product answers one question: **is this rate actually a good deal?** It answers it with a deterministic engine over stored rate history, and uses language generation only to explain the result — never to decide it.

## Status

| Milestone                                       | State                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M0 · Data source verification                   | ✅ — answered against the live API; [U1–U18](./docs/mvp/README.md#unverified-inputs-register) records what it does and does not provide |
| M1 · Foundation, schema, migrations, CI         | ✅                                                                                                                                      |
| M2 · Ingestion and normalization                | ✅ — including the production WhataHotel adapter (`npm run collect`)                                                                    |
| M3 · Baselines, rollups, comparables, scheduler | ✅                                                                                                                                      |
| M4 · Scoring engine                             | ✅                                                                                                                                      |
| M5 · Explanation layer                          | ✅ template path; model path behind a config flag                                                                                       |
| M6 · API and widget                             | ✅                                                                                                                                      |
| M7 · Calibration tooling                        | ✅ harness built; **calibration itself needs real data**                                                                                |

270 tests passing (scenarios, property invariants, unit, and integration against PostgreSQL), 9 schema behaviour checks, 38 API smoke checks.

**The first real collection has run**: 15 Miami hotels, 1,109 rates, all matched
at SOURCE_ID or ALIAS_EXACT confidence, rolled up into 1,617 baseline rows. The
engine correctly returns `INSUFFICIENT_DATA` with a `null` score — the source
carries no rate history (U3), so baselines accrue forward from the first capture.
Expect roughly two weeks of collection before scores appear.

```bash
export WAH_API_KEY=...                  # a credential; never committed
npm run collect -- --catalog miami      # sync hotels and their perks
npm run collect                         # top up the grid + refresh what is due
```

`.github/workflows/collect.yml` runs the same commands in CI. Its schedule is
**currently commented out** — manual dispatch only until the `WAH_API_KEY` and
`DATABASE_URL` repository secrets exist and the database is reachable from
GitHub-hosted runners. Restore the 6-hourly cadence by uncommenting two lines. See
[`docs/runbooks/collection.md`](./docs/runbooks/collection.md) for the cadence
trade-off, the server cron/systemd alternatives, and what to do when a run
fails — with no rate history in the source, a missed run is unrecoverable data.

**Two things to be clear about:**

1. **The scoring weights have not been calibrated against real data.** They are documented starting priors — see the [calibration runbook](./docs/mvp/02-deal-score.md#4-score-bands-and-calibration).
2. **No rate data is committed to this repository.** Real rates are collected into a database by `npm run collect`; the only rate-like data in the tree is the synthetic development seed, which is fabricated by a seeded generator and refuses to run without `ALLOW_SYNTHETIC_SEED=1`. No number it produces reflects a real hotel rate.

## Quick start

```bash
npm install
npm run build

npm run db:up                              # PostgreSQL 16 on port 5433
npm run db:reset                           # migrate + seed reference data
ALLOW_SYNTHETIC_SEED=1 npm run db:seed-dev # synthetic rates, rollups, comp sets

npm test                                   # 270 tests
npm run db:check                           # schema behaviour checks
npm run api                                # http://localhost:3000
npm run smoke                              # API contract checks
npm run calibrate -- --sweep               # calibration runbook
```

Then open <http://localhost:3000> for the widget demo harness.

## How it fits together

```
 rate source ──► ingest pipeline ──► rate_observation ──► rollup ──► rate_baseline
 (adapter)       validate                (append-only,              (one row per
                 normalize                partitioned)               ladder level)
                 classify                                                 │
                                                                          ▼
   widget ◄────── API ◄────── scoring engine ◄── loadScoringInput ◄────────┘
 (vanilla JS)   (Node http)   (pure, no I/O)     (the only SQL seam)
```

## Documentation

The full MVP specification is in [`docs/mvp/`](./docs/mvp/). Start with [`docs/mvp/README.md`](./docs/mvp/README.md).

| Doc                                                  | Covers                                             |
| ---------------------------------------------------- | -------------------------------------------------- |
| [01](./docs/mvp/01-data-architecture.md)             | Entities, normalization, timestamping, baselines   |
| [02](./docs/mvp/02-deal-score.md)                    | Deal Score — six factors, math, weights, rationale |
| [03](./docs/mvp/03-confidence-and-recommendation.md) | Confidence Score and the BOOK NOW / WAIT engine    |
| [04](./docs/mvp/04-explanation-engine.md)            | Explanation bundle and AI guardrails               |
| [05](./docs/mvp/05-database-schema.md)               | PostgreSQL schema                                  |
| [06](./docs/mvp/06-api.md)                           | REST API                                           |
| [07](./docs/mvp/07-testing.md)                       | Test scenarios and invariants                      |
| [08](./docs/mvp/08-ui.md)                            | Customer-facing information                        |
| [09](./docs/mvp/09-implementation-plan.md)           | Milestones and module tree                         |
| [10](./docs/mvp/10-configuration-registry.md)        | Every tunable weight and threshold                 |
| [11](./docs/mvp/11-calibration-tooling.md)           | Calibration harness, metrics and weight sweep      |

Working notes for contributors: [`CLAUDE.md`](./CLAUDE.md).
