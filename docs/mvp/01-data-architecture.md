# 01 — Data Architecture

Covers proposal request 1: what to capture, normalized models, timestamping, room-type and rate-plan normalization.

---

## 1. What we need to capture

The product answers "is this rate good?" That question decomposes into four data needs, and everything we capture serves one of them.

| Need         | Question it answers                              | Data required                                             |
| ------------ | ------------------------------------------------ | --------------------------------------------------------- |
| **Identity** | _What exactly is being priced?_                  | Hotel, room type, rate plan, occupancy, stay dates        |
| **Price**    | _What does it cost, right now and historically?_ | Amount, currency, tax basis, capture time                 |
| **Context**  | _Compared to what?_                              | Comparable hotels, season, day-of-week, lead time, events |
| **Value**    | _What else is included?_                         | Benefits attached to the rate or hotel                    |

The non-obvious requirement is the fourth column of the Price row. **A rate without a capture timestamp is worthless to this product** — it can be displayed but never compared. Timestamping is treated as a first-class concern in §5.

### Capture inventory

**Per hotel** (slow-changing): stable ID (U1), name, brand, chain, destination, coordinates, star/luxury tier, currency, timezone, active flag.

**Per room type** (slow-changing, per hotel): canonical name, room class (room/suite/villa), bed configuration, view, max occupancy, size, source identifiers (U9).

**Per rate plan** (slow-changing, per hotel): meal plan, refundability, prepayment, audience (public/member/consortia), source code (U8), attached benefits (U10).

**Per rate observation** (high-volume fact): the tuple above + check-in, nights, occupancy, amount, currency, tax basis, availability signal, source, capture timestamp, match quality.

**Per benefit**: type, description, monetary value or valuation rule, per-stay vs per-night basis.

**Contextual**: comparable-hotel sets (U12), destination events (U14), seasonal calendars.

---

## 2. Core entity model

```
                    ┌───────────┐
                    │  source   │  where a rate came from
                    └─────┬─────┘
                          │
   ┌──────────┐     ┌─────▼──────────────────┐     ┌────────────┐
   │  hotel   │◄────┤   rate_observation     ├────►│ rate_plan  │
   │  (U1)    │     │   (partitioned fact)   │     │  (U5,U8)   │
   └────┬─────┘     └─────┬──────────────────┘     └─────┬──────┘
        │                 │                              │
        │           ┌─────▼──────┐              ┌────────▼────────┐
        ├──────────►│ room_type  │              │ rate_plan_      │
        │           │            │              │   benefit       │
        │           └─────┬──────┘              └────────┬────────┘
        │                 │                              │
        │           ┌─────▼───────────┐            ┌─────▼─────┐
        │           │ room_type_alias │            │  benefit  │
        │           │  (raw → canon)  │            │   (U10)   │
        │           └─────────────────┘            └───────────┘
        │
        ├──────────►┌──────────────────┐   hotel ↔ hotel, ranked
        │           │ hotel_comparable │   (U12)
        │           └──────────────────┘
        │
        └──────────►┌──────────────────┐
                    │ rate_baseline    │  materialized distribution rollup
                    └──────────────────┘

   ┌─────────────┐        ┌──────────────────┐
   │ destination │───────►│ destination_event│  (U14, optional in MVP)
   └─────────────┘        └──────────────────┘

   ┌────────────────┐   ┌──────────────┐   ┌───────────────────┐
   │ scoring_config │──►│   analysis   │──►│ analysis_factor   │
   │  (versioned)   │   │  (computed)  │   │  (breakdown)      │
   └────────────────┘   └──────────────┘   └───────────────────┘
```

Full DDL in [doc 05](./05-database-schema.md).

### Why `rate_observation` is a separate fact table

It is the only high-volume table and the only append-only one. Everything else is reference data measured in thousands of rows; this table is measured in tens of millions. Separating it lets us partition, compress and roll it up independently, and lets the scoring engine read from cheap pre-aggregated `rate_baseline` rows instead of scanning raw facts on every page view.

---

## 3. Room-type normalization

**The problem.** The same physical room reaches us as `"Ocean View King"`, `"OCEANVIEW KING BED"`, `"Deluxe King - Ocean View"`, `"OVK"`. If these are treated as four room types, every baseline is built on a quarter of the data and every average is wrong. If they are wrongly merged with `"Ocean View King Suite"`, the baseline mixes two price tiers and the Deal Score is nonsense in the other direction.

This is the highest-risk data problem in the project (R3 in the assessment). It is solved with a **deterministic, auditable pipeline that always reports its own confidence** — never a silent best guess.

### Pipeline

Raw room string/code → canonical `room_type`, with a `match_method` and `match_confidence ∈ [0,1]`.

