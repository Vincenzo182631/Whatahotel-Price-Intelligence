# 05 — Proposed PostgreSQL Schema

Covers proposal request 6. **PostgreSQL 16.**

> This is a *proposed* schema for review, not an applied migration. Nothing here has been executed. Field names and types in the source-facing columns depend on the unverified inputs (U1–U18) and will need adjustment once real payloads are available.

Conventions: `snake_case`; surrogate `BIGINT GENERATED ALWAYS AS IDENTITY` keys; natural keys carry unique constraints; all timestamps `timestamptz` in UTC; **money as `BIGINT` minor units with an explicit currency column, never `float`/`numeric` for amounts**.

---

## 1. Extensions and enums

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy room-name matching
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE meal_plan_t      AS ENUM ('ROOM_ONLY','BREAKFAST','HALF_BOARD','FULL_BOARD','ALL_INCLUSIVE','UNKNOWN');
CREATE TYPE refund_policy_t  AS ENUM ('REFUNDABLE','PARTIALLY_REFUNDABLE','NON_REFUNDABLE','UNKNOWN');
CREATE TYPE rate_audience_t  AS ENUM ('PUBLIC','MEMBER','CONSORTIA','NEGOTIATED','OPAQUE','UNKNOWN');
CREATE TYPE tax_basis_t      AS ENUM ('NET','GROSS','UNKNOWN');
CREATE TYPE room_class_t     AS ENUM ('ROOM','JUNIOR_SUITE','SUITE','VILLA','RESIDENCE','PENTHOUSE','UNKNOWN');
CREATE TYPE bed_config_t     AS ENUM ('KING','QUEEN','DOUBLE','TWIN','SINGLE','MULTIPLE','UNKNOWN');
CREATE TYPE view_t           AS ENUM ('OCEAN','PARTIAL_OCEAN','CITY','GARDEN','POOL','MOUNTAIN','INTERIOR','UNKNOWN');
CREATE TYPE match_method_t   AS ENUM ('SOURCE_ID','ALIAS_EXACT','ALIAS_FUZZY','ATTRIBUTE_INFERRED','UNMATCHED');
CREATE TYPE season_band_t    AS ENUM ('LOW','SHOULDER','HIGH','PEAK','UNKNOWN');
CREATE TYPE dow_bucket_t     AS ENUM ('WEEKDAY','WEEKEND');
CREATE TYPE recommendation_t AS ENUM ('BOOK_NOW','WAIT','CONSIDER','INSUFFICIENT_DATA');
CREATE TYPE score_band_t     AS ENUM ('EXCELLENT','GOOD','FAIR','BELOW_AVERAGE','POOR');
CREATE TYPE conf_band_t      AS ENUM ('HIGH','MODERATE','LOW','INSUFFICIENT');
CREATE TYPE benefit_basis_t  AS ENUM ('PER_NIGHT','PER_STAY');
```

---

## 2. Reference data

```sql
CREATE TABLE source (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            TEXT        NOT NULL UNIQUE,     -- 'WAH_CORE', 'PARTNER_X'
    display_name    TEXT        NOT NULL,
    is_authoritative BOOLEAN    NOT NULL DEFAULT false,
    trust_weight    NUMERIC(3,2) NOT NULL DEFAULT 1.00 CHECK (trust_weight BETWEEN 0 AND 1),
    is_active       BOOLEAN     NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE destination (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug            TEXT        NOT NULL UNIQUE,
    name            TEXT        NOT NULL,
    country_code    CHAR(2),
    timezone        TEXT        NOT NULL DEFAULT 'UTC',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hotel (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wah_hotel_id        TEXT        NOT NULL UNIQUE,   -- U1: WhataHotel's stable ID
    name                TEXT        NOT NULL,
    brand               TEXT,
    chain               TEXT,
    destination_id      BIGINT      REFERENCES destination(id),
    latitude            NUMERIC(9,6),
    longitude           NUMERIC(9,6),
    star_rating         NUMERIC(2,1) CHECK (star_rating BETWEEN 0 AND 5),
    luxury_tier         SMALLINT    CHECK (luxury_tier BETWEEN 1 AND 5),
    base_currency       CHAR(3)     NOT NULL DEFAULT 'USD',
    timezone            TEXT        NOT NULL DEFAULT 'UTC',
    collection_tier     TEXT        NOT NULL DEFAULT 'WARM'
                                    CHECK (collection_tier IN ('HOT','WARM','COLD','OFF')),
    is_active           BOOLEAN     NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hotel_destination_idx ON hotel (destination_id) WHERE is_active;
CREATE INDEX hotel_name_trgm_idx   ON hotel USING gin (name gin_trgm_ops);

-- Cross-source identity mapping; keeps hotel.wah_hotel_id canonical (U1).
CREATE TABLE hotel_external_id (
    hotel_id        BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    source_id       BIGINT      NOT NULL REFERENCES source(id),
    external_id     TEXT        NOT NULL,
    PRIMARY KEY (source_id, external_id)
);
```

### Room types and alias learning

```sql
CREATE TABLE room_type (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id        BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    canonical_name  TEXT        NOT NULL,
    normalized_name TEXT        NOT NULL,          -- output of the normalization pipeline
    room_class      room_class_t NOT NULL DEFAULT 'UNKNOWN',
    bed_config      bed_config_t NOT NULL DEFAULT 'UNKNOWN',
    view_type       view_t       NOT NULL DEFAULT 'UNKNOWN',
    max_occupancy   SMALLINT,
    size_sqm        NUMERIC(6,1),
    tier_ordinal    SMALLINT,                      -- price rank within hotel, derived
    is_active       BOOLEAN     NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, normalized_name)
);
CREATE INDEX room_type_hotel_idx ON room_type (hotel_id) WHERE is_active;

CREATE TABLE room_type_alias (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id        BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    room_type_id    BIGINT      NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
    source_id       BIGINT      REFERENCES source(id),
    raw_value       TEXT        NOT NULL,          -- exactly as received
    normalized_value TEXT       NOT NULL,
    source_room_code TEXT,                         -- U9, when structured
    match_method    match_method_t NOT NULL,
    match_confidence NUMERIC(3,2) NOT NULL CHECK (match_confidence BETWEEN 0 AND 1),
    is_confirmed    BOOLEAN     NOT NULL DEFAULT false,   -- operator review
    times_seen      INTEGER     NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, source_id, normalized_value)
);
CREATE INDEX rta_norm_trgm_idx  ON room_type_alias USING gin (normalized_value gin_trgm_ops);
CREATE INDEX rta_review_idx     ON room_type_alias (hotel_id) WHERE NOT is_confirmed;
```

### Rate plans and comparability

```sql
CREATE TABLE rate_plan (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id            BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    source_id           BIGINT      NOT NULL REFERENCES source(id),
    source_plan_code    TEXT,                                   -- U8
    display_name        TEXT,
    meal_plan           meal_plan_t     NOT NULL DEFAULT 'UNKNOWN',
    refund_policy       refund_policy_t NOT NULL DEFAULT 'UNKNOWN',
    is_prepaid          BOOLEAN,
    audience            rate_audience_t NOT NULL DEFAULT 'UNKNOWN',

    -- Derived comparability key (doc 01 §4). Written by the classifier at ingest,
    -- not a generated column, so the classification rules can evolve independently
    -- of the enum values without a table rewrite.
    comparability_class TEXT        NOT NULL DEFAULT 'UNRESOLVED',

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, source_id, source_plan_code)
);
CREATE INDEX rate_plan_class_idx ON rate_plan (hotel_id, comparability_class);
```

---

## 3. The fact table

```sql
CREATE TABLE rate_observation (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY,
    observed_at             TIMESTAMPTZ NOT NULL,

    -- identity
    source_id               BIGINT      NOT NULL REFERENCES source(id),
    hotel_id                BIGINT      NOT NULL REFERENCES hotel(id),
    room_type_id            BIGINT      REFERENCES room_type(id),   -- NULL only when UNMATCHED
    rate_plan_id            BIGINT      REFERENCES rate_plan(id),

    -- stay
    check_in                DATE        NOT NULL,
    nights                  SMALLINT    NOT NULL CHECK (nights BETWEEN 1 AND 30),
    check_out               DATE        NOT NULL,
    adults                  SMALLINT    NOT NULL DEFAULT 2 CHECK (adults BETWEEN 1 AND 10),
    children                SMALLINT    NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 10),

    -- price (minor units; never float)
    currency                CHAR(3)     NOT NULL,
    total_amount_minor      BIGINT      NOT NULL CHECK (total_amount_minor > 0),
    total_gross_amount_minor BIGINT     CHECK (total_gross_amount_minor > 0),   -- U7
    taxes_fees_minor        BIGINT,
    tax_basis               tax_basis_t NOT NULL DEFAULT 'UNKNOWN',
    nightly_amount_minor    BIGINT
        GENERATED ALWAYS AS (round(total_amount_minor::numeric / nights)::bigint) STORED,

    -- time derivations. Written at ingest rather than generated: timestamptz→date
    -- conversion is STABLE, not IMMUTABLE, so Postgres rejects it in a generated column.
    observed_date           DATE        NOT NULL,
    observation_slot        TIMESTAMPTZ NOT NULL,          -- observed_at truncated to slot
    lead_time_days          INTEGER
        GENERATED ALWAYS AS ((check_in - observed_date)) STORED,
    stay_dow_bucket         dow_bucket_t NOT NULL,
    stay_season_band        season_band_t NOT NULL DEFAULT 'UNKNOWN',

    -- availability / quality
    rooms_left              SMALLINT,                       -- U11
    is_available            BOOLEAN     NOT NULL DEFAULT true,
    match_method            match_method_t NOT NULL DEFAULT 'UNMATCHED',
    match_confidence        NUMERIC(3,2) NOT NULL DEFAULT 0
                            CHECK (match_confidence BETWEEN 0 AND 1),
    comparability_class     TEXT        NOT NULL DEFAULT 'UNRESOLVED',

    -- provenance
    ingest_batch_id         BIGINT,
    raw                     JSONB,

    CONSTRAINT rate_obs_checkout_ck  CHECK (check_out = check_in + nights),
    CONSTRAINT rate_obs_leadtime_ck  CHECK (check_in >= observed_date - 1),
    PRIMARY KEY (id, observed_at)
) PARTITION BY RANGE (observed_at);

