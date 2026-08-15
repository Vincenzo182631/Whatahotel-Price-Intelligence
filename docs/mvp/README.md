# WhataHotel Price Intelligence — MVP Technical Specification

**Status:** DRAFT — awaiting approval. No production code has been written.
**Source proposal:** _WhataHotel Price Intelligence Proposal v2_ (Aug 2026), prepared for Greg Guiteras, Lorraine Travel.
**Scope:** Phase 1 (MVP) only — search, current rate, historical metrics, Deal Score, price chart, BOOK NOW / WAIT recommendation.

---

## Documents

| #   | Document                                                                       | Covers                                                             |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 00  | This file                                                                      | Scope, principles, unverified inputs register, open decisions      |
| 01  | [`01-data-architecture.md`](./01-data-architecture.md)                         | Entities, normalization, timestamping, baselines                   |
| 02  | [`02-deal-score.md`](./02-deal-score.md)                                       | Deal Score v1 — six factors, math, weights, rationale              |
| 03  | [`03-confidence-and-recommendation.md`](./03-confidence-and-recommendation.md) | Confidence Score + BOOK_NOW/WAIT/CONSIDER/INSUFFICIENT_DATA engine |
| 04  | [`04-explanation-engine.md`](./04-explanation-engine.md)                       | Explanation bundle contract, AI guardrails                         |
| 05  | [`05-database-schema.md`](./05-database-schema.md)                             | Proposed PostgreSQL 16 schema (DDL, not a migration)               |
| 06  | [`06-api.md`](./06-api.md)                                                     | MVP REST endpoints and payloads                                    |
| 07  | [`07-testing.md`](./07-testing.md)                                             | Nine required scenarios + invariants                               |
| 08  | [`08-ui.md`](./08-ui.md)                                                       | Exact customer-facing information                                  |
| 09  | [`09-implementation-plan.md`](./09-implementation-plan.md)                     | Milestones and module tree                                         |
| 10  | [`10-configuration-registry.md`](./10-configuration-registry.md)               | Every tunable weight and threshold in one place                    |
| 11  | [`11-calibration-tooling.md`](./11-calibration-tooling.md)                     | M7 — replay harness, metrics, weight sweep                         |

---

## Design principles

These are load-bearing. Every design decision downstream follows from them.

1. **The engine is deterministic. The AI only narrates.** Deal Score, Confidence and the recommendation are produced by pure functions over stored data. The language model receives already-computed facts and turns them into a sentence. It never sees raw rates, never computes, never overrides. (Proposal §8.)
2. **No number is arbitrary.** Every weight and threshold in this spec is a _starting prior_ with a stated rationale, lives in a versioned config record, and is calibratable without a code change. See doc 10.
3. **Compare like with like.** A non-refundable room-only rate is not comparable to a flexible bed-and-breakfast rate, and a rate observed 90 days out is not comparable to one observed 3 days out. Comparability is enforced structurally, not by convention. See doc 01 §4.
4. **Confidence gates action.** Low confidence must degrade the recommendation, not the score's appearance of precision. **WAIT is never emitted below the confidence floor** — this is enforced at the engine boundary _and_ asserted as a property test.
5. **Every displayed number is traceable.** Each analysis persists its inputs, config version, and factor breakdown, so any score shown to a customer can be reconstructed and explained months later.
6. **Money is integer minor units.** Never floating point. Currency is explicit on every monetary value.

---

## Unverified inputs register

Written before the source API was available. **Most of it is now answered** —
the WhataHotel data API (`/data/api.cfm`) was supplied, the adapter was built
against captured responses, and it has been run against production. Answers are
recorded in the status column below; the evidence is in
`tests/fixtures/whatahotel/` and the reasoning in
`packages/ingest/src/adapters/whatahotel/`.

Items are referenced throughout the other documents by ID.

### Answered against the live API