| Step | Method                                                                                    | Confidence                      | Notes                                                                     |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| 1    | `SOURCE_ID` — source provides a stable structured room code (U9)                          | 1.00                            | Preferred path. Direct lookup in `room_type.source_code`.                 |
| 2    | `ALIAS_EXACT` — normalized string matches a known alias                                   | 0.95                            | Alias table grows over time; this becomes the common path.                |
| 3    | `ALIAS_FUZZY` — trigram similarity ≥ threshold against known aliases _for the same hotel_ | 0.60–0.90, scaled by similarity | `pg_trgm`. Never fuzzy-match across hotels.                               |
| 4    | `ATTRIBUTE_INFERRED` — parse attributes, match on the attribute vector                    | 0.50                            | Last resort.                                                              |
| 5    | `UNMATCHED`                                                                               | 0.00                            | Row is stored but **excluded from all scoring**. Queued for human review. |

**Normalization before matching** (deterministic, order-fixed): lowercase → strip punctuation/extra whitespace → expand a curated abbreviation dictionary (`ovk`→`ocean view king`, `dbl`→`double`, `ste`→`suite`, `w/`→`with`) → remove marketing filler (`luxury`, `signature`, `our`) → sort nothing (word order is meaningful).

**Attribute extraction** (parsed into structured columns, used by steps 3–5 and by UI):

| Attribute      | Values                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `room_class`   | ROOM, JUNIOR_SUITE, SUITE, VILLA, RESIDENCE, PENTHOUSE, UNKNOWN                                              |
| `bed_config`   | KING, QUEEN, DOUBLE, TWIN, SINGLE, MULTIPLE, UNKNOWN                                                         |
| `view`         | OCEAN, PARTIAL_OCEAN, CITY, GARDEN, POOL, MOUNTAIN, INTERIOR, UNKNOWN                                        |
| `tier_ordinal` | integer rank within the hotel (standard=0, deluxe=1, premium=2…) derived from price ordering, not from words |

**Hard rule.** `room_class` mismatch blocks a match outright. A ROOM never merges with a SUITE regardless of string similarity — that is the failure mode that most damages the score, and it is cheap to prevent.

**Confidence propagates.** `match_confidence` is stored on every observation and feeds the Confidence Score's `f_match` factor (doc 03 §2.6). Poor matching does not silently corrupt the Deal Score — it visibly lowers confidence, and below `MATCH_MIN` it forces `INSUFFICIENT_DATA`.

**Alias learning.** Every resolved fuzzy or inferred match writes a candidate row to `room_type_alias` with `is_confirmed = false`. An operator confirms in bulk; confirmed aliases upgrade future matches to `ALIAS_EXACT`. Matching quality improves monotonically without model retraining.

---

## 4. Rate-plan normalization and comparability

**The problem.** A $689 non-refundable, prepaid, room-only rate and a $689 flexible rate with breakfast are not the same product. Comparing them produces false signals in both directions — and this is invisible in the data unless modelled explicitly.

### Rate plan dimensions

| Dimension       | Values                                                               | Source (U5) |
| --------------- | -------------------------------------------------------------------- | ----------- |
| `meal_plan`     | ROOM_ONLY, BREAKFAST, HALF_BOARD, FULL_BOARD, ALL_INCLUSIVE, UNKNOWN |             |
| `refund_policy` | REFUNDABLE, PARTIALLY_REFUNDABLE, NON_REFUNDABLE, UNKNOWN            |             |
| `is_prepaid`    | boolean                                                              |             |
| `audience`      | PUBLIC, MEMBER, CONSORTIA, NEGOTIATED, OPAQUE, UNKNOWN               |             |

### Comparability class

Observations are only ever compared within the same **comparability class** — a derived, stored key:

```
comparability_class = (meal_plan_group, refund_group, audience_group)

meal_plan_group : ROOM_ONLY | BREAKFAST_INCLUDED | BOARD_INCLUDED
                  (HALF/FULL/ALL_INCLUSIVE collapse to BOARD_INCLUDED)
refund_group    : FLEXIBLE (REFUNDABLE)
                  | RESTRICTED (PARTIALLY_REFUNDABLE, NON_REFUNDABLE)
audience_group   : PUBLIC (PUBLIC, MEMBER)
                  | PRIVATE (CONSORTIA, NEGOTIATED)
```

This yields 3 × 2 × 2 = 12 classes. Coarse on purpose: finer classes fragment the baseline and starve every distribution of observations. Refine only if calibration shows within-class price dispersion is materially wider than across-class dispersion.

**`UNKNOWN` on any dimension** → class is `UNRESOLVED`. Such observations are stored, displayed if they are the current rate, but **excluded from baseline distributions**, and their presence lowers confidence.