-- Monthly partitions, created ahead of time by a scheduled job.
CREATE TABLE rate_observation_2026_08 PARTITION OF rate_observation
    FOR VALUES FROM ('2026-08-01Z') TO ('2026-09-01Z');
CREATE TABLE rate_observation_2026_09 PARTITION OF rate_observation
    FOR VALUES FROM ('2026-09-01Z') TO ('2026-10-01Z');
CREATE TABLE rate_observation_default PARTITION OF rate_observation DEFAULT;  -- alarms, never errors

-- Idempotent ingest: a repeat capture in the same slot is a no-op.
CREATE UNIQUE INDEX rate_obs_dedup_uidx ON rate_observation
    (source_id, hotel_id, room_type_id, rate_plan_id, check_in, nights,
     adults, children, currency, observation_slot);

-- Historical distribution H(Q): hotel + room + class, stratified.
CREATE INDEX rate_obs_baseline_idx ON rate_observation
    (hotel_id, room_type_id, comparability_class, stay_season_band,
     stay_dow_bucket, lead_time_days, observed_at DESC)
    INCLUDE (nightly_amount_minor)
    WHERE is_available AND match_confidence >= 0.5;

-- Same-stay series S(Q): trend and chart.
CREATE INDEX rate_obs_series_idx ON rate_observation
    (hotel_id, room_type_id, comparability_class, check_in, nights,
     adults, children, observed_at DESC)
    INCLUDE (nightly_amount_minor);

