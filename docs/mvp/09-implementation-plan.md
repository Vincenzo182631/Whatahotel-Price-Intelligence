# 09 — Implementation Plan

Covers proposal request 10: phases, and the modules to be created.

## Build status

| Milestone | State |
|---|---|
| M0 · Data source verification | **Blocked** — U1–U18 unanswered ([doc 00](./README.md#unverified-inputs-register)) |
| M1 · Foundation, schema, migrations, CI | ✅ |
| M2 · Ingestion and normalization | **Partial** — pipeline, normalizer and validation built and tested; the production **source adapter is not built** and cannot be until M0 closes |
| M3 · Baselines, rollups, comparables, scheduler | ✅ |
| M4 · Scoring engine | ✅ |
| M5 · Explanation layer | ✅ template path; model path behind `explanation.enabled` |
| M6 · API and widget | ✅ |
| M7 · Calibration | Not started — needs real data |

A synthetic development source (`packages/ingest/src/adapters/synthetic/`) stands in for the real adapter so the rest of the stack could be built and exercised. **Every rate it produces is fabricated**, the seed script refuses to run without `ALLOW_SYNTHETIC_SEED=1`, and none of it may reach a production database.

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) | One language across worker, API and UI; the scoring engine benefits most from a type system |
| Runtime | Node 22 LTS | Available in the environment |
| Database | PostgreSQL 16 | Available; partitioning, percentiles and `pg_trgm` cover every need here without a second datastore |
| API | Node `http` + a small router | See the deviation note below |
| Widget | Framework-free vanilla JS | It mounts inside a third-party page; a framework payload is cost the host pays for no benefit |
| Jobs | `pg-boss` (Postgres-backed) | No extra infrastructure; the volume does not justify a broker |
| Migrations | node-pg-migrate or Drizzle | Plain SQL, reviewable |
| Tests | Vitest + fast-check | fast-check is required for the property invariants in doc 07 §3 |
| Explanation | Claude API, server-side only | Cached, validated, always with a template fallback |

**Deliberately not chosen:** microservices, Kubernetes, a message broker, a time-series database, an ORM with heavy query abstraction. The hard problems in this product are data quality and scoring correctness. Additional infrastructure adds operational surface without addressing either.

> **Deviation from the original plan: Next.js → Node `http`.** The plan named Next.js, chosen for SSR because Phase 5 is an SEO play. The MVP has no SSR requirement, and the surface is nine read-mostly endpoints, so the framework would have been carried for a phase that has not arrived. The service is dependency-light and directly testable instead. When Phase 5 does arrive the route handlers port to Next route handlers largely unchanged, and the widget — being framework-free — needs no migration at all. **This is a reversible decision; flagging it rather than quietly substituting.**

---

## 2. Module layout

```
whatahotel-price-intelligence/
├─ docs/mvp/                          # this specification
├─ db/
│  ├─ migrations/                     # numbered SQL migrations (doc 05)
│  └─ seeds/                          # benefit catalog, config v1, dev hotels
├─ packages/
│  ├─ core/                           # ── pure domain logic, zero I/O ──
│  │  ├─ src/money.ts                 # minor-unit arithmetic, currency guards
│  │  ├─ src/types.ts                 # shared domain types
│  │  ├─ src/stats.ts                 # percentile, median, CV, Theil–Sen
│  │  ├─ src/normalize/
│  │  │  ├─ roomType.ts               # doc 01 §3 pipeline
│  │  │  ├─ abbreviations.ts          # curated dictionary
│  │  │  ├─ attributes.ts             # class / bed / view extraction
│  │  │  └─ ratePlan.ts               # comparability class, doc 01 §4
│  │  ├─ src/baseline/
│  │  │  ├─ ladder.ts                 # widening ladder L0–L4
│  │  │  └─ distribution.ts           # trimming, percentile rank
│  │  ├─ src/scoring/
│  │  │  ├─ f1Historical.ts  f2Market.ts  f3Trend.ts
│  │  │  ├─ f4Seasonality.ts f5Demand.ts  f6Value.ts
│  │  │  ├─ dealScore.ts              # composition + weight redistribution
│  │  │  └─ bands.ts
│  │  ├─ src/confidence/
│  │  │  ├─ factors.ts                # the seven f_* factors
│  │  │  └─ confidence.ts             # weighted geometric mean
│  │  ├─ src/recommendation/
│  │  │  ├─ guards.ts                 # W1–W8 never-WAIT guards
│  │  │  └─ engine.ts                 # G0–G5, boundary assertion for P1
│  │  ├─ src/explanation/
│  │  │  ├─ bundle.ts                 # ExplanationBundle assembly
│  │  │  ├─ reasonCodes.ts
│  │  │  └─ template.ts               # deterministic fallback renderer
│  │  └─ src/config/
│  │     ├─ schema.ts                 # validation, incl. the wait-confidence floor
│  │     └─ defaults.ts               # doc 10 values
│  │
│  ├─ data/                           # ── persistence, the only SQL ──
│  │  ├─ src/client.ts
│  │  └─ src/repositories/            # hotel, roomType, ratePlan, observation,
│  │                                  # baseline, comparable, benefit, analysis, config
│  │
│  └─ ingest/                         # ── collection ──
│     ├─ src/adapters/
│     │  ├─ RateSourceAdapter.ts       # the interface every source implements
│     │  ├─ synthetic/                 # DEV ONLY — fabricated, not real rates
│     │  └─ whatahotel/                # NOT BUILT — blocked on U1–U11
│     ├─ src/pipeline/                 # validate → normalize → classify → persist
│     ├─ src/rollup/baseline.ts        # rate_baseline refresh, all ladder levels
│     ├─ src/comparables/builder.ts    # comp-set construction (U12)
│     └─ src/scheduler/                # HOT/WARM/COLD tiering
│
├─ apps/
│  ├─ api/                            # Node http server (doc 06)
│  │  ├─ src/http.ts                  # router, error envelope, validation
│  │  ├─ src/routes/priceIntelligence.ts
│  │  └─ src/routes/supporting.ts
│  └─ web/public/                     # widget + demo harness (doc 08)
│     ├─ widget.js                    # framework-free, embeddable
│     ├─ widget.css                   # style tokens the host can override
│     └─ index.html                   # development harness only
│
├─ scripts/                           # migrate · seed-dev · smoke-api · emit-config-seed
│
└─ tests/
   ├─ fixtures/scenarios.ts           # S1–S9 + S8b (doc 07)
   ├─ properties/                     # P1–P12
   ├─ unit/                           # money, stats, normalize, ladder, edges
   └─ integration/                    # ingest → rollup → score, against Postgres
```

**The load-bearing boundary is `packages/core`.** It has no database, network, clock or filesystem access — its dependencies are its arguments. That is what makes the scoring engine exhaustively testable, makes scores reproducible from stored inputs, and makes the deterministic-engine principle structural rather than aspirational.

---

## 3. Milestones

Each produces something verifiable. Nothing here begins until U1–U18 are answered (doc 00) — **M0 is the gate.**

### M0 · Data source verification — *blocking*
**No code.** Walk U1–U18 with real sample payloads and the team that owns the rate API. Produce: a field-mapping document, five real payload samples committed as test fixtures, confirmed history depth (U3), and confirmed rights to store and display (U16).

**Exit:** every U-item is answered, and any answer that contradicts this spec has been reconciled. Several would change the design — this is why it is a gate rather than a parallel track.

### M1 · Foundation
Repo scaffolding, TypeScript strict config, lint/format, CI (typecheck + test + migration check), Docker Compose for Postgres, `CLAUDE.md`, schema migrations from doc 05, seed data, config v1 from doc 10.
**Exit:** schema applies cleanly from empty; CI green.

### M2 · Ingestion and normalization
Adapter interface + first source adapter; validation with reject logging; room-type normalization pipeline; rate-plan classification; idempotent persistence; batch tracking.
**Exit:** a real batch ingests end to end; re-running it inserts zero rows; normalization accuracy measured against a hand-labelled sample of ≥ 200 room names, with the fuzzy-match share reported. **This is the milestone most likely to reveal that the spec needs revising** — normalization quality against real data is the assumption with the widest error bars.

### M3 · Baselines and rollups
Widening ladder; distribution statistics with outlier trimming; `rate_baseline` refresh job; comp-set builder; collection scheduler with HOT/WARM/COLD tiers.
**Exit:** baselines computed for the MVP hotel set; rollup percentiles match direct computation over raw facts; ladder levels distribute sensibly rather than every query landing at L4.

### M4 · Scoring engine — *the core deliverable*
F1–F6; weight redistribution; confidence factors; geometric composition; guards W1–W8; gates G0–G5; boundary assertion.
**Exit:** all nine scenarios (S1–S9) pass; all twelve invariants (P1–P12) pass; 100% branch coverage on `core/scoring`, `core/confidence`, `core/recommendation`. **P1, P3 and P11 are release blockers.**

### M5 · Explanation layer
Bundle assembly; reason-code catalog; **template renderer first**; then the model path behind `explanation.enabled`; validators V1–V6; cache.
**Exit:** every bundle shape renders correctly from templates alone with the model disabled; with it enabled, validation failure rate measured on a sample of ≥ 200 bundles.

### M6 · API and UI
Endpoints from doc 06; caching and rate limiting; widget components from doc 08; all six required states; accessible chart with table fallback.
**Exit:** p95 < 200 ms warm; every state renders correctly against seeded data; `INSUFFICIENT_DATA` shows no number anywhere.

### M7 · Calibration and pre-launch
Run the calibration runbook (doc 02 §4) against real data; produce config v2 with evidence; verify against the doc 10 §10 targets; observability dashboards; runbooks for stale ingest and source outage.
**Exit:** `insufficient_data_rate` below target on the MVP hotel set; score distribution sane; weights adjusted with documented rationale. **The defaults in doc 10 must not survive to launch unexamined.**

---

## 4. Sequencing notes

**Start collecting during M0.** If U3 shows thin history, every day before collection starts is a day of baseline the product will not have at launch (assessment risk R2). A minimal capture-and-store loop can run against the confirmed source while M1–M2 proceed properly — the data is valuable even if the first schema iteration is later rewritten.

**M4 can begin before M2 and M3 finish.** The scoring engine consumes fixtures, not the database. Building it against hand-written fixtures from doc 07 is the fastest route to validating the methodology, and it decouples the highest-value work from the most uncertain.

**M2 is the schedule risk.** Room-type normalization against real data is where estimates most often prove wrong. Measuring it early (the ≥200-name labelled sample) converts an unknown into a number before it can distort the plan.

---

## 5. What is deliberately not built

Alerts, calendar, full effective-value comparison surface, event impact as a first-class feature, forecasting, advisor dashboard, SEO pages. All are Phase 2+ per the proposal. The schema (doc 05) reserves shape where cheap — `price_alert`, `destination_event`, benefit tables — so later phases extend rather than migrate.

**Forecasting is excluded on principle, not only on scope.** MVP describes observed history. It does not predict, the UI does not imply prediction, and the explanation validator actively rejects predictive language (doc 04, V3). Adding forecasting is a Phase 3 decision that should be made deliberately, with its own accuracy bar.
