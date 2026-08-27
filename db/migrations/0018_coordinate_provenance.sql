-- Record where a hotel's coordinates came from, so Google's can be stored
-- without Google later confirming itself.
--
-- ── What was wrong ────────────────────────────────────────────────────────
--
-- Both Places field masks request `location`, PlaceCandidate and
-- PlaceReputation both carry latitude and longitude, and every VERIFIED match
-- therefore arrives holding Google's own coordinates for the place. Then
-- ResolutionOutcome drops them and saveResolution never writes them.
--
-- Production 2026-08-27: 17 active hotels are google_match_status = 'VERIFIED'
-- and still carry no coordinates. A verified match is the strongest evidence
-- of a hotel's position this system can obtain, and it was being discarded on
-- arrival.
--
-- The cost is not cosmetic. The competitive radius (config v8) can only see
-- hotels that carry coordinates; an unplaced hotel is rejected at every rung,
-- 2, 3 and 5 miles alike, and reads as "no comparables" rather than "position
-- unknown".
--
-- ── Why provenance, rather than just writing them ─────────────────────────
--
-- match.ts scores a candidate partly on how well its position agrees with the
-- position we already hold. If Google's coordinates were written into the same
-- columns with no marker, a later re-match would score a Google candidate
-- against Google's own answer and find perfect agreement — the identical error
-- match.ts already refuses for addresses, where google_formatted_address is
-- deliberately kept apart from the merchant's street_address so that
-- corroboration stays independent.
--
-- So the columns stay one pair, and the provenance travels beside them.
-- Distance queries are unaffected and need no COALESCE: every one of them
-- keeps reading latitude and longitude exactly as before, which is the point —
-- a coalesce spread across the comp CTE, the identity query, the comparables
-- builder and the diagnostics is four chances to miss one, and a missed one
-- makes compBasis lie.
--
-- Matching is the single place that must care, and resolve.ts treats
-- GOOGLE-sourced coordinates as absent when scoring a fresh match. That path
-- is narrow already — a hotel holding Google coordinates also holds a
-- place_id, and resolveHotel short-circuits to a refresh rather than
-- re-matching — but it opens the moment a place_id is cleared to request a
-- retry, which is exactly when the guard has to be there.
--
-- ── The rule this encodes ─────────────────────────────────────────────────
--
-- Google supplements, never overwrites. A hotel that already has coordinates
-- from the source of record keeps them: those are what whatahotel.com says
-- about its own property, and replacing them with a third party's reading
-- would silently move a hotel that nobody asked to move. Only a hotel with NO
-- position at all is placed from a verified match.

CREATE TYPE hotel_coordinate_source_t AS ENUM ('SOURCE', 'GOOGLE');

ALTER TABLE hotel
    ADD COLUMN IF NOT EXISTS coordinate_source hotel_coordinate_source_t;

COMMENT ON COLUMN hotel.coordinate_source IS
    'Where latitude/longitude came from. SOURCE = the WhataHotel catalogue. '
    'GOOGLE = a VERIFIED Places match, written only when we held no position '
    'at all. NULL = no coordinates. Read by resolve.ts, which must not let '
    'Google-derived coordinates corroborate a Google candidate.';

-- Everything already placed predates this column and came from the source
-- catalogue; nothing else has ever written these columns.
UPDATE hotel
   SET coordinate_source = 'SOURCE'
 WHERE latitude IS NOT NULL
   AND longitude IS NOT NULL
   AND coordinate_source IS NULL;

-- ── Four rows carrying half a position ────────────────────────────────────
--
-- The first attempt at this migration was refused by its own CHECK. Production
-- holds four active hotels with a latitude and no longitude — The Westin Siray
-- Bay Resort & Spa, Hotel Villa Carlotta, The Slaak Rotterdam and The Danna
-- Langkawi — every one of them that way round, which is a parser signature
-- rather than random corruption. The source sent no usable longitude and the
-- catalogue stored the surviving half.
--
-- A lone coordinate is not a partial position, it is no position. Every
-- distance predicate in the system requires both, so these rows have been
-- invisible to the competitive ladder all along while still counting as placed
-- in any casual look at the data. Normalising them to NULL removes nothing
-- that anything could use, and it makes them eligible for the repair this same
-- migration enables: an unplaced hotel can be placed from a VERIFIED Google
-- match, and two of the four sit in destinations the coverage report lists as
-- starved.
--
-- The surviving latitude is discarded, and that is worth stating plainly
-- rather than burying: it is real data, it is simply not usable data, and
-- keeping it would mean either weakening the constraint or leaving the hotel
-- permanently half-placed.
--
-- The parser now refuses the pair at the source (parse.ts), so this class of
-- row cannot regenerate on the next catalogue sync — which matters more than
-- the repair itself, because a re-written lone latitude would be refused by
-- the CHECK below and take the whole sync down with it.
DO $$
DECLARE n INTEGER;
BEGIN
    UPDATE hotel
       SET latitude = NULL, longitude = NULL
     WHERE (latitude IS NULL) <> (longitude IS NULL);
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'normalised % row(s) carrying half a position', n;
END $$;

-- A position without a provenance, or a provenance without a position, means
-- one of the two writers got out of step. Cheap to assert, and the assertion
-- is what makes the guard in resolve.ts trustworthy.
ALTER TABLE hotel
    DROP CONSTRAINT IF EXISTS hotel_coordinate_source_agrees;
ALTER TABLE hotel
    ADD CONSTRAINT hotel_coordinate_source_agrees CHECK (
        (latitude IS NULL AND longitude IS NULL AND coordinate_source IS NULL)
     OR (latitude IS NOT NULL AND longitude IS NOT NULL AND coordinate_source IS NOT NULL)
    );

-- The sweep asks "which VERIFIED hotels are still unplaced", once, to size the
-- backfill. Partial and tiny.
CREATE INDEX IF NOT EXISTS hotel_verified_unplaced_idx
    ON hotel (id)
    WHERE is_active
      AND google_match_status = 'VERIFIED'
      AND latitude IS NULL;