CREATE TABLE ingest_batch (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id       BIGINT      NOT NULL REFERENCES source(id),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    rows_received   INTEGER     NOT NULL DEFAULT 0,
    rows_inserted   INTEGER     NOT NULL DEFAULT 0,
    rows_duplicate  INTEGER     NOT NULL DEFAULT 0,
    rows_rejected   INTEGER     NOT NULL DEFAULT 0,
    status          TEXT        NOT NULL DEFAULT 'RUNNING'
                                CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
    error_summary   TEXT
);

CREATE TABLE ingest_reject (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ingest_batch_id BIGINT      NOT NULL REFERENCES ingest_batch(id) ON DELETE CASCADE,
    reason_code     TEXT        NOT NULL,
    detail          TEXT,
    raw             JSONB       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ingest_reject_batch_idx ON ingest_reject (ingest_batch_id, reason_code);
```

---

## 4. Rollups, comparables, benefits, events

```sql
-- Materialized baseline: the scoring engine reads one row, never scans raw facts.
CREATE TABLE rate_baseline (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id            BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    room_type_id        BIGINT      NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
    comparability_class TEXT        NOT NULL,
    stay_season_band    season_band_t NOT NULL,
    stay_dow_bucket     dow_bucket_t NOT NULL,
    lead_bucket         TEXT        NOT NULL,          -- '0-3','4-7','8-14','15-30','31-60','61-120','121+'
    currency            CHAR(3)     NOT NULL,

    n_observations      INTEGER     NOT NULL,
    n_outliers_excluded INTEGER     NOT NULL DEFAULT 0,
    p10_minor           BIGINT      NOT NULL,
    p25_minor           BIGINT      NOT NULL,
    p50_minor           BIGINT      NOT NULL,
    p75_minor           BIGINT      NOT NULL,
    p90_minor           BIGINT      NOT NULL,
    min_minor           BIGINT      NOT NULL,
    max_minor           BIGINT      NOT NULL,
    mean_minor          BIGINT      NOT NULL,
    stddev_minor        BIGINT      NOT NULL,
    cv                  NUMERIC(6,4) NOT NULL,
    n_sources           SMALLINT    NOT NULL DEFAULT 1,
    mean_match_conf     NUMERIC(3,2) NOT NULL,

    window_start        DATE        NOT NULL,
    window_end          DATE        NOT NULL,
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (hotel_id, room_type_id, comparability_class, stay_season_band,
            stay_dow_bucket, lead_bucket, currency)
);
CREATE INDEX rate_baseline_stale_idx ON rate_baseline (computed_at);

CREATE TABLE hotel_comparable (                     -- U12
    hotel_id        BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    comparable_id   BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    similarity      NUMERIC(4,3) NOT NULL CHECK (similarity BETWEEN 0 AND 1),
    rank            SMALLINT    NOT NULL,
    basis           TEXT        NOT NULL,           -- 'DESTINATION_TIER_PRICEBAND'
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hotel_id, comparable_id),
    CHECK (hotel_id <> comparable_id)
);
CREATE INDEX hotel_comparable_rank_idx ON hotel_comparable (hotel_id, rank);

