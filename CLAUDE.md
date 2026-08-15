# WhataHotel Price Intelligence — working notes

Embedded hotel price-intelligence platform. Answers one question: *is this hotel
rate actually a good deal?*

The full MVP specification is in [`docs/mvp/`](./docs/mvp/). **Read
`docs/mvp/README.md` before changing scoring behaviour** — most of what looks
like an arbitrary constant is a documented decision.

## Commands

```bash
npm install && npm run build
npm test                 # unit + scenario + property + integration
npm run typecheck
npm run format

npm run db:up            # Postgres 16 via docker compose (port 5433)
npm run db:reset         # drop, migrate, seed reference data
npm run db:check         # schema behaviour checks
npm run config:seed      # regenerate the scoring-config seed from defaults.ts

ALLOW_SYNTHETIC_SEED=1 npm run db:seed-dev   # synthetic rates + rollups + comps
npm run api              # http://localhost:3000 (widget demo at /)
npm run smoke            # API contract checks against a running server
```

Integration tests run only when `DATABASE_URL` is set; they skip otherwise so
`npm test` works without a database.

## Architecture

```
packages/core/     pure scoring engine — NO I/O of any kind
packages/data/     the ONLY SQL in the project
packages/ingest/   adapters, pipeline, rollups, comp sets, scheduler
apps/api/          Node http server (docs/mvp/06)
apps/web/public/   framework-free embeddable widget (docs/mvp/08)
db/migrations/     schema (docs/mvp/05)
db/checks/         schema behaviour checks
tests/             scenarios S1–S9, invariants P1–P12, unit, integration
```

`packages/core` has no database, network, clock or filesystem access. Its
dependencies are its arguments. That is what makes every scenario testable from
fixtures and every stored score reproducible — **do not introduce I/O into it.**
`input.now` is injected for the same reason; never call `Date.now()` inside the
engine.

## Rules that are not style preferences

1. **Money is integer minor units.** Never floats. `roundHalfAwayFromZero`
   exists because Postgres `round(numeric)` and JS `Math.round` disagree, and a
   recomputed score must match a stored one.
2. **WAIT is never emitted below `rec.wait.confidenceMin`.** Enforced in three
   places: the gate, a boundary assertion, and a database CHECK constraint.
   Config cannot lower it past `WAIT_CONFIDENCE_HARD_FLOOR`. Invariant P1 is a
   release blocker.
3. **An absent Deal Score is `null`, never `0`.** A zero renders to the customer
   as "terrible deal". Invariant P2.
4. **The AI never computes.** It receives an `ExplanationBundle` of
   already-computed facts and rewords them. Every number it emits is validated
   against the bundle's allowlist. The deterministic template renderer must
   always work with the model disabled.
5. **Compare like with like.** Rates only ever compare within the same
   comparability class (meal plan × refundability × audience). A `ROOM` never
   merges into a `SUITE` baseline regardless of name similarity.
6. **Weights and thresholds are config, not code.** They live in
   `packages/core/src/config/defaults.ts`, are versioned in `scoring_config`,
   and every `analysis` row records the version that produced it. They are
   starting priors and have **not** been calibrated against real data.

## Adding or changing a factor

1. Update `docs/mvp/02-deal-score.md` with the rationale first.
2. Add the weight to `defaults.ts` (weights must sum to 1.0; validated).
3. Regenerate the seed: `npm run config:seed`.
4. Re-run the scenario suite — band or recommendation changes in S1–S9 must be
   explained before merging.

7. **Synthetic data never leaves development.** `scripts/seed-dev.mjs` fabricates
   rates so the pipeline can be exercised. It refuses to run without
   `ALLOW_SYNTHETIC_SEED=1`, because once synthetic rows are in
   `rate_observation` they are indistinguishable from real ones. Do not remove
   that guard, and do not point it at anything but a local database.

## Current state

Built and verified: schema and migrations, ingestion pipeline with room-type and
rate-plan normalization, baseline rollups at every ladder level, comp-set
builder, collection scheduler, the full scoring engine, the explanation bundle
and template renderer, the REST API, and the embeddable widget.

**Not built: the production source adapter.** `RateSourceAdapter` defines the
interface and a synthetic development implementation exists, but the real one is
blocked on U1–U18 in `docs/mvp/README.md`. Writing it without real payloads would
produce an adapter that compiles and silently mis-maps every rate — the failure
mode with no symptom until the scores are already wrong.

Also outstanding: M7 calibration, which needs real data.
