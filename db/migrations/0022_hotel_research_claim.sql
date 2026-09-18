-- 0022 — what we read on a hotel's own website, and where we read it.
--
-- Owner requirement (2026-09-18): assess each travel motivator from live
-- information, not only from static hotel data.
--
-- ── Why this table stores a FETCH rather than a search result ────────────
--
-- Brave finds the page; we fetch the page ourselves and store what WE read.
-- Two reasons, and both are load-bearing.
--
-- Terms: Brave restricts retaining API results — "if you would like to store
-- the API results in part or whole, you will need to subscribe to a plan that
-- explicitly grants storage rights". A row here is our own reading of a page
-- at a URL, which is the same thing migration 0016 already does with
-- whatahotel.com's hotel pages (rule 24).
--
-- Evidence: a hotel's own site is a better source than an aggregator's
-- snippet, and it is the merchant speaking about itself. When the widget says
-- a property has a spa, the citation should be the property saying so.
--
-- ── What a row is, and is not ───────────────────────────────────────────
--
-- It is: one motivator, one claim, the URL it came from, and when we read it.
-- Nothing here is a model's recollection — a claim exists only because a page
-- we fetched contained the evidence for it, which is what separates this from
-- the failure rule 30 caught, where a documented field looked like evidence
-- and was a constant across every hotel.
--
-- It is NOT a fact table for scoring. Nothing under packages/core/src/scoring
-- may read it, for rule 21's reason: it would be an uncalibrated term nobody
-- reviewed. It informs what a guest reads about a property, never the number.
--
-- source_url is NOT NULL on purpose. A claim without a citation is exactly
-- the thing this whole layer exists to prevent, so the schema refuses it
-- rather than trusting every writer to remember.
CREATE TABLE IF NOT EXISTS hotel_research_claim (
  hotel_id    int         NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
  motivator   text        NOT NULL,
  claim       text        NOT NULL CHECK (length(btrim(claim)) > 0),
  source_url  text        NOT NULL CHECK (source_url ~ '^https?://'),
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hotel_id, motivator, claim)
);

-- The serving path reads every claim for one hotel; the sweep asks which
-- hotels are stale. Both are covered here.
CREATE INDEX IF NOT EXISTS hotel_research_claim_freshness_idx
  ON hotel_research_claim (hotel_id, fetched_at DESC);

COMMENT ON TABLE hotel_research_claim IS
  'Evidence read from a hotel''s own website, with its URL and read time. Informs what a guest reads, never a score.';

-- Where the research found the property's own site, so the next run does not
-- spend a search resolving it again. NULL means unresolved, never "no site".
ALTER TABLE hotel
  ADD COLUMN IF NOT EXISTS website_url       text,
  ADD COLUMN IF NOT EXISTS researched_at     timestamptz;

COMMENT ON COLUMN hotel.website_url IS
  'The property''s own site, resolved once via search. NULL means not resolved yet, never "has none".';
COMMENT ON COLUMN hotel.researched_at IS
  'When motivator research last completed for this hotel, successful or not, so a dead hotel backs off.';
