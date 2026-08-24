-- 0015 — Daily partitions, and retention that actually returns space.
--
-- Context: the production database lives on Neon's free tier, which caps the
-- PROJECT at 512 MB. When observations filled it (2026-08-23), every write
-- failed and every stay scored nothing. The critical operational fact learned
-- from that incident: Neon's project-size counter only goes DOWN when files
-- are removed — TRUNCATE or DROP TABLE. DELETE + VACUUM makes pages reusable
-- inside a file but never shrinks the file, and UPDATE only adds tuple
-- versions. So retention that works on this platform must DROP whole
-- partitions, and a partition must therefore be small enough that dropping
-- one is an acceptable increment of loss.
--
-- A monthly partition is not: at the measured write rate (~30 MB/day with
-- slimmed raw payloads) one month is ~1 GB — twice the entire allowance
-- before it could ever be dropped. Hence DAILY partitions: the working set
-- stays at retain_days + the forward window, the counter falls every day a
-- partition ages out, and a full-project incident self-heals on the next
-- collection run, because DROP needs no free space.
--
-- What retention costs, stated honestly: observations older than the window
-- are GONE. Baseline rollups persist (they are separate tables and carry the
-- accrued history), stored analyses persist, and the live model reads only
-- recent rates — but the history model's same-stay series is capped at the
-- window, and M7 calibration replay cannot reach past it. That is the price
-- of the free tier; a paid plan can simply not set the retention env and
-- keep everything.
--
-- Retention does NOT run by itself. enforce_rate_observation_retention() is
-- called by scripts/migrate.mjs only when RATE_OBSERVATION_RETAIN_DAYS is
-- set — production's collect workflow sets it; a developer database never
-- does, so seeded 90-day history survives local migrate runs.

-- ── 1 · Retire the monthly partitions ───────────────────────────────────────
--
-- Daily partitions cannot coexist with monthly ones covering the same range,
-- so the monthly partitions from 0003 must go. They are dropped ONLY if
-- empty: in production the squeeze (scripts/db-maintain.mjs --squeeze)
-- truncates first, and a fresh database migrates before it holds data. A
-- populated development database fails here on purpose — run `npm run
-- db:reset`; its contents are synthetic by rule 7.
DO $$
DECLARE
    part text;
    n    bigint;
BEGIN
    FOR part IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_inherits i ON i.inhrelid = c.oid
         WHERE i.inhparent = 'rate_observation'::regclass
           AND c.relname ~ '^rate_observation_\d{4}_\d{2}$'  -- monthly only
    LOOP
        EXECUTE format('SELECT count(*) FROM %I', part) INTO n;
        IF n > 0 THEN
            RAISE EXCEPTION
                'monthly partition % still holds % row(s). On production, run the '
                'database-maintenance workflow with confirm=squeeze first (it '
                'truncates, then migrates). On a development database, run '
                'npm run db:reset — its data is synthetic.', part, n;
        END IF;
        EXECUTE format('DROP TABLE %I', part);
    END LOOP;
END $$;

-- ── 2 · The partition maintainer, now daily ─────────────────────────────────
--
-- Same contract as the 0009 version it replaces, at day granularity: keep a
-- window of partitions around today, and rescue anything stranded in DEFAULT
-- while doing so. Parameter names change, so the old function is dropped
-- rather than replaced (CREATE OR REPLACE refuses a parameter rename).
DROP FUNCTION IF EXISTS ensure_rate_observation_partitions(integer, integer);

CREATE FUNCTION ensure_rate_observation_partitions(
    days_ahead integer DEFAULT 14,
    days_back  integer DEFAULT 2
)
RETURNS TABLE (partition_name text, action text)
LANGUAGE plpgsql
AS $$
DECLARE
    day_start date;
    day_end   date;
    part      text;
    rescued   bigint;
    col_list  text;