| ID      | Answer                                                                           | Consequence                                                                                                                                                                                                  |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **U1**  | ✅ Yes — integer `hotel.id`, stable                                              | Primary key confirmed.                                                                                                                                                                                       |
| **U2**  | ✅ Yes — verified 7 months out                                                   | Proactive collection works.                                                                                                                                                                                  |
| **U3**  | ❌ **NO history.** Live quotes only.                                             | **The consequential one.** The 90-day baseline can only be built forward from the first capture. D3's cold-start branch is the real path, not the contingency.                                               |
| **U4**  | ✅ Yes — one record per `bookCode`                                               | Per-room scoring works.                                                                                                                                                                                      |
| **U5**  | ⚠️ Partial — stated for some offers ("Prepay Non-refundable"), absent for most   | Semantic comparability classes cannot be built for every rate. Handled by `comparabilityClassOverride`: the class is keyed on the source's own rate code **and offer**, so like is still compared with like. |
| **U6**  | ⚠️ Partial — a single `guests` total, no adults/children split                   | Occupancy is captured as a total; child pricing is not modelled.                                                                                                                                             |
| **U7**  | ✅ Yes — `rateDaily` is NET per night, `rateTotal` is GROSS per stay             | Verified by probing 1-night against 3-night stays (factor 1.2545, constant). Guessing would have understated every price by ~25%.                                                                            |
| **U8**  | ⚠️ Yes but insufficient — `rateCode` is stable, but is **not** the plan identity | One rate code carries several priced offers. Identity is `rateCode` + offer slug; see `sourcePlanCodeFor`.                                                                                                   |
| **U9**  | ✅ Yes — `bookCode` per room, stable across captures                             | The SOURCE_ID matching path. Room-type discovery keys on it.                                                                                                                                                 |
| **U10** | ✅ Yes — hotel `perks`                                                           | Factor F6 has real input: 74 benefits across 15 Miami hotels.                                                                                                                                                |
| **U11** | ❌ No — no availability count                                                    | Scarcity guard W-series stays inert rather than acting on an invented number. Sold-out is signalled by status `204`.                                                                                         |
| **U17** | ✅ USD throughout the sampled data                                               | No FX normalization needed yet; `parseMoney` still records the currency per rate.                                                                                                                            |

### Still open

| ID      | Assumption                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U12** | Comparable-hotel relationships — partially derivable now (destination + price band); star/brand tier is not in the payload, so comp sets are thin (6 pairs across 15 hotels). |
| **U13** | Booking/transaction data joinable to hotels.                                                                                                                                  |
| **U14** | Events/demand feed.                                                                                                                                                           |
| **U15** | Rate limits and cost per call. Measured latency is ~2.2–2.6s per `rates` call; the collector's concurrency limiter is what sets throughput. No documented quota.              |
| **U16** | **Contractual permission to store rate observations long-term and display comparative history.** Unchanged and still blocking for launch, not for build.                      |
| **U18** | Deployment target and widget embedding.                                                                                                                                       |

### Original register

Retained for the reasoning behind each item.

### Blocking — design changes if the answer is no

| ID     | Assumption                                                                                                                      | Why it matters                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **U1** | A stable, permanent hotel identifier exists (your skills indicate a numeric `hotelID` in WhataHotel URLs).                      | Primary key for every join. If IDs are reused or unstable, history silently corrupts.                                      |
| **U2** | Rate data can be retrieved for **arbitrary future stay dates**, not only dates a user is actively searching.                    | Without this there is no proactive collection, no price calendar, and no baseline for unsearched dates.                    |
| **U3** | **Historical** rate observations already exist with capture timestamps — or the platform has been logging rates. Depth in days? | Determines whether MVP launches with a real 90-day baseline or must cold-start. This is the single most important unknown. |
| **U4** | Rates are retrievable **per room type**, not just a single "from" price per hotel.                                              | The proposal scores a specific room category ("Ocean View King"). A hotel-level lead price cannot support it.              |
| **U5** | Each rate carries **cancellation policy and meal plan** (or fields from which they derive).                                     | Required for comparability classes (principle 3). Without it, scores compare incompatible products.                        |
| **U6** | Rates can be retrieved for a **specified occupancy** (adults/children).                                                         | Occupancy changes price materially; mixing occupancies corrupts baselines.                                                 |

