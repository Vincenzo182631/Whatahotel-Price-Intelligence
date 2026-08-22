-- 0014 · What guests actually SAY, not only how many stars they leave.
--
-- Phase 6.X ("Why you might choose this hotel") interprets evidence, and a
-- bare 4.6 is thin evidence: it says guests are happy, not what they are
-- happy ABOUT. Google's Place Details carries two fields that do say:
-- `editorialSummary` (Google's own one-line description of the place) and
-- `reviews` (a sample of up to five). Both are fetched by the SWEEP — never
-- on a page view; the serving function still only reads this table — and
-- what is stored is deliberately less than what is fetched:
--
--   - the editorial summary verbatim (it is short and Google's own words),
--   - THEMES extracted from the review sample ("service", "beach", …), not
--     the review texts. Review prose is other people's writing; a theme tag
--     is a measurement over it. Extraction rules live in
--     packages/ingest/src/adapters/google/themes.ts, and only reviews rated
--     4+ contribute — a complaint that mentions the pool is not evidence
--     the pool is a strength.
--
-- The sample caveat is structural: Google returns at most five reviews, so
-- themes are "recent reviewers mention", never "guests say". Nothing here
-- enters any score.

ALTER TABLE hotel
    ADD COLUMN IF NOT EXISTS google_editorial_summary TEXT,
    ADD COLUMN IF NOT EXISTS google_review_themes     TEXT[];

COMMENT ON COLUMN hotel.google_editorial_summary IS
    'Google''s own short description of the place (editorialSummary), stored '
    'verbatim at sweep time. Display requires Google attribution context.';
COMMENT ON COLUMN hotel.google_review_themes IS
    'Theme tags extracted at sweep time from the <=5 reviews Google returns, '
    'positive reviews only. A measurement over the sample, never quotes, and '
    'never presented as what all guests think.';
