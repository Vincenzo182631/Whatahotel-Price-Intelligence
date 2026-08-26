-- Re-queue the hotels a foredoomed lookup retired.
--
-- Context. resolveHotel briefly asked Google about any hotel holding a street
-- address, whether or not that address carried a house number. Without one
-- `addressConfirms` can never fire, the no-coordinates ceiling stays at 0.65,
-- and the answer is UNVERIFIED before the request leaves. UNVERIFIED is never
-- re-queued by findResolutionTargets, so each of those calls spent the hotel's
-- ONE retry on a decided outcome. Production sweep 2026-08-26: 35 hotels.
--
-- This resets exactly those rows to "never looked", which is the state they
-- were in — and were correctly in — before that sweep.
--
-- What it deliberately does NOT touch:
--
--   * VERIFIED rows. 17 hotels matched on address evidence and are right.
--   * UNVERIFIED rows that HAVE coordinates. Those got a fair test with the
--     decisive signal present, and a doubtful match staying doubtful is the
--     designed behaviour, not a bug.
--   * UNVERIFIED rows whose address DOES carry a house number. The evidence
--     was real and the comparison genuine; it simply did not agree.
--
-- The house-number test mirrors addressCanConfirm: one to four digits
-- standing alone as a token, at either end, since "455 Grand Bay Drive" leads
-- with it and "Mitropoleos 49" trails it. Longer runs are postcodes.
--
-- Run inside a transaction and read the count before committing.

BEGIN;

SELECT count(*) AS "will be re-queued"
  FROM hotel
 WHERE is_active
   AND google_match_status = 'UNVERIFIED'
   AND (latitude IS NULL OR longitude IS NULL)
   AND (street_address IS NULL OR street_address !~ '(^|[^0-9])[0-9]{1,4}([^0-9]|$)');

UPDATE hotel
   SET google_match_status = NULL,
       google_match_confidence = NULL,
       google_fetched_at      = NULL,
       updated_at             = now()
 WHERE is_active
   AND google_match_status = 'UNVERIFIED'
   AND (latitude IS NULL OR longitude IS NULL)
   AND (street_address IS NULL OR street_address !~ '(^|[^0-9])[0-9]{1,4}([^0-9]|$)');

-- COMMIT;   -- uncomment once the count above looks right
ROLLBACK;