BEGIN
    IF days_ahead < 0 OR days_back < 0 THEN
        RAISE EXCEPTION 'day bounds must not be negative (got % ahead, % back)',
            days_ahead, days_back;
    END IF;

    -- The default back window is deliberately SHORT, unlike 0009's: under
    -- retention, backward partitions the production database will never fill
    -- would be created on every run and dropped again on the next — churn
    -- with no data behind it. Callers that genuinely write history widen the
    -- window themselves: scripts/seed-dev.mjs fabricates 90 days and asks for
    -- 100 back; db/checks/schema_checks.sql covers its fixed fixture dates.
    FOR i IN -days_back..days_ahead LOOP
        day_start := (now() AT TIME ZONE 'UTC')::date + i;
        day_end   := day_start + 1;
        part      := format('rate_observation_%s', to_char(day_start, 'YYYY_MM_DD'));

        IF EXISTS (
            SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = part AND n.nspname = current_schema()
        ) THEN
            CONTINUE;
        END IF;

        SELECT count(*) INTO rescued
          FROM rate_observation_default
         WHERE observation_slot >= day_start AND observation_slot < day_end;

        IF rescued = 0 THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF rate_observation FOR VALUES FROM (%L) TO (%L)',
                part, day_start, day_end
            );
            partition_name := part;
            action := 'created';
        ELSE
            -- The repair path, unchanged from 0009: rows already in DEFAULT
            -- block a plain CREATE ... PARTITION OF, so build detached, move,
            -- attach — one transaction. Explicit column list because `id` is
            -- GENERATED ALWAYS AS IDENTITY and two amount columns are STORED
            -- generated; identity values are carried across so ingest logs
            -- keep pointing at the rows they describe.
            EXECUTE format('CREATE TABLE %I (LIKE rate_observation INCLUDING ALL)', part);

            SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
              INTO col_list
              FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = 'rate_observation'
               AND is_generated = 'NEVER';

            EXECUTE format(
                'WITH moved AS (
                   DELETE FROM rate_observation_default
                    WHERE observation_slot >= %L AND observation_slot < %L
                    RETURNING *
                 )
                 INSERT INTO %I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM moved',
                day_start, day_end, part, col_list, col_list
            );
            EXECUTE format(
                'ALTER TABLE rate_observation ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
                part, day_start, day_end
            );
            partition_name := part;
            action := format('created, %s row(s) recovered from DEFAULT', rescued);
        END IF;

        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION ensure_rate_observation_partitions(integer, integer) IS
    'Creates missing daily rate_observation partitions across a window around '
    'today, recovering any rows already stranded in DEFAULT. Idempotent. '
    'Called by scripts/migrate.mjs on every run.';

-- ── 3 · Retention, as partition drops ───────────────────────────────────────
CREATE FUNCTION enforce_rate_observation_retention(retain_days integer)
RETURNS TABLE (partition_name text, action text)
LANGUAGE plpgsql
AS $$
DECLARE
    cutoff date;
    part   record;
BEGIN
    -- The live model scores from recent rates; dropping yesterday would score
    -- from nothing. The floor is a guard against a typo'd env value, not a
    -- recommendation — production runs well above it.
    IF retain_days < 2 THEN
        RAISE EXCEPTION 'retain_days must be at least 2 (got %)', retain_days;
    END IF;

    cutoff := (now() AT TIME ZONE 'UTC')::date - retain_days;

    -- A partition is dropped only when its ENTIRE range is older than the
    -- cutoff (upper bound is exclusive, so <= means every row inside is
    -- strictly older). Bounds are parsed the same way schema check 10 parses
    -- them. DEFAULT is never dropped. Works on monthly leftovers and daily
    -- partitions alike, so a database mid-transition converges too.
    FOR part IN
        SELECT c.relname,
               split_part(substr(pg_get_expr(c.relpartbound, c.oid),
                                 strpos(pg_get_expr(c.relpartbound, c.oid), 'TO')),
                          '''', 2) AS upper_text
          FROM pg_class c
          JOIN pg_inherits i ON i.inhrelid = c.oid
         WHERE i.inhparent = 'rate_observation'::regclass
           AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
    LOOP
        IF part.upper_text::date <= cutoff THEN
            EXECUTE format('DROP TABLE %I', part.relname);
            partition_name := part.relname;
            action := format('dropped — every row predates %s', cutoff);
            RETURN NEXT;
        END IF;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION enforce_rate_observation_retention(integer) IS
    'Drops rate_observation partitions whose entire range is older than '
    'retain_days. DROP is the only operation that lowers Neon''s project-size '
    'counter, so this IS the free-tier space budget. Called by '
    'scripts/migrate.mjs only when RATE_OBSERVATION_RETAIN_DAYS is set.';

-- Bring this database up to date now.
SELECT * FROM ensure_rate_observation_partitions();
