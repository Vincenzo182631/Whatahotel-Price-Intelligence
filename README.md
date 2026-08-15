# WhataHotel Price Intelligence

An embedded hotel price-intelligence platform designed to help luxury travelers understand whether a hotel rate is genuinely attractive — and turn that insight into a booking or advisor conversation.

The product answers one question: **is this rate actually a good deal?** It answers it with a deterministic engine over stored rate history, and uses language generation only to explain the result — never to decide it.

## Status

| Milestone | State |
|---|---|
| M0 · Data source verification | **Blocked** — see [U1–U18](./docs/mvp/README.md#unverified-inputs-register) |
| M1 · Foundation, schema, migrations, CI | ✅ Done |
| M2 · Source adapter and ingestion | Not started — needs M0 |
| M3 · Baseline rollups and scheduling | Not started |
| M4 · Scoring engine | ✅ Done |
| M5 · Explanation layer (template path) | ✅ Done — model path behind a config flag |
| M6 · API and UI | Not started |
| M7 · Calibration | Not started |

134 tests passing: 10 scenarios, 12 property-based invariants, unit and edge coverage. 9 schema behaviour checks against PostgreSQL 16.

**The scoring weights have not been calibrated against real data.** They are documented starting priors. See the [calibration runbook](./docs/mvp/02-deal-score.md#4-score-bands-and-calibration).

## Quick start

```bash
npm install
npm test

npm run db:up        # PostgreSQL 16 on port 5433
npm run db:reset     # migrate + seed
npm run db:check     # schema behaviour checks
```

## Documentation

The full MVP specification is in [`docs/mvp/`](./docs/mvp/). Start with [`docs/mvp/README.md`](./docs/mvp/README.md).

| Doc | Covers |
|---|---|
| [01](./docs/mvp/01-data-architecture.md) | Entities, normalization, timestamping, baselines |
| [02](./docs/mvp/02-deal-score.md) | Deal Score — six factors, math, weights, rationale |
| [03](./docs/mvp/03-confidence-and-recommendation.md) | Confidence Score and the BOOK NOW / WAIT engine |
| [04](./docs/mvp/04-explanation-engine.md) | Explanation bundle and AI guardrails |
| [05](./docs/mvp/05-database-schema.md) | PostgreSQL schema |
| [06](./docs/mvp/06-api.md) | REST API |
| [07](./docs/mvp/07-testing.md) | Test scenarios and invariants |
| [08](./docs/mvp/08-ui.md) | Customer-facing information |
| [09](./docs/mvp/09-implementation-plan.md) | Milestones and module tree |
| [10](./docs/mvp/10-configuration-registry.md) | Every tunable weight and threshold |

Working notes for contributors: [`CLAUDE.md`](./CLAUDE.md).
