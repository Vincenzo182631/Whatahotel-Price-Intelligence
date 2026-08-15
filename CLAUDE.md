# WhataHotel Price Intelligence — working notes

Embedded hotel price-intelligence platform. Answers one question: _is this hotel
rate actually a good deal?_

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
npm run calibrate -- --sweep --report out.md   # calibration runbook (doc 11)

# Real collection. WAH_API_KEY is a credential — env only, never committed.
WAH_API_KEY=... npm run collect -- --catalog miami   # sync hotels + their perks
WAH_API_KEY=... npm run collect                      # top up the grid + refresh what is due
WAH_API_KEY=... npm run collect -- --bootstrap       # grid only, skip the due-refresh
WAH_API_KEY=... npm run collect -- --dry-run         # show the plan, call nothing
```

Collection runs from `.github/workflows/collect.yml`. **Its schedule is
currently commented out** — it is manual-dispatch only until a database
reachable from GitHub-hosted runners exists, because a scheduled run with no
`DATABASE_URL` fails four times a day and buries real failures in noise. The
cadence to restore is 6 hours, the scheduler's shortest tier interval; anything
coarser silently caps every tier at the cron period. **Read
[`docs/runbooks/collection.md`](./docs/runbooks/collection.md) before changing
it** — and note that every day the schedule stays off is a day of baseline this
source cannot backfill.

Integration tests run only when `DATABASE_URL` is set; they skip otherwise so
`npm test` works without a database.

## Architecture

```
packages/core/     pure scoring engine — NO I/O of any kind
packages/data/     the ONLY SQL in the project
packages/ingest/   adapters, pipeline, rollups, comp sets, scheduler
packages/calibration/  point-in-time replay, metrics, weight sweep
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
7. **Synthetic data never leaves development.** `scripts/seed-dev.mjs` fabricates
   rates so the pipeline can be exercised. It refuses to run without
   `ALLOW_SYNTHETIC_SEED=1`, because once synthetic rows are in
   `rate_observation` they are indistinguishable from real ones. Do not remove
   that guard, and do not point it at anything but a local database.
8. **The calibration sweep never writes config.** It emits a suggestion.
   Activating a configuration is a reviewed decision with evidence attached.
9. **A factor that cannot be measured is excluded, not scored well.** `cv` over
   one observation is not zero volatility, it is no information — scoring it
   1.00 made confidence _fall_ as the second observation arrived. Same principle
   as rule 3. Set `included: false` and let the weights renormalize.
10. **The API key is a credential.** `WAH_API_KEY`, environment only, redacted
    from every log line by `redact()`. Committed fixtures are scrubbed of the
    key and of `cfid`/`cftoken` session tokens, and a test enumerates the
    fixture directory to enforce it — do not replace that with a hardcoded
    list of filenames.
11. **View is a hard rule, like room class.** An OCEANFRONT room never merges
    with a CITY one. Both rules exist because a wrong merge mixes price tiers
    invisibly: before the view rule, five view categories spanning a 37% price
    range collapsed into one "room type".
12. **Tests are typechecked** (`tsconfig.tests.json`, wired into
    `npm run typecheck`). They import package source, so `tsc --build` does not
    see them; without this a test drifts out of sync with the interface it
    exercises and nothing complains.
13. **The property suite is seeded.** Unseeded it drew fresh inputs each run, so
    a real engine bug surfaced as intermittent flakiness. Use `FC_SEED=<n>` to
    explore deliberately, and promote any counterexample to a unit test.
14. **The stay grid must be topped up on every run, not just at cold start.**
    Lead times are relative to today, while `planCollection` only refreshes
    stays it can already see. Without the top-up the tracked set freezes at
    whatever the first run captured and empties after ~90 days — with every run
    still exiting 0. See `findMissingGridStays`.
15. **A stay that yields nothing must back off.** It has no observation, so the
    grid sees it as missing and would re-request it every run forever;
    `collection_attempt` exists solely to stop that. It is not a fact table —
    nothing in it reaches a baseline or a score. Any success resets the counter.

## Adding or changing a factor

1. Update `docs/mvp/02-deal-score.md` with the rationale first.
2. Add the weight to `defaults.ts` (weights must sum to 1.0; validated).
3. Regenerate the seed: `npm run config:seed`.
4. Re-run the scenario suite — band or recommendation changes in S1–S9 must be
   explained before merging.

## Current state

Built and verified: schema and migrations, ingestion pipeline with room-type and
rate-plan normalization, baseline rollups at every ladder level, comp-set
builder, collection scheduler, the full scoring engine, the explanation bundle
and template renderer, the REST API, and the embeddable widget.

**The production source adapter is built** — `packages/ingest/src/adapters/whatahotel/`,
against the real `/data/api.cfm`, and exercised end to end (`npm run collect`).
Its header comment records what the API does and does not provide; the U-register
in `docs/mvp/README.md` is now mostly answered.

Things about this source that are not guessable and cost real money to relearn:

- **Every response is HTTP 200.** The real outcome is `wahData.status.code`. A
  client trusting HTTP reads a 401 as a successful empty result and ingests
  nothing while reporting healthy.
- **`rateDaily` is NET per night; `rateTotal` is GROSS per stay.** Verified by
  probing 1-night against 3-night stays. Using `rateDaily` understates every
  price by the tax factor (~25%).
- **`rateCode` is not the rate plan.** One code carries several priced offers,
  distinguished only by the prose prefix of `roomDesc`. Keying identity on the
  code alone silently discarded the cheapest offer of every three.
- **Status `204` means sold out**, not an error. `500` is a genuine fault and is
  never swallowed.
- **The API emits invalid JSON** (trailing commas) on roughly 20% of `rates`
  calls for some hotels, deterministically. `json.ts` repairs exactly that and
  nothing else.
- **No rate history (U3).** Baselines accrue forward from the first capture;
  expect `INSUFFICIENT_DATA` for roughly the first two weeks. That is the design
  working.

`WHATAHOTEL_INGEST_TUNING` carries the ingest settings this source requires —
room-type discovery on, fuzzy and attribute matching off. Each value fixes a
merge observed in live data; do not relax them without re-measuring.

M7 tooling is built (`npm run calibrate`), but **calibration itself needs real
data**. Running it against the synthetic seed exercises the harness and nothing
more — the report says so in a banner, and the CLI exits 0 on a synthetic FAIL
so it cannot redden a build with a meaningless failure.

Config v2 removed **F5 (Demand)** from the Deal Score: it was an affine function
of F1 and carried no independent signal. Demand still drives guard W4 and gate
G3, where it acts on the recommendation rather than the score. A regression test
asserts the factor list is exactly `[F1, F2, F3, F4, F6]`.

The weights in config v2 remain uncalibrated priors.
