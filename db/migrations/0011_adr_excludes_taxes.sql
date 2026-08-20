-- 0011 · ADR is the base room rate, not the grand total divided by nights.
--
-- `nightly_amount_minor` was `round(total_amount_minor / nights)`, and
-- `total_amount_minor` is the GROSS whole-stay amount (migration 0003 plus the
-- adapter's rateTotal decision). Every nightly figure in the product was
-- therefore inflated by the tax and fee factor — measured at ~18-25% on this
-- source: a real 2-night stay stored $929.43/night where the hotel, and
-- whatahotel.com, quote $762.50.
--
-- That mismatch is the whole reason this migration exists. The widget sits ON
-- whatahotel.com beside the site's own prices; an ADR expressed on a different
-- basis than the page around it reads as a pricing error, not as analysis.
--
-- ADR is now the base room rate before taxes and fees:
--
--     (total_amount_minor - taxes_fees_minor) / nights
--
-- which reconstructs the source's own per-night NET rate exactly. Verified
-- against 6 live observations carrying their raw payload: every recomputed
-- value equalled `rateDaily` to the minor unit.
--
-- COALESCE, not a NOT NULL requirement: a source that states no tax split
-- leaves taxes_fees_minor NULL, and "no stated taxes" must mean "the total is
-- the base rate", not "discard the observation".
--
-- `total_amount_minor` is DELIBERATELY unchanged and still gross. The stay
-- total a customer pays is the number they are committing to; only the
-- per-night figure changes basis. The API now labels the two separately.

-- The generated expression cannot be altered in place, so the column is
-- dropped and rebuilt. Both indexes INCLUDE it and are dropped with it; they
-- are recreated below exactly as migration 0003 defined them.
ALTER TABLE rate_observation DROP COLUMN nightly_amount_minor;

ALTER TABLE rate_observation ADD COLUMN nightly_amount_minor BIGINT
    GENERATED ALWAYS AS (
        round((total_amount_minor - COALESCE(taxes_fees_minor, 0))::numeric / nights)::bigint
    ) STORED;

CREATE INDEX rate_obs_baseline_idx ON rate_observation
    (hotel_id, room_type_id, comparability_class, stay_season_band,
     stay_dow_bucket, lead_time_days, observed_at DESC)
    INCLUDE (nightly_amount_minor)
    WHERE is_available AND match_confidence >= 0.5;

CREATE INDEX rate_obs_series_idx ON rate_observation
    (hotel_id, room_type_id, comparability_class, check_in, nights,
     adults, children, observed_at DESC)
    INCLUDE (nightly_amount_minor);

-- Baselines are a derived cache of the column just redefined, and they are
-- UPSERTED rather than rebuilt — a key that stops being recomputed would keep
-- its gross-based percentiles forever. Left in place they would also be the
-- worst kind of wrong for one rollup cycle: net current rates measured against
-- gross history makes every rate look like a bargain. Deleting is the honest
-- state — the history model reports INSUFFICIENT_DATA until the next rollup
-- rebuilds them from the same basis, minutes later in the same collection run.
DELETE FROM rate_baseline;
