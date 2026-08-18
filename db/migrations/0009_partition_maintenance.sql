-- Partitions that keep being created.
--
-- 0003 created rate_observation partitions for 2026-08, 2026-09 and 2026-10,
-- plus a DEFAULT. Nothing creates any more of them. From 2026-11-01 every
-- observation would land in DEFAULT — and because DEFAULT accepts anything,
-- collection would keep reporting healthy while the partitioning quietly
-- stopped doing its job.
--
-- Worse than the lost pruning: rows in DEFAULT BLOCK the partition that should
-- have held them. Postgres validates DEFAULT against a new partition's bounds
-- and refuses to create one whose range is already represented there, so the
-- longer it goes unnoticed the more painful the repair. `ensure_...` below
-- handles that case rather than leaving it to a future incident.
--
-- This runs from scripts/migrate.mjs on every invocation, which the collection
-- workflow calls on every run. Partitions therefore stay ahead of the data
-- without anyone remembering to do it.

CREATE OR REPLACE FUNCTION ensure_rate_observation_partitions(
    months_ahead integer DEFAULT 6,
    months_back  integer DEFAULT 4
)
RETURNS TABLE (partition_name text, action text)
LANGUAGE plpgsql
AS $$
DECLARE
    month_start date;
    month_end   date;
    part        text;
    rescued     bigint;
    col_list    text;
BEGIN
    IF months_ahead < 0 OR months_back < 0 THEN
        RAISE EXCEPTION 'month bounds must not be negative (got % ahead, % back)',
            months_ahead, months_back;
    END IF;

    -- Backwards as well as forwards. Collection only ever writes "now", so the
    -- forward window is what keeps it running — but anything that loads history
    -- writes older slots, and without backwards cover those strand in DEFAULT.
    -- scripts/seed-dev.mjs fabricates 90 days of it and put 44% of its rows
    -- there. The default of 4 months back covers the 90-day baseline lookback
    -- with a month to spare.
    FOR i IN -months_back..months_ahead LOOP
        month_start := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
        month_end   := (month_start + interval '1 month')::date;
        part        := format('rate_observation_%s', to_char(month_start, 'YYYY_MM'));

        IF EXISTS (
            SELECT 1 FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = part AND n.nspname = current_schema()
        ) THEN
            CONTINUE;
        END IF;

        SELECT count(*) INTO rescued
          FROM rate_observation_default
         WHERE observation_slot >= month_start AND observation_slot < month_end;

        IF rescued = 0 THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF rate_observation FOR VALUES FROM (%L) TO (%L)',
                part, month_start, month_end
            );
            partition_name := part;
            action := 'created';
        ELSE
            -- The repair path: rows already in DEFAULT belong to this range, so
            -- a plain CREATE ... PARTITION OF would be rejected outright
            -- ("updated partition constraint for default partition would be
            -- violated by some row"). Build the table detached, move the rows
            -- across, then attach. One transaction, so a failure anywhere leaves
            -- the observations where they were.
            EXECUTE format('CREATE TABLE %I (LIKE rate_observation INCLUDING ALL)', part);

            -- Explicit column list, not SELECT *: `id` is GENERATED ALWAYS AS
            -- IDENTITY and nightly_amount_minor / lead_time_days are STORED
            -- generated. A star-insert is rejected on all three. The identity
            -- value is carried across deliberately — an observation's id appears
            -- in ingest logs, so renumbering it during a repair would break the
            -- trail back to the batch that produced it.
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
                month_start, month_end, part, col_list, col_list
            );
            EXECUTE format(
                'ALTER TABLE rate_observation ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
                part, month_start, month_end
            );
            partition_name := part;
            action := format('created, %s row(s) recovered from DEFAULT', rescued);
        END IF;

        RETURN NEXT;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION ensure_rate_observation_partitions(integer, integer) IS
    'Creates missing monthly rate_observation partitions across a window around '
    'the current month, recovering any rows already stranded in DEFAULT. '
    'Idempotent. Called by scripts/migrate.mjs on every run.';

-- Bring this database up to date now, so the horizon is never shorter than the
-- gap between deployments.
SELECT * FROM ensure_rate_observation_partitions();
