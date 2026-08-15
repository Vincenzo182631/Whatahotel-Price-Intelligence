-- Schema behaviour checks.
--
-- These verify the guarantees the schema is supposed to provide, not just that
-- the DDL parses. Run against a freshly migrated database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/checks/schema_checks.sql
--
-- Every check RAISEs on failure, so a non-zero exit means a real regression.

BEGIN;

-- Fixtures ------------------------------------------------------------------
INSERT INTO source (code, display_name, is_authoritative)
VALUES ('TEST_SRC', 'Test source', true);

INSERT INTO destination (slug, name, country_code)
VALUES ('miami-beach', 'Miami Beach', 'US');

INSERT INTO hotel (wah_hotel_id, name, destination_id, luxury_tier)
SELECT '2962', 'Test Hotel', id, 5 FROM destination WHERE slug = 'miami-beach';

INSERT INTO room_type (hotel_id, canonical_name, normalized_name, room_class, bed_config, view_type)
SELECT id, 'Ocean View King', 'ocean view king', 'ROOM', 'KING', 'OCEAN' FROM hotel WHERE wah_hotel_id = '2962';

INSERT INTO room_type (hotel_id, canonical_name, normalized_name, room_class, bed_config, view_type)
SELECT id, 'Ocean View King Suite', 'ocean view king suite', 'SUITE', 'KING', 'OCEAN' FROM hotel WHERE wah_hotel_id = '2962';

INSERT INTO rate_plan (hotel_id, source_id, source_plan_code, meal_plan, refund_policy, audience, comparability_class)
SELECT h.id, s.id, 'BB-FLEX', 'BREAKFAST', 'REFUNDABLE', 'PUBLIC', 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC'
FROM hotel h, source s WHERE h.wah_hotel_id = '2962' AND s.code = 'TEST_SRC';

INSERT INTO ingest_batch (source_id) SELECT id FROM source WHERE code = 'TEST_SRC';

-- Check 1 · generated columns -----------------------------------------------
INSERT INTO rate_observation (
    observed_at, source_id, hotel_id, room_type_id, rate_plan_id,
    check_in, nights, check_out, adults, children,
    currency, total_amount_minor, tax_basis,
    observed_date, observation_slot, stay_dow_bucket, stay_season_band,
    match_method, match_confidence, comparability_class
)
SELECT '2026-08-14T09:12:00Z', s.id, h.id, rt.id, rp.id,
       DATE '2026-09-18', 3, DATE '2026-09-21', 2, 0,
       'USD', 206700, 'GROSS',
       DATE '2026-08-14', '2026-08-14T09:00:00Z', 'WEEKDAY', 'SHOULDER',
       'SOURCE_ID', 1.00, 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC'
FROM hotel h, source s, room_type rt, rate_plan rp
WHERE h.wah_hotel_id = '2962' AND s.code = 'TEST_SRC'
  AND rt.normalized_name = 'ocean view king' AND rp.source_plan_code = 'BB-FLEX';

DO $$
DECLARE nightly BIGINT; lead INT;
BEGIN
    SELECT nightly_amount_minor, lead_time_days INTO nightly, lead FROM rate_observation LIMIT 1;
    IF nightly <> 68900 THEN
        RAISE EXCEPTION 'CHECK 1a FAILED: nightly_amount_minor = % (expected 68900)', nightly;
    END IF;
    IF lead <> 35 THEN
        RAISE EXCEPTION 'CHECK 1b FAILED: lead_time_days = % (expected 35)', lead;
    END IF;
    RAISE NOTICE 'CHECK 1  ok — generated columns (nightly=%, lead=%d)', nightly, lead;
END $$;

