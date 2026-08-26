-- Re-queue the hotels a foredoomed Google lookup retired.
--
-- One-time data repair for the regression fixed in #90.
--
-- ── What happened ─────────────────────────────────────────────────────────
--
-- resolveHotel briefly asked Google about any hotel holding a street address,
-- whether or not that address carried a house number. Without one,
-- addressConfirms can never fire, the no-coordinates ceiling stays at 0.65,
-- and UNVERIFIED is decided before the request leaves.
--
-- UNVERIFIED is never re-queued by findResolutionTargets, so each of those
-- calls spent the hotel's ONE retry on an outcome that was already fixed.
-- Production sweep 2026-08-26: 17 verified, 35 retired this way.
--
-- This resets exactly those rows to "never looked" — the state they were in,
-- and correctly in, before that sweep. With #90 merged the same hotels now
-- answer SKIPPED_NO_GEO instead: no call, no record, still retryable when
-- coordinates or a better address arrive.
--
-- ── What this deliberately does NOT touch ─────────────────────────────────
--
--   VERIFIED rows                  17 hotels matched on real address evidence,
--                                  two at name similarity 0.67 and 0.50 that
--                                  could never have cleared 0.7 on name alone.
--
--   UNVERIFIED WITH coordinates    A fair test with the decisive signal
--                                  present. A doubtful match staying doubtful
--                                  is the design, not a bug.
--
--   UNVERIFIED with a house number The evidence was real and the comparison
--                                  genuine; it simply did not agree.
--
-- The house-number test mirrors addressCanConfirm: one to four digits
-- standing alone as a token, at either end, because "455 Grand Bay Drive"
-- leads with it and "Mitropoleos 49" trails it. Longer runs are postcodes.

DO $$
DECLARE
    requeued INTEGER;
BEGIN
    UPDATE hotel
       SET google_match_status     = NULL,
           google_match_confidence = NULL,
           google_fetched_at       = NULL,
           updated_at              = now()
     WHERE is_active
       AND google_match_status = 'UNVERIFIED'
       AND (latitude IS NULL OR longitude IS NULL)
       AND (street_address IS NULL
            OR street_address !~ '(^|[^0-9])[0-9]{1,4}([^0-9]|$)');

    GET DIAGNOSTICS requeued = ROW_COUNT;
    RAISE NOTICE 'recovered % hotel(s) retired by a foredoomed lookup', requeued;
END
$$;
