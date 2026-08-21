-- Google Places: the mapping, the cached reputation, and how much we trust it.
--
-- Reputation is an INTELLIGENCE SIGNAL, never a term in the score. It informs
-- the premium-justification reasoning and it is shown to the guest as a fact
-- about the property; it does not move the Comp-Set Index, the Calendar Delta
-- or the Market Compression. A 4.9 from 32 reviews is not stronger evidence
-- than a 4.7 from 4,500, and a score cannot make that distinction — a reader
-- can, which is why both numbers travel together everywhere.
--
-- ── Why the Place ID is stored rather than searched per request ────────────
--
-- Text Search is a paid call and a guess. Resolving a hotel to a place once,
-- recording HOW confident that resolution was, and reusing it is both cheaper
-- and more honest: a doubtful match stays doubtful instead of being re-rolled
-- on every page view until it happens to look right.
--
-- ── The match status is load-bearing ──────────────────────────────────────
--
--   VERIFIED    name, city and coordinates agree — safe to use.
--   UNVERIFIED  a candidate exists but does not agree well enough. Its data is
--               NEVER used or displayed. Kept so we do not pay to rediscover
--               the same doubtful candidate every refresh.
--   NO_MATCH    Google returned nothing plausible.
--   (NULL)      never looked.
--
-- Only VERIFIED rows may reach a guest. Everything else is absent, and absent
-- is rendered as absent — never as a zero rating, which would libel the hotel.

CREATE TYPE google_match_status_t AS ENUM ('VERIFIED', 'UNVERIFIED', 'NO_MATCH');

ALTER TABLE hotel
    ADD COLUMN IF NOT EXISTS google_place_id           TEXT,
    ADD COLUMN IF NOT EXISTS google_match_status       google_match_status_t,
    -- 0..1. How well name/city/geo agreed. Recorded so a threshold change can
    -- be re-applied to what we already hold instead of re-querying Google.
    ADD COLUMN IF NOT EXISTS google_match_confidence   NUMERIC(3,2)
        CHECK (google_match_confidence BETWEEN 0 AND 1),
    ADD COLUMN IF NOT EXISTS google_rating             NUMERIC(2,1)
        CHECK (google_rating BETWEEN 0 AND 5),
    ADD COLUMN IF NOT EXISTS google_user_rating_count  INTEGER
        CHECK (google_user_rating_count >= 0),
    ADD COLUMN IF NOT EXISTS google_display_name       TEXT,
    ADD COLUMN IF NOT EXISTS google_formatted_address  TEXT,
    -- Google's own link, kept as returned. Constructing a maps URL ourselves
    -- would be an unofficial URL we are not entitled to assume stays valid.
    ADD COLUMN IF NOT EXISTS google_maps_uri           TEXT,
    ADD COLUMN IF NOT EXISTS google_fetched_at         TIMESTAMPTZ;

COMMENT ON COLUMN hotel.google_match_status IS
    'VERIFIED = safe to use and display. UNVERIFIED/NO_MATCH = never shown, '
    'kept only to avoid paying to rediscover the same doubtful candidate.';
COMMENT ON COLUMN hotel.google_rating IS
    'Reputation signal for the reasoning layer and for display. NEVER a term '
    'in the deterministic score. Always read beside google_user_rating_count.';

-- The refresh sweep asks "which VERIFIED hotels are stalest": a partial index
-- on exactly that question.
CREATE INDEX IF NOT EXISTS hotel_google_refresh_idx
    ON hotel (google_fetched_at NULLS FIRST)
    WHERE is_active AND google_match_status = 'VERIFIED';

-- And "which active hotels have never been looked up", for the discovery pass.
CREATE INDEX IF NOT EXISTS hotel_google_unresolved_idx
    ON hotel (id)
    WHERE is_active AND google_match_status IS NULL;
