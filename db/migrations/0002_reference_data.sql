-- 0002 — Reference data: sources, hotels, room types, rate plans
-- Spec: docs/mvp/05-database-schema.md §2

CREATE TABLE source (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code             TEXT         NOT NULL UNIQUE,
    display_name     TEXT         NOT NULL,
    is_authoritative BOOLEAN      NOT NULL DEFAULT false,
    trust_weight     NUMERIC(3,2) NOT NULL DEFAULT 1.00 CHECK (trust_weight BETWEEN 0 AND 1),
    is_active        BOOLEAN      NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE destination (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug         TEXT        NOT NULL UNIQUE,
    name         TEXT        NOT NULL,
    country_code CHAR(2),
    timezone     TEXT        NOT NULL DEFAULT 'UTC',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hotel (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wah_hotel_id    TEXT         NOT NULL UNIQUE,   -- U1
    name            TEXT         NOT NULL,
    brand           TEXT,
    chain           TEXT,
    destination_id  BIGINT       REFERENCES destination(id),
    latitude        NUMERIC(9,6),
    longitude       NUMERIC(9,6),
    star_rating     NUMERIC(2,1) CHECK (star_rating BETWEEN 0 AND 5),
    luxury_tier     SMALLINT     CHECK (luxury_tier BETWEEN 1 AND 5),
    base_currency   CHAR(3)      NOT NULL DEFAULT 'USD',
    timezone        TEXT         NOT NULL DEFAULT 'UTC',
    collection_tier TEXT         NOT NULL DEFAULT 'WARM'
                                 CHECK (collection_tier IN ('HOT','WARM','COLD','OFF')),
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX hotel_destination_idx ON hotel (destination_id) WHERE is_active;
CREATE INDEX hotel_name_trgm_idx   ON hotel USING gin (name gin_trgm_ops);

CREATE TABLE hotel_external_id (
    hotel_id    BIGINT NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    source_id   BIGINT NOT NULL REFERENCES source(id),
    external_id TEXT   NOT NULL,
    PRIMARY KEY (source_id, external_id)
);

CREATE TABLE room_type (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id        BIGINT       NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    canonical_name  TEXT         NOT NULL,
    normalized_name TEXT         NOT NULL,
    room_class      room_class_t NOT NULL DEFAULT 'UNKNOWN',
    bed_config      bed_config_t NOT NULL DEFAULT 'UNKNOWN',
    view_type       view_t       NOT NULL DEFAULT 'UNKNOWN',
    max_occupancy   SMALLINT,
    size_sqm        NUMERIC(6,1),
    tier_ordinal    SMALLINT,
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, normalized_name)
);
CREATE INDEX room_type_hotel_idx ON room_type (hotel_id) WHERE is_active;

CREATE TABLE room_type_alias (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id         BIGINT         NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    room_type_id     BIGINT         NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
    source_id        BIGINT         REFERENCES source(id),
    raw_value        TEXT           NOT NULL,
    normalized_value TEXT           NOT NULL,
    source_room_code TEXT,                              -- U9
    match_method     match_method_t NOT NULL,
    match_confidence NUMERIC(3,2)   NOT NULL CHECK (match_confidence BETWEEN 0 AND 1),
    is_confirmed     BOOLEAN        NOT NULL DEFAULT false,
    times_seen       INTEGER        NOT NULL DEFAULT 1,
    created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, source_id, normalized_value)
);
CREATE INDEX rta_norm_trgm_idx ON room_type_alias USING gin (normalized_value gin_trgm_ops);
CREATE INDEX rta_review_idx    ON room_type_alias (hotel_id) WHERE NOT is_confirmed;

CREATE TABLE rate_plan (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id            BIGINT          NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    source_id           BIGINT          NOT NULL REFERENCES source(id),
    source_plan_code    TEXT,                            -- U8
    display_name        TEXT,
    meal_plan           meal_plan_t     NOT NULL DEFAULT 'UNKNOWN',
    refund_policy       refund_policy_t NOT NULL DEFAULT 'UNKNOWN',
    is_prepaid          BOOLEAN,
    audience            rate_audience_t NOT NULL DEFAULT 'UNKNOWN',
    -- Derived by the classifier at ingest; not a generated column so the
    -- classification rules can evolve without a table rewrite.
    comparability_class TEXT            NOT NULL DEFAULT 'UNRESOLVED',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    UNIQUE (hotel_id, source_id, source_plan_code)
);
CREATE INDEX rate_plan_class_idx ON rate_plan (hotel_id, comparability_class);