**Query resolution.** A customer query resolves to one comparability class (the class of the rate being shown). All baselines, percentiles and comp-set comparisons for that analysis are computed within that class only.

---

## 5. Timestamping and storage of observations

### Two independent time dimensions

Getting this wrong invalidates every metric, so it is stated explicitly:

| Dimension            | Column                            | Meaning                      |
| -------------------- | --------------------------------- | ---------------------------- |
| **Observation time** | `observed_at` (timestamptz, UTC)  | When _we captured_ the price |
| **Stay time**        | `check_in` (date), `nights` (int) | When _the guest stays_       |

Derived and stored at ingest (not computed at query time):

| Column                 | Definition                                                     | Purpose                                                                                         |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `observed_date`        | `observed_at` in UTC, date part                                | Partition-friendly grouping; avoids non-immutable casts in generated columns                    |
| `observation_slot`     | `observed_at` truncated to `CAPTURE_SLOT_MINUTES` (default 60) | Deduplication key — at most one observation per tuple per slot per source                       |
| `lead_time_days`       | `check_in - observed_date`                                     | **Critical.** A rate 120 days out is a different economic object from the same hotel 3 days out |
| `check_out`            | `check_in + nights`                                            | Convenience                                                                                     |
| `stay_dow_bucket`      | WEEKDAY / WEEKEND from `check_in`                              | Baseline stratification                                                                         |
| `stay_season_band`     | LOW / SHOULDER / HIGH / PEAK / UNKNOWN                         | Baseline stratification                                                                         |
| `nightly_amount_minor` | `round(total_amount_minor / nights)`                           | Display and comparison unit                                                                     |

`lead_time_days` may be negative only for erroneous data; ingest rejects `check_in < observed_date - 1`.

### Money representation

- `total_amount_minor BIGINT` — integer minor units (cents). **Never float.** Floating-point cents produce off-by-one percentages that make a Deal Score irreproducible.
- `currency CHAR(3)` — ISO 4217, required on every monetary column.
- `tax_basis` — `NET` (excl. taxes/fees), `GROSS` (incl.), `UNKNOWN` (U7). **Only compare within the same `tax_basis`.** Mixing net and gross is a ~15% phantom discount and is the most likely source of a spectacularly wrong Deal Score.
- If both net and gross are available, store both (`total_amount_minor`, `total_gross_amount_minor`) and score on gross, since that is what the traveler pays.

### Immutability and dedup

`rate_observation` is **append-only**. Prices are not corrected in place — a superseding capture is a new row. This preserves the audit trail needed to reconstruct any score shown to a customer.

Dedup is by unique index on:

```
(source_id, hotel_id, room_type_id, rate_plan_id, check_in, nights,
 adults, children, currency, observation_slot)
```

A repeat capture within the same slot is an idempotent no-op (`ON CONFLICT DO NOTHING`), so collection retries are safe.

### Partitioning and retention

- Range-partitioned on `observed_at`, **monthly**. Partition key participates in the primary key (`id, observed_at`).
- Partitions older than `RAW_RETENTION_MONTHS` (default 18) are detached and archived; `rate_baseline` rollups retain the statistics indefinitely at a fraction of the size.
- Monthly partitions created ahead of time by a scheduled job; a default partition catches surprises and alarms rather than erroring ingest.

### Collection cadence (subject to U15)

Not all stays deserve equal attention. Proposed priority tiers, all configurable:

| Tier | Criteria                                                | Cadence      |
| ---- | ------------------------------------------------------- | ------------ |
| HOT  | Stay viewed/analyzed in last 7 days, or lead time ≤ 30d | Every 6h     |
| WARM | Hotel in MVP set, lead time 31–120d                     | Daily        |
| COLD | Baseline fill for unviewed dates                        | Every 3 days |

Rationale: trend detection needs ≥ 4 points in a 7-day window (doc 02, F3), which a daily cadence satisfies; 6-hourly on HOT gives freshness for near-term decisions where the customer acts fastest.

---

## 6. Baseline construction

This is the heart of the scoring engine. The proposal says "90-day average" — that phrase is ambiguous between two genuinely different things, and the MVP needs both.

### Two baselines

**A. Same-stay series `S(Q)`** — _how has the price of this exact stay moved?_

All observations matching `(hotel, room_type, comparability_class, check_in, nights, adults, children)`, ordered by `observed_at`, within the last `TREND_WINDOW_DAYS`.

Powers: the price history chart, "price rose 9% in 7 days", factor F3 (Trend).

**B. Historical distribution `H(Q)`** — _what does this room normally cost?_

Observations for `(hotel, room_type, comparability_class)` across _many different stays_, filtered to comparable conditions, within `LOOKBACK_DAYS` (default 90) of observation time.

