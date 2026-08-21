-- Schema behaviour checks.
--
-- These verify the guarantees the schema is supposed to provide, not just that
-- the DDL parses:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/checks/schema_checks.sql
--
-- Every check RAISEs on failure, so a non-zero exit means a real regression.
--
-- Safe to run against a database that already holds data. Every fixture is
-- namespaced (source TEST_SRC, hotel CHECK-2962, destination
-- check-2962-destination) and every assertion is scoped to those fixtures. The earlier version counted whole tables and read
-- `FROM rate_observation LIMIT 1`, which silently asserted against an
-- arbitrary real row once the first rates were collected. The whole run is
-- wrapped in a transaction that ends in ROLLBACK, so nothing is left behind.

BEGIN;

-- Fixtures ------------------------------------------------------------------
INSERT INTO source (code, display_name, is_authoritative)
VALUES ('TEST_SRC', 'Test source', true);

-- Namespaced like every other fixture here. It used to be slug 'miami-beach',
-- which collides with the real destination as soon as the catalogue is synced —
-- so the whole file aborted on `duplicate key value violates unique constraint
-- "destination_slug_key"` against exactly the databases it most needs to verify.
INSERT INTO destination (slug, name, country_code)
VALUES ('check-2962-destination', 'Check Fixture Destination', 'US');

INSERT INTO hotel (wah_hotel_id, name, destination_id, luxury_tier)
SELECT 'CHECK-2962', 'Test Hotel', id, 5
  FROM destination WHERE slug = 'check-2962-destination';

INSERT INTO room_type (hotel_id, canonical_name, normalized_name, room_class, bed_config, view_type)
SELECT id, 'Ocean View King', 'ocean view king', 'ROOM', 'KING', 'OCEAN' FROM hotel WHERE wah_hotel_id = 'CHECK-2962';

INSERT INTO room_type (hotel_id, canonical_name, normalized_name, room_class, bed_config, view_type)
SELECT id, 'Ocean View King Suite', 'ocean view king suite', 'SUITE', 'KING', 'OCEAN' FROM hotel WHERE wah_hotel_id = 'CHECK-2962';

INSERT INTO rate_plan (hotel_id, source_id, source_plan_code, meal_plan, refund_policy, audience, comparability_class)
SELECT h.id, s.id, 'BB-FLEX', 'BREAKFAST', 'REFUNDABLE', 'PUBLIC', 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC'
FROM hotel h, source s WHERE h.wah_hotel_id = 'CHECK-2962' AND s.code = 'TEST_SRC';

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
WHERE h.wah_hotel_id = 'CHECK-2962' AND s.code = 'TEST_SRC'
  AND rt.hotel_id = h.id AND rt.normalized_name = 'ocean view king'
  AND rp.hotel_id = h.id AND rp.source_plan_code = 'BB-FLEX';

DO $$
DECLARE nightly BIGINT; lead INT;
BEGIN
    SELECT o.nightly_amount_minor, o.lead_time_days INTO nightly, lead
      FROM rate_observation o JOIN source s ON s.id = o.source_id
     WHERE s.code = 'TEST_SRC';
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
WHERE h.wah_hotel_id = 'CHECK-2962' AND s.code = 'TEST_SRC'
  AND rt.hotel_id = h.id AND rt.normalized_name = 'ocean view king'
  AND rp.hotel_id = h.id AND rp.source_plan_code = 'BB-FLEX'
ON CONFLICT DO NOTHING;

DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM rate_observation o
      JOIN source s ON s.id = o.source_id WHERE s.code = 'TEST_SRC';
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
WHERE h.wah_hotel_id = 'CHECK-2962' AND s.code = 'TEST_SRC'
  AND rt.hotel_id = h.id AND rt.normalized_name = 'ocean view king'
  AND rp.hotel_id = h.id AND rp.source_plan_code = 'BB-FLEX'
ON CONFLICT DO NOTHING;

DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM rate_observation o
      JOIN source s ON s.id = o.source_id WHERE s.code = 'TEST_SRC';
    IF n <> 2 THEN RAISE EXCEPTION 'CHECK 3 FAILED: % rows (expected 2)', n; END IF;
    RAISE NOTICE 'CHECK 3  ok — a new slot records a new observation';
END $$;

-- Check 4 · partition routing ------------------------------------------------
DO $$
DECLARE n INT;
BEGIN
    SELECT count(*) INTO n FROM rate_observation_2026_08 o
      JOIN source s ON s.id = o.source_id WHERE s.code = 'TEST_SRC';
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
        WHERE h.wah_hotel_id = 'CHECK-2962' AND s.code = 'TEST_SRC'
          AND rt.normalized_name = 'ocean view king' AND rp.source_plan_code = 'BB-FLEX';
        RAISE EXCEPTION 'CHECK 5 FAILED: inconsistent check_out was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'CHECK 5  ok — inconsistent check_out rejected';
    END;
END $$;

