-- 0005 — Versioned scoring config, computed analyses, explanation cache
-- Spec: docs/mvp/05-database-schema.md §5

CREATE TABLE scoring_config (
    version    INTEGER     PRIMARY KEY,
    config     JSONB       NOT NULL,
    is_active  BOOLEAN     NOT NULL DEFAULT false,
    note       TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scoring_config_one_active_uidx ON scoring_config (is_active) WHERE is_active;

CREATE TABLE analysis (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id               TEXT             NOT NULL UNIQUE,

    hotel_id                BIGINT           NOT NULL REFERENCES hotel(id),
    room_type_id            BIGINT           REFERENCES room_type(id),
    rate_plan_id            BIGINT           REFERENCES rate_plan(id),
    comparability_class     TEXT             NOT NULL,
    check_in                DATE             NOT NULL,
    nights                  SMALLINT         NOT NULL,
    adults                  SMALLINT         NOT NULL,
    children                SMALLINT         NOT NULL,
    currency                CHAR(3)          NOT NULL,

    current_nightly_minor   BIGINT           NOT NULL,
    current_total_minor     BIGINT           NOT NULL,
    effective_nightly_minor BIGINT,
    rate_observed_at        TIMESTAMPTZ      NOT NULL,

    deal_score              SMALLINT         CHECK (deal_score BETWEEN 0 AND 100),
    deal_score_band         score_band_t,
    confidence              SMALLINT         NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    confidence_band         conf_band_t      NOT NULL,
    recommendation          recommendation_t NOT NULL,
    gate_fired              TEXT             NOT NULL,
    wait_blocked_by         TEXT[]           NOT NULL DEFAULT '{}',
    reason_codes            TEXT[]           NOT NULL DEFAULT '{}',
    caveat_codes            TEXT[]           NOT NULL DEFAULT '{}',

    baseline_level          TEXT             NOT NULL,
    n_observations          INTEGER          NOT NULL,
    baseline_p50_minor      BIGINT,
    baseline_p10_minor      BIGINT,
    baseline_p90_minor      BIGINT,
    baseline_min_minor      BIGINT,
    baseline_max_minor      BIGINT,
    percentile_rank         NUMERIC(5,4),

    config_version          INTEGER          NOT NULL REFERENCES scoring_config(version),
    engine_version          TEXT             NOT NULL,
    decision_trace          JSONB            NOT NULL,
    explanation_bundle      JSONB            NOT NULL,

    computed_at             TIMESTAMPTZ      NOT NULL DEFAULT now(),

    -- Third enforcement layer for the never-WAIT rule (engine gate, boundary
    -- assertion, and here). See docs/mvp/03 §4.
    CONSTRAINT analysis_wait_confidence_ck
        CHECK (recommendation <> 'WAIT' OR confidence >= 70),
    CONSTRAINT analysis_insufficient_ck
        CHECK (recommendation <> 'INSUFFICIENT_DATA' OR deal_score IS NULL)
);
CREATE INDEX analysis_query_idx  ON analysis (hotel_id, room_type_id, check_in, nights, adults, computed_at DESC);
CREATE INDEX analysis_recent_idx ON analysis (computed_at DESC);

CREATE TABLE analysis_factor (
    analysis_id        BIGINT       NOT NULL REFERENCES analysis(id) ON DELETE CASCADE,
    factor_code        TEXT         NOT NULL,
    is_available       BOOLEAN      NOT NULL,
    raw_value          NUMERIC(12,4),
    sub_score          SMALLINT     CHECK (sub_score BETWEEN 0 AND 100),
    weight_applied     NUMERIC(4,3) NOT NULL,
    unavailable_reason TEXT,
    PRIMARY KEY (analysis_id, factor_code)
);

CREATE TABLE explanation_cache (
    bundle_hash       TEXT        PRIMARY KEY,
    locale            TEXT        NOT NULL DEFAULT 'en-US',
    prompt_version    INTEGER     NOT NULL,
    text              TEXT        NOT NULL,
    generator         TEXT        NOT NULL CHECK (generator IN ('MODEL','TEMPLATE')),
    validation_passed BOOLEAN     NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX explanation_cache_expiry_idx ON explanation_cache (expires_at);

-- Phase 2 shape reserved; no MVP implementation.
CREATE TABLE price_alert (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    public_id        TEXT        NOT NULL UNIQUE,
    email            TEXT        NOT NULL,
    hotel_id         BIGINT      NOT NULL REFERENCES hotel(id),
    room_type_id     BIGINT      REFERENCES room_type(id),
    check_in         DATE        NOT NULL,
    nights           SMALLINT    NOT NULL,
    adults           SMALLINT    NOT NULL DEFAULT 2,
    children         SMALLINT    NOT NULL DEFAULT 0,
    target_minor     BIGINT,
    currency         CHAR(3)     NOT NULL DEFAULT 'USD',
    is_active        BOOLEAN     NOT NULL DEFAULT true,
    last_notified_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_alert_active_idx ON price_alert (hotel_id, check_in) WHERE is_active;