CREATE TABLE benefit (                              -- U10
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code                TEXT        NOT NULL UNIQUE, -- 'BREAKFAST_2','HOTEL_CREDIT','UPGRADE'
    display_name        TEXT        NOT NULL,
    basis               benefit_basis_t NOT NULL,
    default_value_minor BIGINT,
    currency            CHAR(3)     NOT NULL DEFAULT 'USD',
    realization_factor  NUMERIC(3,2) NOT NULL DEFAULT 1.00
                        CHECK (realization_factor BETWEEN 0 AND 1)
);

CREATE TABLE rate_plan_benefit (
    rate_plan_id    BIGINT      NOT NULL REFERENCES rate_plan(id) ON DELETE CASCADE,
    benefit_id      BIGINT      NOT NULL REFERENCES benefit(id) ON DELETE CASCADE,
    value_minor     BIGINT,                          -- overrides benefit default
    currency        CHAR(3),
    notes           TEXT,
    PRIMARY KEY (rate_plan_id, benefit_id)
);

CREATE TABLE hotel_benefit (                        -- hotel-level (preferred-partner) benefits
    hotel_id        BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    benefit_id      BIGINT      NOT NULL REFERENCES benefit(id) ON DELETE CASCADE,
    value_minor     BIGINT,
    currency        CHAR(3),
    valid_from      DATE,
    valid_to        DATE,
    PRIMARY KEY (hotel_id, benefit_id)
);

