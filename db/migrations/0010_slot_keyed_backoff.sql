-- 0010 · Key collection backoff by grid slot, not calendar date.
--
-- The failure this fixes appeared only after the grid learned to roll: a
-- stay's wanted date shifts forward one day per day, so a stay that never
-- prices got a FRESH primary key every UTC day. Its failure counter maxed out
-- at ~4 (four runs a day) and then restarted, while escaping the 6-hour cron
-- requires 6 consecutive failures. The counter could never get there, so the
-- backoff never engaged across days. Measured 2026-08-20: hotel 3561
-- re-proposed its entire 46-stay grid daily and hotel 3554 added ~46 more —
-- ~540 wasted calls a day, indefinitely, against an API whose rate limit is
-- still unknown (U15).
--
-- The durable identity of a grid stay is its SLOT — (hotel, lead_days,
-- nights, adults) — not its date. This is the same insight as the ±1 day
-- coverage tolerance, applied to the failure ledger: coverage learned to move
-- with the grid; the ledger must too, or its memory dies of key drift.
--
-- `check_in` survives as a data column meaning "the date last attempted".
-- Two readers depend on it: the runbook's diagnostic query, and
-- `findMarketCompression`, which counts a comp as sold out when an attempt at
-- the EXACT stay date recorded NO_AVAILABILITY. Under slot keying that
-- evidence expires naturally when the slot is re-attempted at a newer date —
-- an improvement, not a loss: the old per-date rows had no freshness bound at
-- all, so a weeks-old sold-out could count as live scarcity forever.
--
-- Rows written by tracked-stay refreshes scatter across slots as their lead
-- shrinks day by day. Those rows are inert — a slot covered by observations
-- is never consulted for backoff — diagnostic noise, not behaviour.

-- Past dates can never be re-proposed (the grid's minimum lead is 3 days),
-- and negative leads would collide with nothing meaningful. Drop them.
DELETE FROM collection_attempt WHERE check_in < CURRENT_DATE;

ALTER TABLE collection_attempt ADD COLUMN lead_days SMALLINT;
UPDATE collection_attempt SET lead_days = (check_in - CURRENT_DATE)::smallint;

-- The pre-fix rollover storms left several dates sharing a slot. Keep the row
-- with the most failures (ties: the freshest), so live backoff state carries
-- over instead of unleashing a one-day retry burst.
DELETE FROM collection_attempt a
 USING collection_attempt b
 WHERE a.hotel_id = b.hotel_id
   AND a.lead_days = b.lead_days
   AND a.nights = b.nights
   AND a.adults = b.adults
   AND (a.consecutive_failures, a.last_attempt_at, a.check_in)
     < (b.consecutive_failures, b.last_attempt_at, b.check_in);

ALTER TABLE collection_attempt ALTER COLUMN lead_days SET NOT NULL;
ALTER TABLE collection_attempt DROP CONSTRAINT collection_attempt_pkey;
ALTER TABLE collection_attempt ADD PRIMARY KEY (hotel_id, lead_days, nights, adults);

COMMENT ON COLUMN collection_attempt.lead_days IS
  'Grid slot: days from today at the time of the attempt. The stable identity a rolling wanted date cannot provide.';
COMMENT ON COLUMN collection_attempt.check_in IS
  'The date last attempted for this slot. Data, not identity — advances as the grid rolls.';