### Important — affects factor availability

| ID      | Assumption                                                                                                      | Consequence if absent                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **U7**  | Total stay amount **and** per-night breakdown are available, with tax/fee inclusivity stated.                   | Ambiguous tax handling produces false discounts. Fallback: derive nightly = total/nights, flag as derived.                             |
| **U8**  | Rate plan identifiers are **stable across captures**.                                                           | Unstable codes break same-stay series and trend detection.                                                                             |
| **U9**  | Room type names/codes are available as **structured fields**, not only display strings.                         | Determines whether normalization is deterministic (U9 true) or fuzzy-matched (U9 false → lower confidence, doc 01 §3).                 |
| **U10** | **Benefits** (breakfast, hotel credit, upgrade, late checkout) are available in structured form per rate/hotel. | Factor F6 (Effective Value) — the proposal's stated differentiator. If unstructured, MVP uses a manually curated table for top hotels. |
| **U11** | **Availability signal** (rooms remaining / sold-out) is exposed.                                                | Feeds scarcity guard on WAIT and the demand factor. Degrades gracefully if absent.                                                     |
| **U12** | Comparable-hotel relationships can be derived (brand tier, destination, star rating, price band).               | Factor F2 (Market). Absent → F2 unavailable, weight redistributes, confidence drops.                                                   |
| **U13** | Booking/transaction data is queryable and joinable to hotels.                                                   | Optional demand proxy for F5 when no event feed exists.                                                                                |
| **U14** | An events/demand feed exists, or is acquirable.                                                                 | Factor F5. Proposal defers events to Phase 3; MVP treats F5 as optional.                                                               |

### Operational

| ID      | Assumption                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| **U15** | Call volume/rate limits and cost per call for the rate API — determines collection cadence and hotel-set size.   |
| **U16** | Contractual permission to **store rate observations long-term and display comparative history** to consumers.    |
| **U17** | Currency handling: are rates returned in a single currency, or must FX normalization be applied at capture time? |
| **U18** | Deployment target for the service, and how whatahotel.com will embed the widget (platform unknown to me).        |

**Recommended first action:** one working session with whoever owns the rate API, walking U1–U18 with real sample payloads. Every "unknown" answered there removes a contingency branch from the build.

---

## Deliberately out of MVP scope

Per the proposal's phasing — specified here only so the schema does not have to change later:

- Price alerts and email workflow (Phase 2) — schema reserves the shape, no implementation
- Price calendar (Phase 2)
- Effective Stay Value as a _full_ comparison surface (Phase 2) — MVP computes the factor but the side-by-side UI is later
- Event impact as a first-class surface (Phase 3) — MVP wires the factor as optional
- Price forecasting (Phase 3) — **explicitly excluded.** MVP infers trend from observed history; it does not predict future prices
- Advisor dashboard (Phase 4), SEO pages (Phase 5)

---

## Open decisions requiring your input

| #   | Decision                                                                               | Recommendation                                                                     | Impact                                |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| D1  | MVP hotel set size and destinations                                                    | 50–100 hotels, 3–5 destinations                                                    | Collection cost, baseline density     |
| D2  | Should benefits adjust the _baseline_ or only factor F6?                               | F6 only in v1 (doc 02 §F6)                                                         | Consistency of historical comparisons |
| D3  | Launch posture if U3 shows no history                                                  | Hybrid: cross-sectional score at launch, auto-upgrade per hotel as history accrues | Launch date                           |
| D4  | Show raw Deal Score number, or band only, at low confidence?                           | Band only below Moderate confidence (doc 08)                                       | Customer trust                        |
| D5  | Currency scope at MVP                                                                  | USD only                                                                           | FX complexity                         |
| D6  | Is a "WAIT" recommendation acceptable to the business at all, given it defers revenue? | Keep it — it is the product's credibility                                          | Product positioning                   |

---

## How to review this spec

Read 01 → 02 → 03 first; they contain every consequential decision. 05–06 are mechanical consequences of them. If you disagree with a weight or threshold, it lives in doc 10 and is a config change, not a redesign — flag it but it need not block approval.