CREATE TABLE destination_event (                    -- U14, optional in MVP
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    destination_id  BIGINT      NOT NULL REFERENCES destination(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    start_date      DATE        NOT NULL,
    end_date        DATE        NOT NULL,
    impact_score    NUMERIC(3,2) NOT NULL DEFAULT 0.5 CHECK (impact_score BETWEEN 0 AND 1),
    source_note     TEXT,
    CHECK (end_date >= start_date)
);
CREATE INDEX destination_event_range_idx ON destination_event (destination_id, start_date, end_date);
```

---

## 5. Configuration and computed analyses

```sql
-- Versioned, append-only. An analysis records which version produced it,
-- so any historical score remains reproducible after recalibration.
CREATE TABLE scoring_config (
    version         INTEGER     PRIMARY KEY,
    config          JSONB       NOT NULL,        -- full registry, doc 10
    is_active       BOOLEAN     NOT NULL DEFAULT false,
    note            TEXT,
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scoring_config_one_active_uidx ON scoring_config (is_active) WHERE is_active;

CREATE TABLE analysis (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id           TEXT        NOT NULL UNIQUE,     -- 'an_…' exposed by the API

    -- query
    hotel_id            BIGINT      NOT NULL REFERENCES hotel(id),
    room_type_id        BIGINT      REFERENCES room_type(id),
    rate_plan_id        BIGINT      REFERENCES rate_plan(id),
    comparability_class TEXT        NOT NULL,
    check_in            DATE        NOT NULL,
    nights              SMALLINT    NOT NULL,
    adults              SMALLINT    NOT NULL,
    children            SMALLINT    NOT NULL,
    currency            CHAR(3)     NOT NULL,

    -- current price
    current_nightly_minor    BIGINT NOT NULL,
    current_total_minor      BIGINT NOT NULL,
    effective_nightly_minor  BIGINT,
    rate_observed_at         TIMESTAMPTZ NOT NULL,

    -- verdict
    deal_score          SMALLINT    CHECK (deal_score BETWEEN 0 AND 100),
    deal_score_band     score_band_t,
    confidence          SMALLINT    NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    confidence_band     conf_band_t NOT NULL,
    recommendation      recommendation_t NOT NULL,
    gate_fired          TEXT        NOT NULL,
    wait_blocked_by     TEXT[]      NOT NULL DEFAULT '{}',
    reason_codes        TEXT[]      NOT NULL DEFAULT '{}',
    caveat_codes        TEXT[]      NOT NULL DEFAULT '{}',

    -- evidence
    baseline_level      TEXT        NOT NULL,
    n_observations      INTEGER     NOT NULL,
    baseline_p50_minor  BIGINT,
    baseline_p10_minor  BIGINT,
    baseline_p90_minor  BIGINT,
    baseline_min_minor  BIGINT,
    baseline_max_minor  BIGINT,
    percentile_rank     NUMERIC(5,4),

    -- reproducibility
    config_version      INTEGER     NOT NULL REFERENCES scoring_config(version),
    engine_version      TEXT        NOT NULL,
    decision_trace      JSONB       NOT NULL,
    explanation_bundle  JSONB       NOT NULL,

    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The invariant from doc 03, enforced by the database as the last line of defence.
    CONSTRAINT analysis_wait_confidence_ck
        CHECK (recommendation <> 'WAIT' OR confidence >= 70),
    CONSTRAINT analysis_insufficient_ck
        CHECK (recommendation <> 'INSUFFICIENT_DATA' OR deal_score IS NULL)
);
CREATE INDEX analysis_query_idx  ON analysis (hotel_id, room_type_id, check_in, nights, adults, computed_at DESC);
CREATE INDEX analysis_recent_idx ON analysis (computed_at DESC);

-- Per-factor breakdown: the raw material for the calibration runbook (doc 02 §4).
CREATE TABLE analysis_factor (
    analysis_id     BIGINT      NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
    factor_code     TEXT        NOT NULL,           -- 'F1'…'F6'
    is_available    BOOLEAN     NOT NULL,
    raw_value       NUMERIC(12,4),
    sub_score       SMALLINT    CHECK (sub_score BETWEEN 0 AND 100),
    weight_applied  NUMERIC(4,3) NOT NULL,
    unavailable_reason TEXT,
    PRIMARY KEY (analysis_id, factor_code)
);

CREATE TABLE explanation_cache (
    bundle_hash     TEXT        PRIMARY KEY,        -- sha256(bundle) + locale + prompt_version
    locale          TEXT        NOT NULL DEFAULT 'en-US',
    prompt_version  INTEGER     NOT NULL,
    text            TEXT        NOT NULL,
    generator       TEXT        NOT NULL CHECK (generator IN ('MODEL','TEMPLATE')),
    validation_passed BOOLEAN   NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX explanation_cache_expiry_idx ON explanation_cache (expires_at);
```

### Reserved for Phase 2 (schema only, no MVP implementation)

```sql
CREATE TABLE price_alert (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id       TEXT        NOT NULL UNIQUE,
    email           TEXT        NOT NULL,
    hotel_id        BIGINT      NOT NULL REFERENCES hotel(id),
    room_type_id    BIGINT      REFERENCES room_type(id),
    check_in        DATE        NOT NULL,
    nights          SMALLINT    NOT NULL,
    adults          SMALLINT    NOT NULL DEFAULT 2,
    children        SMALLINT    NOT NULL DEFAULT 0,
    target_minor    BIGINT,
    currency        CHAR(3)     NOT NULL DEFAULT 'USD',
    is_active       BOOLEAN     NOT NULL DEFAULT true,
    last_notified_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_alert_active_idx ON price_alert (hotel_id, check_in) WHERE is_active;
```

---

## 6. Schema notes worth reviewing

1. **`nightly_amount_minor` is a stored generated column**; `lead_time_days` likewise, but only because `observed_date` is written explicitly at ingest. A generated column cannot derive a date from a `timestamptz` — that cast is `STABLE`, not `IMMUTABLE`, and Postgres rejects it. Ingest computes `observed_date` and `observation_slot`.
2. **The partition key is part of the primary key** (`id, observed_at`) — a Postgres requirement for partitioned tables, and the reason `id` alone is not unique.
3. **The dedup index makes collection retry-safe.** Ingest uses `ON CONFLICT DO NOTHING` and counts conflicts as duplicates.
4. **`comparability_class` is denormalized onto `rate_observation`** rather than joined from `rate_plan`. Deliberate: baseline queries filter on it constantly, and the join would defeat the covering index.
5. **The `analysis_wait_confidence_ck` constraint duplicates an application rule.** That is the point — three enforcement layers (engine gate, boundary assertion, database constraint) for the one rule with a direct path to customer harm.
6. **`analysis` is append-only**, one row per evaluation. At high traffic this grows quickly; a retention policy (`ANALYSIS_RETENTION_DAYS`, default 180) and eventual partitioning by `computed_at` should be planned but are not needed at MVP volume.
7. **`raw JSONB` on every observation** is the audit trail. It roughly doubles the fact table's size; if that proves costly, compress or sample it — but do not remove it before there is another way to answer "what did the source actually say?"