-- Check 2 · dedup is idempotent within a slot --------------------------------
INSERT INTO rate_observation (
    observed_at, source_id, hotel_id, room_type_id, rate_plan_id,
    check_in, nights, check_out, adults, children,
    currency, total_amount_minor, tax_basis,
    observed_date, observation_slot, stay_dow_bucket, stay_season_band,
    match_method, match_confidence, comparability_class
)
SELECT '2026-08-14T09:47:00Z', s.id, h.id, rt.id, rp.id,   -- different instant, SAME slot
       DATE '2026-09-18', 3, DATE '2026-09-21', 2, 0,
       'USD', 209900, 'GROSS',
       DATE '2026-08-14', '2026-08-14T09:00:00Z', 'WEEKDAY', 'SHOULDER',
       'SOURCE_ID', 1.00, 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC'
FROM hotel h, source s, room_type rt, rate_plan rp
WHERE h.wah_hotel_id = '2962' AND s.code = 'TEST_SRC'
  AND rt.normalized_name = 'ocean view king' AND rp.source_plan_code = 'BB-FLEX'
ON CONFLICT DO NOTHING;

DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM rate_observation;
    IF n <> 1 THEN
        RAISE EXCEPTION 'CHECK 2 FAILED: % rows after same-slot re-capture (expected 1)', n;
    END IF;
    RAISE NOTICE 'CHECK 2  ok — same-slot re-capture is a no-op, collection retries are safe';
END $$;

-- Check 3 · a later slot is a new observation --------------------------------
INSERT INTO rate_observation (
    observed_at, source_id, hotel_id, room_type_id, rate_plan_id,
    check_in, nights, check_out, adults, children,
    currency, total_amount_minor, tax_basis,
    observed_date, observation_slot, stay_dow_bucket, stay_season_band,
    match_method, match_confidence, comparability_class
)
SELECT '2026-08-14T10:05:00Z', s.id, h.id, rt.id, rp.id,
       DATE '2026-09-18', 3, DATE '2026-09-21', 2, 0,
       'USD', 209900, 'GROSS',
       DATE '2026-08-14', '2026-08-14T10:00:00Z', 'WEEKDAY', 'SHOULDER',
       'SOURCE_ID', 1.00, 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC'
FROM hotel h, source s, room_type rt, rate_plan rp
WHERE h.wah_hotel_id = '2962' AND s.code = 'TEST_SRC'
  AND rt.normalized_name = 'ocean view king' AND rp.source_plan_code = 'BB-FLEX'
ON CONFLICT DO NOTHING;

DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM rate_observation;
    IF n <> 2 THEN RAISE EXCEPTION 'CHECK 3 FAILED: % rows (expected 2)', n; END IF;
    RAISE NOTICE 'CHECK 3  ok — a new slot records a new observation';
END $$;

-- Check 4 · partition routing ------------------------------------------------
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM rate_observation_2026_08;
    IF n <> 2 THEN
        RAISE EXCEPTION 'CHECK 4 FAILED: % rows in the August partition (expected 2)', n;
    END IF;
    RAISE NOTICE 'CHECK 4  ok — observations route to the correct monthly partition';
END $$;

-- Check 5 · check_out must agree with nights ---------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO rate_observation (
            observed_at, source_id, hotel_id, room_type_id, rate_plan_id,
            check_in, nights, check_out, adults, children,
            currency, total_amount_minor, tax_basis,
            observed_date, observation_slot, stay_dow_bucket, stay_season_band,
            match_method, match_confidence, comparability_class
        )
        SELECT '2026-08-14T11:00:00Z', s.id, h.id, rt.id, rp.id,
               DATE '2026-09-18', 3, DATE '2026-09-25', 2, 0,   -- inconsistent
               'USD', 206700, 'GROSS',
               DATE '2026-08-14', '2026-08-14T11:00:00Z', 'WEEKDAY', 'SHOULDER',
               'SOURCE_ID', 1.00, 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC'
        FROM hotel h, source s, room_type rt, rate_plan rp
        WHERE h.wah_hotel_id = '2962' AND s.code = 'TEST_SRC'
          AND rt.normalized_name = 'ocean view king' AND rp.source_plan_code = 'BB-FLEX';
        RAISE EXCEPTION 'CHECK 5 FAILED: inconsistent check_out was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'CHECK 5  ok — inconsistent check_out rejected';
    END;
