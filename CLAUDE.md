# WhataHotel Price Intelligence — working notes

Embedded hotel price-intelligence platform. Answers one question: *is this hotel
rate actually a good deal?*

The full MVP specification is in [`docs/mvp/`](./docs/mvp/). **Read
`docs/mvp/README.md` before changing scoring behaviour** — most of what looks
like an arbitrary constant is a documented decision.

## Commands

```bash
npm install
npm test                 # unit + scenario + property tests
npm run typecheck
npm run lint
npm run format

npm run db:up            # Postgres 16 via docker compose (port 5433)
npm run db:reset         # drop, migrate, seed
npm run db:check         # schema behaviour checks
npm run config:seed      # regenerate the scoring-config seed from defaults.ts
```

## Architecture

```
packages/core/     pure scoring engine — NO I/O of any kind
db/migrations/     schema (docs/mvp/05)
db/checks/         schema behaviour checks
tests/             scenarios S1–S9, invariants P1–P12
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

## Current state

Built: schema, migrations, seeds, the full scoring engine, explanation bundle
and template renderer, and the test suite (S1–S9, P1–P12, 9 DB checks).

Not built: the source adapter (`packages/ingest`), baseline rollup jobs, the API
and UI. The adapter is blocked on the U1–U18 data questions in
`docs/mvp/README.md` — it needs real payloads before it can be written honestly.