Powers: percentile, average, min, max, factors F1, F2, F4; the "$748 90-day average / $621 low / $925 high" panel from the proposal.

These are not interchangeable. A stay observed once has no series but may have a rich distribution; a newly listed hotel has the reverse.

### The widening ladder

`H(Q)` filtered exactly will often be too sparse. Rather than silently loosening filters, the engine walks a **fixed ladder** and records which level it reached. Each level carries a confidence multiplier.

| Level  | Filters applied                                                     | Confidence multiplier | Meaning                                                     |
| ------ | ------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| **L0** | season band + DOW bucket + lead-time bucket                         | 1.00                  | Ideal: like-for-like                                        |
| **L1** | season band + DOW bucket                                            | 0.95                  | Lead time relaxed                                           |
| **L2** | season band                                                         | 0.88                  | Day-of-week relaxed                                         |
| **L3** | none (full lookback window)                                         | 0.80                  | Season relaxed — a summer rate may sit in a winter baseline |
| **L4** | sibling room types of same `room_class` and adjacent `tier_ordinal` | 0.60                  | Borrowing from other rooms; flagged in UI                   |
| —      | still below `MIN_OBS_ABS`                                           | —                     | → `INSUFFICIENT_DATA`                                       |

The engine climbs only as far as needed to reach `MIN_OBS_TARGET` (default 30) observations, and never past L4. `baseline_level` is persisted on the analysis and shown as a caveat when ≥ L3.

**Lead-time buckets** (configurable): 0–3, 4–7, 8–14, 15–30, 31–60, 61–120, 121+ days. Buckets rather than a continuous adjustment because the relationship between lead time and price is non-monotonic and hotel-specific; bucketing is honest about what we can support at MVP.

### Robust statistics

All distribution statistics use **median and percentiles, not mean and standard deviation**:

- Hotel rates are right-skewed with fat tails (peak events, error fares, closeout rates). A single $3,000 New Year's Eve observation moves a mean materially and a median barely.
- The proposal's UI shows "90-day average" — we will display the **median** and label it _typical rate_, which is both more accurate and more honest. (Flagging this as a deliberate deviation from the proposal's wording; the displayed figure is more robust, not less.)
- Percentile rank via empirical CDF with mid-rank tie handling.
- Outlier guard: observations outside `[p1, p99]` of the class distribution are retained in storage but excluded from statistics, and counted in a `outliers_excluded` field that feeds the volatility signal.

### Materialization

`rate_baseline` stores one row **per ladder level**, keyed by
`(hotel, room_type, comparability_class, baseline_level, [season_band], [dow_bucket], [lead_bucket])`, holding
`n_observations, p10, p25, p50, p75, p90, min, max, mean, stddev, cv, n_sources, mean_match_conf, cross_source_cv, unresolved_share, computed_at, window_start, window_end`.

> **Refined during implementation.** The original draft stored only the finest stratification and left the ladder to widen at query time. That does not work: merging percentile summaries across strata is not statistically sound, and recomputing from raw facts per request would put the fact table on the hot path — exactly what materialization exists to avoid. The rollup therefore computes every level directly from observations, and the read path selects the most specific row that clears `MIN_OBS_TARGET`. Stratum columns are NULL at the levels that do not use them, which is why the unique index is declared `NULLS NOT DISTINCT`.

Refreshed on a schedule (default hourly for HOT hotels, daily otherwise). **The API never scans raw observations on a page view** — it reads one baseline row plus the current rate. This keeps p95 response time flat as the fact table grows (risk R7 from the assessment).

---

## 7. Ingestion pipeline

```
  source adapter  →  validate  →  normalize  →  classify  →  persist  →  rollup
   (per source)      (reject      (room type   (comparab-   (append-    (refresh
                      bad rows)    + rate plan) ility class)  only)      baseline)
```

**Source adapter** — one module per data source behind a single interface, returning a `RawRateRecord[]`. The proposal (§9) requires multi-source support; the adapter boundary is what makes a source swappable without touching the engine.

**Validate** — reject rather than coerce: missing hotel/room/dates, non-positive amount, missing currency, `check_in` in the past, `nights` outside 1–30, amount outside a per-hotel sanity band. Rejects go to `ingest_reject` with the raw payload and a reason code, and are alerted on when the reject rate exceeds a threshold. A silently-coerced bad row is worse than a missing one.

**Persist raw payload** — every observation stores the original source JSON in a `raw` column. When a score looks wrong six months later, this is the only thing that can settle what the source actually said.

**Batch tracking** — every ingest run writes an `ingest_batch` row (source, started/finished, counts of inserted/duplicate/rejected). Freshness monitoring and the Confidence Score's `f_freshness` read from this.