-- Check 6 · WAIT is refused outright ------------------------------------------
--
-- This used to assert the confidence floor: WAIT below 70 was rejected. WAIT was
-- retired in config v4, so the constraint is now flat — the row below carries a
-- confidence of 95, which the old rule would have accepted.
DO $$
DECLARE hid BIGINT;
BEGIN
    SELECT id INTO hid FROM hotel WHERE wah_hotel_id = 'CHECK-2962';
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
            30, 'BELOW_AVERAGE', 95, 'HIGH', 'WAIT',   -- retired: no confidence saves it
            'G5', 'L0', 40, 1, '1.0.0', '{}'::jsonb, '{}'::jsonb
        );
        RAISE EXCEPTION 'CHECK 6 FAILED: WAIT at confidence 95 was accepted by the database';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'CHECK 6  ok — WAIT rejected outright (retired in config v4)';
    END;
END $$;

-- Check 7 · INSUFFICIENT_DATA must carry a null score ------------------------
DO $$
DECLARE hid BIGINT;
BEGIN
    SELECT id INTO hid FROM hotel WHERE wah_hotel_id = 'CHECK-2962';
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
        -- A version far outside the real range, so this check does not collide
        -- with whatever version the seed happens to be on.
        INSERT INTO scoring_config (version, config, is_active) VALUES (9999, '{}'::jsonb, true);
        RAISE EXCEPTION 'CHECK 8 FAILED: a second active config was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'CHECK 8  ok — exactly one scoring config can be active';
    END;
END $$;

-- Check 9 · the seeded config is present and well-formed ----------------------
DO $$
DECLARE w NUMERIC; n INT;
BEGIN
    -- Enumerate the weight object rather than naming keys: the factor set is
    -- not fixed (F5 was removed in v2), and a hardcoded list silently returns
    -- NULL when a key disappears instead of failing loudly.
    SELECT sum(value::numeric), count(*)
      INTO w, n
      FROM scoring_config sc, jsonb_each_text(sc.config->'score'->'weight')
     WHERE sc.is_active;

    IF n IS NULL OR n = 0 THEN
        RAISE EXCEPTION 'CHECK 9 FAILED: no active scoring config with weights';
    END IF;
    IF w IS NULL OR abs(w - 1) > 1e-9 THEN
        RAISE EXCEPTION 'CHECK 9 FAILED: % deal-score weights sum to % (expected 1.0)', n, w;
    END IF;
    RAISE NOTICE 'CHECK 9  ok — % seeded config weights sum to 1.0', n;
END $$;

-- Check 10 · the partition horizon stays ahead of the data --------------------
--
-- 0003 shipped partitions for three fixed months and a DEFAULT. Because DEFAULT
-- accepts anything, running past the last real partition is SILENT: collection
-- keeps reporting healthy while every new observation piles into one unpruned
-- heap — and those rows then block the partition that should have held them.
-- This asserts the horizon, so the failure surfaces here rather than in an
-- incident months later.
DO $$
DECLARE
    horizon date;
    months  int;
