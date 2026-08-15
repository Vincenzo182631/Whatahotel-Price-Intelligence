-- 0003 — The fact table: rate observations, partitioned by observation time
-- Spec: docs/mvp/05-database-schema.md §3

CREATE TABLE ingest_batch (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id      BIGINT      NOT NULL REFERENCES source(id),
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    rows_received  INTEGER     NOT NULL DEFAULT 0,
    rows_inserted  INTEGER     NOT NULL DEFAULT 0,
    rows_duplicate INTEGER     NOT NULL DEFAULT 0,
    rows_rejected  INTEGER     NOT NULL DEFAULT 0,
    status         TEXT        NOT NULL DEFAULT 'RUNNING'
                               CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED')),
    error_summary  TEXT
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

CREATE TABLE rate_observation (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY,
    observed_at              TIMESTAMPTZ    NOT NULL,

    source_id                BIGINT         NOT NULL REFERENCES source(id),
    hotel_id                 BIGINT         NOT NULL REFERENCES hotel(id),
    room_type_id             BIGINT         REFERENCES room_type(id),
    rate_plan_id             BIGINT         REFERENCES rate_plan(id),

    check_in                 DATE           NOT NULL,
    nights                   SMALLINT       NOT NULL CHECK (nights BETWEEN 1 AND 30),
    check_out                DATE           NOT NULL,
    adults                   SMALLINT       NOT NULL DEFAULT 2 CHECK (adults BETWEEN 1 AND 10),
    children                 SMALLINT       NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 10),

    currency                 CHAR(3)        NOT NULL,
    total_amount_minor       BIGINT         NOT NULL CHECK (total_amount_minor > 0),
    total_gross_amount_minor BIGINT         CHECK (total_gross_amount_minor > 0),
    taxes_fees_minor         BIGINT,
    tax_basis                tax_basis_t    NOT NULL DEFAULT 'UNKNOWN',
    nightly_amount_minor     BIGINT
        GENERATED ALWAYS AS (round(total_amount_minor::numeric / nights)::bigint) STORED,

    -- Written at ingest: timestamptz -> date is STABLE, not IMMUTABLE, so it
    -- cannot appear in a generated column.
    observed_date            DATE           NOT NULL,
    observation_slot         TIMESTAMPTZ    NOT NULL,
    lead_time_days           INTEGER
        GENERATED ALWAYS AS ((check_in - observed_date)) STORED,
    stay_dow_bucket          dow_bucket_t   NOT NULL,
    stay_season_band         season_band_t  NOT NULL DEFAULT 'UNKNOWN',

    rooms_left               SMALLINT,                    -- U11
    is_available             BOOLEAN        NOT NULL DEFAULT true,
    match_method             match_method_t NOT NULL DEFAULT 'UNMATCHED',
    match_confidence         NUMERIC(3,2)   NOT NULL DEFAULT 0
                                            CHECK (match_confidence BETWEEN 0 AND 1),
    comparability_class      TEXT           NOT NULL DEFAULT 'UNRESOLVED',

    ingest_batch_id          BIGINT,
    raw                      JSONB,

    CONSTRAINT rate_obs_checkout_ck CHECK (check_out = check_in + nights),
    CONSTRAINT rate_obs_leadtime_ck CHECK (check_in >= observed_date - 1),
    PRIMARY KEY (id, observation_slot)
)
-- Partitioned on observation_slot rather than observed_at. Postgres requires a
-- unique index on a partitioned table to include every partition-key column,
-- and the dedup key is the SLOT, not the exact capture instant — partitioning
-- on observed_at would have forced it into the dedup index and allowed two
-- captures in the same slot to both land. observation_slot is observed_at
-- truncated to the hour, so monthly ranges behave identically either way.
PARTITION BY RANGE (observation_slot);

CREATE TABLE rate_observation_2026_08 PARTITION OF rate_observation
    FOR VALUES FROM ('2026-08-01Z') TO ('2026-09-01Z');
CREATE TABLE rate_observation_2026_09 PARTITION OF rate_observation
    FOR VALUES FROM ('2026-09-01Z') TO ('2026-10-01Z');
CREATE TABLE rate_observation_2026_10 PARTITION OF rate_observation
    FOR VALUES FROM ('2026-10-01Z') TO ('2026-11-01Z');
-- Catches surprises so ingest alarms rather than errors.
CREATE TABLE rate_observation_default PARTITION OF rate_observation DEFAULT;

-- Makes collection retries idempotent (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX rate_obs_dedup_uidx ON rate_observation
    (source_id, hotel_id, room_type_id, rate_plan_id, check_in, nights,
     adults, children, currency, observation_slot);

-- Historical distribution H(Q).
CREATE INDEX rate_obs_baseline_idx ON rate_observation
    (hotel_id, room_type_id, comparability_class, stay_season_band,
     stay_dow_bucket, lead_time_days, observed_at DESC)
    INCLUDE (nightly_amount_minor)
    WHERE is_available AND match_confidence >= 0.5;

-- Same-stay series S(Q).
CREATE INDEX rate_obs_series_idx ON rate_observation
    (hotel_id, room_type_id, comparability_class, check_in, nights,
     adults, children, observed_at DESC)
    INCLUDE (nightly_amount_minor);
