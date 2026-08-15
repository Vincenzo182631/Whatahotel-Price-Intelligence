-- Collection attempts: what we TRIED to collect, not what we got.
--
-- Everything else in the schema records rates that exist. Nothing recorded an
-- attempt that produced none, and without that a scheduler cannot tell "never
-- tried" from "tried and this stay does not price".
--
-- The failure this fixes appeared only under a repeating job. The stay grid is
-- rebuilt from lead-time offsets on every run, so a stay the API refuses —
-- status 500 on a hotel/date combination, deterministically — is proposed
-- again on every single run, forever. Each proposal costs a call plus its
-- retries. Measured on the live set: 13 dead stays, ~52 wasted calls per run,
-- against an API whose rate limit is still unknown (U15).
--
-- A row here is NOT an observation and never enters a baseline. It exists so
-- the collector can back off.

CREATE TABLE collection_attempt (
    hotel_id             BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    check_in             DATE        NOT NULL,
    nights               SMALLINT    NOT NULL,
    adults               SMALLINT    NOT NULL,

    attempts             INTEGER     NOT NULL DEFAULT 0,
    -- Reset to 0 by any success, so a stay that starts working is picked back
    -- up immediately rather than staying in backoff.
    consecutive_failures INTEGER     NOT NULL DEFAULT 0,
    last_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_outcome         TEXT,

    PRIMARY KEY (hotel_id, check_in, nights, adults)
);

-- The collector's read path: "which of these stays am I still backing off?"
CREATE INDEX collection_attempt_backoff_idx
    ON collection_attempt (last_attempt_at)
 WHERE consecutive_failures > 0;