BEGIN
    SELECT max(upper(r)::date) INTO horizon
      FROM (
        SELECT ('[' || split_part(substr(pg_get_expr(c.relpartbound, c.oid),
                                         strpos(pg_get_expr(c.relpartbound, c.oid), '(') + 1),
                                  '''', 2) || ',' ||
                       split_part(substr(pg_get_expr(c.relpartbound, c.oid),
                                         strpos(pg_get_expr(c.relpartbound, c.oid), 'TO')),
                                  '''', 2) || ')')::daterange AS r
          FROM pg_class c
          JOIN pg_inherits i ON i.inhrelid = c.oid
         WHERE i.inhparent = 'rate_observation'::regclass
           AND c.relpartbound IS NOT NULL
           AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
      ) bounds;

    IF horizon IS NULL THEN
        RAISE EXCEPTION 'CHECK 10 FAILED: rate_observation has no explicit partitions';
    END IF;

    months := (EXTRACT(YEAR FROM age(horizon, CURRENT_DATE)) * 12
               + EXTRACT(MONTH FROM age(horizon, CURRENT_DATE)))::int;

    IF months < 3 THEN
        RAISE EXCEPTION
            'CHECK 10 FAILED: partitions run out on % — only % month(s) ahead. '
            'Run scripts/migrate.mjs, which calls ensure_rate_observation_partitions().',
            horizon, months;
    END IF;
    RAISE NOTICE 'CHECK 10 ok — partitions cover to % (% months ahead)', horizon, months;
END $$;

-- Check 11 · nothing is stranded in the DEFAULT partition ----------------------
--
-- A non-empty DEFAULT means the horizon was already missed at least once. The
-- data is not lost, but it is unpartitioned and it blocks the repair, so this
-- is a warning that must not stay unread.
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM rate_observation_default;
    IF n > 0 THEN
        RAISE EXCEPTION
            'CHECK 11 FAILED: % row(s) stranded in rate_observation_default. '
            'ensure_rate_observation_partitions() moves them; run scripts/migrate.mjs.', n;
    END IF;
    RAISE NOTICE 'CHECK 11 ok — DEFAULT partition is empty';
END $$;

-- Check 12 · ADR excludes taxes and fees ----------------------------------------
--
-- The acceptance case, encoded where it cannot drift: base room rates of
-- $300 + $320 + $280 = $900 over 3 nights, with taxes and fees bringing the
-- grand total to $1,050. ADR must be $300/night, NOT $350 — the widget sits
-- beside whatahotel.com's own prices and has to quote a night the same way.
--
-- The second row is the no-stated-tax path: a source that gives no split means
-- the total IS the base rate, which must round-trip rather than be discarded.
DO $$
DECLARE taxed BIGINT; untaxed BIGINT; hid BIGINT; sid BIGINT; rtid BIGINT; rpid BIGINT;
BEGIN
    SELECT h.id, s.id, rt.id, rp.id INTO hid, sid, rtid, rpid
      FROM hotel h, source s, room_type rt, rate_plan rp
     WHERE h.wah_hotel_id = 'CHECK-2962' AND s.code = 'TEST_SRC'
       AND rt.hotel_id = h.id AND rt.normalized_name = 'ocean view king'
       AND rp.hotel_id = h.id AND rp.source_plan_code = 'BB-FLEX';

    INSERT INTO rate_observation (
        observed_at, source_id, hotel_id, room_type_id, rate_plan_id,
        check_in, nights, check_out, adults, children,
        currency, total_amount_minor, taxes_fees_minor, tax_basis,
        observed_date, observation_slot, stay_dow_bucket, stay_season_band,
        match_method, match_confidence, comparability_class
    ) VALUES
      ('2026-08-14T11:00:00Z', sid, hid, rtid, rpid,
       DATE '2026-10-05', 3, DATE '2026-10-08', 2, 0,
       'USD', 105000, 15000, 'GROSS',
       DATE '2026-08-14', '2026-08-14T11:00:00Z', 'WEEKDAY', 'SHOULDER',
       'SOURCE_ID', 1.00, 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC'),
      ('2026-08-14T11:00:00Z', sid, hid, rtid, rpid,
       DATE '2026-10-12', 3, DATE '2026-10-15', 2, 0,
       'USD', 90000, NULL, 'NET',
       DATE '2026-08-14', '2026-08-14T11:00:00Z', 'WEEKDAY', 'SHOULDER',
       'SOURCE_ID', 1.00, 'BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC');

    SELECT nightly_amount_minor INTO taxed
      FROM rate_observation WHERE hotel_id = hid AND check_in = DATE '2026-10-05';
    SELECT nightly_amount_minor INTO untaxed
      FROM rate_observation WHERE hotel_id = hid AND check_in = DATE '2026-10-12';

    IF taxed <> 30000 THEN
        RAISE EXCEPTION
            'CHECK 12a FAILED: ADR = % (expected 30000 — $300 base, not $350 gross)', taxed;
    END IF;
    IF untaxed <> 30000 THEN
        RAISE EXCEPTION
            'CHECK 12b FAILED: ADR with no stated tax split = % (expected 30000)', untaxed;
    END IF;
    RAISE NOTICE 'CHECK 12 ok — ADR excludes taxes and fees ($300/night, not $350)';
END $$;

-- Check 13 · a guest rating is bounded, or refused --------------------------
--
-- The reputation columns (migration 0013) hold a number a customer reads as a
-- statement about a real property. A 46 stored where 4.6 was meant would
-- render as a five-star hotel rated 46, and a negative review count would
-- render as evidence that does not exist. Both are refused at the schema, not
-- merely filtered in a client — there is more than one writer over time, and
-- the guarantee has to outlive whichever one forgets.
DO $$
DECLARE hid BIGINT;
BEGIN
    SELECT id INTO hid FROM hotel WHERE wah_hotel_id = 'CHECK-2962';

    -- 9.9 fits NUMERIC(2,1) and fails the range CHECK; 46 fails the precision
    -- first. Both are refusals and both matter — a decimal-point slip lands on
    -- one or the other depending on the digit — so both are asserted, and the
    -- handler names both codes rather than assuming which fires.
    BEGIN
        UPDATE hotel SET google_rating = 9.9 WHERE id = hid;
        RAISE EXCEPTION 'CHECK 13a FAILED: a rating of 9.9 was accepted';
    EXCEPTION WHEN check_violation OR numeric_value_out_of_range THEN
        RAISE NOTICE 'CHECK 13a ok — a rating outside 0-5 is refused';
    END;

    BEGIN
        UPDATE hotel SET google_rating = 46 WHERE id = hid;
        RAISE EXCEPTION 'CHECK 13b FAILED: a rating of 46 was accepted';
    EXCEPTION WHEN check_violation OR numeric_value_out_of_range THEN
        RAISE NOTICE 'CHECK 13b ok — a misplaced decimal point is refused';
    END;

    BEGIN
        UPDATE hotel SET google_user_rating_count = -1 WHERE id = hid;
        RAISE EXCEPTION 'CHECK 13c FAILED: a negative review count was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'CHECK 13c ok — a negative review count is refused';
    END;

    UPDATE hotel
       SET google_rating = 4.6, google_user_rating_count = 3241,
           google_match_status = 'VERIFIED'
     WHERE id = hid;
    RAISE NOTICE 'CHECK 13  ok — a real rating stores unchanged';
END $$;

ROLLBACK;