END $$;

-- Check 6 · the never-WAIT rule, enforced by the database ---------------------
DO $$
DECLARE hid BIGINT;
BEGIN
    SELECT id INTO hid FROM hotel WHERE wah_hotel_id = '2962';
    BEGIN
        INSERT INTO analysis (
            public_id, hotel_id, comparability_class, check_in, nights, adults, children,
            currency, current_nightly_minor, current_total_minor, rate_observed_at,
            deal_score, deal_score_band, confidence, confidence_band, recommendation,
            gate_fired, baseline_level, n_observations, config_version, engine_version,
            decision_trace, explanation_bundle
        ) VALUES (
            'an_bad', hid, 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC', DATE '2026-09-18', 3, 2, 0,
            'USD', 68900, 206700, now(),
            30, 'BELOW_AVERAGE', 65, 'MODERATE', 'WAIT',   -- confidence below the floor
            'G4', 'L0', 40, 1, '1.0.0', '{}'::jsonb, '{}'::jsonb
        );
        RAISE EXCEPTION 'CHECK 6 FAILED: WAIT at confidence 65 was accepted by the database';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'CHECK 6  ok — WAIT below the confidence floor rejected (third enforcement layer)';
    END;
END $$;

-- Check 7 · INSUFFICIENT_DATA must carry a null score ------------------------
DO $$
DECLARE hid BIGINT;
BEGIN
    SELECT id INTO hid FROM hotel WHERE wah_hotel_id = '2962';
    BEGIN
        INSERT INTO analysis (
            public_id, hotel_id, comparability_class, check_in, nights, adults, children,
            currency, current_nightly_minor, current_total_minor, rate_observed_at,
            deal_score, confidence, confidence_band, recommendation,
            gate_fired, baseline_level, n_observations, config_version, engine_version,
            decision_trace, explanation_bundle
        ) VALUES (
            'an_bad2', hid, 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC', DATE '2026-09-18', 3, 2, 0,
            'USD', 68900, 206700, now(),
            0, 30, 'INSUFFICIENT', 'INSUFFICIENT_DATA',   -- a zero score, not null
            'G0', 'L3', 7, 1, '1.0.0', '{}'::jsonb, '{}'::jsonb
        );
        RAISE EXCEPTION 'CHECK 7 FAILED: INSUFFICIENT_DATA with a 0 score was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'CHECK 7  ok — INSUFFICIENT_DATA cannot carry a numeric score';
    END;
END $$;

-- Check 8 · only one active scoring config ------------------------------------
DO $$
BEGIN
    BEGIN
        INSERT INTO scoring_config (version, config, is_active) VALUES (2, '{}'::jsonb, true);
        RAISE EXCEPTION 'CHECK 8 FAILED: a second active config was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'CHECK 8  ok — exactly one scoring config can be active';
    END;
END $$;

-- Check 9 · the seeded config is present and well-formed ----------------------
DO $$
DECLARE w NUMERIC;
BEGIN
    SELECT (config->'score'->'weight'->>'f1Historical')::numeric
      + (config->'score'->'weight'->>'f2Market')::numeric
      + (config->'score'->'weight'->>'f3Trend')::numeric
      + (config->'score'->'weight'->>'f4Seasonality')::numeric
      + (config->'score'->'weight'->>'f5Demand')::numeric
      + (config->'score'->'weight'->>'f6Value')::numeric
    INTO w FROM scoring_config WHERE is_active;
    IF w IS NULL OR abs(w - 1) > 1e-9 THEN
        RAISE EXCEPTION 'CHECK 9 FAILED: seeded deal-score weights sum to % (expected 1.0)', w;
    END IF;
    RAISE NOTICE 'CHECK 9  ok — seeded config weights sum to 1.0';
END $$;

ROLLBACK;
