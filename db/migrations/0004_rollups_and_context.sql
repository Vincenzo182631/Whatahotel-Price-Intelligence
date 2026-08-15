-- 0004 — Baseline rollups, comparables, benefits, events
-- Spec: docs/mvp/05-database-schema.md §4

-- Baselines are precomputed at EVERY level of the widening ladder (docs/mvp/01
-- §6), so a page view reads exactly one row: the most specific level that has
-- enough observations. Merging percentile summaries across strata at query time
-- is not statistically sound, and scanning raw facts per request would put the
-- fact table on the hot path.
--
-- Stratum columns are NULL at the levels that do not use them:
--   L0  season + day-of-week + lead bucket
--   L1  season + day-of-week
--   L2  season
--   L3  no stratification
--   L4  no stratification, observations borrowed from sibling room types
CREATE TABLE rate_baseline (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id            BIGINT        NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    room_type_id        BIGINT        NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
    comparability_class TEXT          NOT NULL,
    baseline_level      TEXT          NOT NULL
                                      CHECK (baseline_level IN ('L0','L1','L2','L3','L4')),
    stay_season_band    season_band_t,
    stay_dow_bucket     dow_bucket_t,
    lead_bucket         TEXT,
    currency            CHAR(3)       NOT NULL,

    n_observations      INTEGER       NOT NULL,
    n_outliers_excluded INTEGER       NOT NULL DEFAULT 0,
    p10_minor           BIGINT        NOT NULL,
    p25_minor           BIGINT        NOT NULL,
    p50_minor           BIGINT        NOT NULL,
    p75_minor           BIGINT        NOT NULL,
    p90_minor           BIGINT        NOT NULL,
    min_minor           BIGINT        NOT NULL,
    max_minor           BIGINT        NOT NULL,
    mean_minor          BIGINT        NOT NULL,
    stddev_minor        BIGINT        NOT NULL,
    cv                  NUMERIC(6,4)  NOT NULL,
    n_sources           SMALLINT      NOT NULL DEFAULT 1,
    mean_match_conf     NUMERIC(3,2)  NOT NULL,
    -- Feed the confidence factors f_consistency and f_match directly, so the
    -- engine never has to reach back into the fact table for them.
    cross_source_cv     NUMERIC(6,4),
    unresolved_share    NUMERIC(4,3)  NOT NULL DEFAULT 0,

    window_start        DATE          NOT NULL,
    window_end          DATE          NOT NULL,
    computed_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- NULLS NOT DISTINCT (PostgreSQL 15+) so the coarser levels, which leave
-- stratum columns NULL, still deduplicate correctly.
CREATE UNIQUE INDEX rate_baseline_key_uidx ON rate_baseline
    (hotel_id, room_type_id, comparability_class, baseline_level,
     stay_season_band, stay_dow_bucket, lead_bucket, currency)
    NULLS NOT DISTINCT;

CREATE INDEX rate_baseline_lookup_idx ON rate_baseline
    (hotel_id, room_type_id, comparability_class, currency, baseline_level);
CREATE INDEX rate_baseline_stale_idx ON rate_baseline (computed_at);

CREATE TABLE hotel_comparable (                     -- U12
    hotel_id      BIGINT       NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    comparable_id BIGINT       NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    similarity    NUMERIC(4,3) NOT NULL CHECK (similarity BETWEEN 0 AND 1),
    rank          SMALLINT     NOT NULL,
    basis         TEXT         NOT NULL,
    computed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (hotel_id, comparable_id),
    CHECK (hotel_id <> comparable_id)
);
CREATE INDEX hotel_comparable_rank_idx ON hotel_comparable (hotel_id, rank);

CREATE TABLE benefit (                              -- U10
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code                TEXT            NOT NULL UNIQUE,
    display_name        TEXT            NOT NULL,
    basis               benefit_basis_t NOT NULL,
    default_value_minor BIGINT,
    currency            CHAR(3)         NOT NULL DEFAULT 'USD',
    realization_factor  NUMERIC(3,2)    NOT NULL DEFAULT 1.00
                                        CHECK (realization_factor BETWEEN 0 AND 1)
);

CREATE TABLE rate_plan_benefit (
    rate_plan_id BIGINT NOT NULL REFERENCES rate_plan(id) ON DELETE CASCADE,
    benefit_id   BIGINT NOT NULL REFERENCES benefit(id) ON DELETE CASCADE,
    value_minor  BIGINT,
    currency     CHAR(3),
    notes        TEXT,
    PRIMARY KEY (rate_plan_id, benefit_id)
);

CREATE TABLE hotel_benefit (
    hotel_id    BIGINT NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    benefit_id  BIGINT NOT NULL REFERENCES benefit(id) ON DELETE CASCADE,
    value_minor BIGINT,
    currency    CHAR(3),
    valid_from  DATE,
    valid_to    DATE,
    PRIMARY KEY (hotel_id, benefit_id)
);

CREATE TABLE destination_event (                    -- U14
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    destination_id BIGINT       NOT NULL REFERENCES destination(id) ON DELETE CASCADE,
    name           TEXT         NOT NULL,
    start_date     DATE         NOT NULL,
    end_date       DATE         NOT NULL,
    impact_score   NUMERIC(3,2) NOT NULL DEFAULT 0.5 CHECK (impact_score BETWEEN 0 AND 1),
    source_note    TEXT,
    CHECK (end_date >= start_date)
);
CREATE INDEX destination_event_range_idx ON destination_event (destination_id, start_date, end_date);
