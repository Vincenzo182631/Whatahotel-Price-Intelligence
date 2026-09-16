-- 0020 — what guests actually asked about.
--
-- The scheduler could not see demand. planCollection derives its work from
-- rate_observation (stays we already captured) and dates its "viewed" signal
-- from analysis (stays that produced a stored score), so the stays that most
-- need collecting were exactly the ones it could not see: a guest opens a
-- hotel page for dates nothing has collected, the live fetch fails — during
-- the source outage ~57% of rates calls fail at random — and the request
-- leaves NO trace anywhere the collector reads. The next guest on the same
-- page repeats the same failing fetch, forever.
--
-- This table is that trace. One row per stay a guest asked about, with a
-- count, so the collector can spend its patient settings (30s, 3 retries,
-- minutes to spend) on stays real people are looking at, ahead of them
-- arriving. Measured: repeated views of one stay climbed from 1 scored hotel
-- to 14 across a session, purely because each view stored what it fetched.
-- Warming moves that work off the guest's page view.
--
-- What it is NOT: a fact table. Nothing here reaches a baseline, a comp set or
-- a score — same standing as collection_attempt (rule 16). It decides what to
-- FETCH, never what anything is worth. And it holds no person: a hotel, dates
-- and an occupancy, with no identifier of who asked.
CREATE TABLE IF NOT EXISTS stay_request (
  hotel_id            int         NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
  check_in            date        NOT NULL,
  nights              smallint    NOT NULL CHECK (nights BETWEEN 1 AND 30),
  adults              smallint    NOT NULL CHECK (adults BETWEEN 1 AND 10),
  request_count       int         NOT NULL DEFAULT 1 CHECK (request_count > 0),
  first_requested_at  timestamptz NOT NULL DEFAULT now(),
  last_requested_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, check_in, nights, adults)
);

-- The planner's access path: recent demand, most-wanted first. Deliberately
-- NOT partial on "future stays": CURRENT_DATE is not immutable, so Postgres
-- cannot index on it, and a partial index on a fixed date would silently rot.
-- The planner filters past check-ins in its WHERE clause, and pruning removes
-- them outright.
CREATE INDEX IF NOT EXISTS stay_request_demand_idx
  ON stay_request (last_requested_at DESC, request_count DESC);

COMMENT ON TABLE stay_request IS
  'Stays guests asked about, so collection can warm them ahead of the next guest. Scheduling input only — never a fact, never a person.';
