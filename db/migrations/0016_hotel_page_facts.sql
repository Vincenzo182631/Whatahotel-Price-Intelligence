-- Facts published on whatahotel.com's own hotel page that the rates API does
-- not return.
--
-- Measured 2026-08-26 over 15 sampled ids. `/hotels/<id>/` resolves without
-- the URL slug, so every catalogued hotel is addressable by the same id space
-- the sweep already walks.
--
-- ── What is deliberately NOT here ─────────────────────────────────────────
--
-- The page carries schema.org `starRating`, `priceRange` and `amenityFeature`,
-- and none of the three is stored, because none of them is data: across all
-- 12 real hotels sampled the values were byte-identical — 5 stars, "$$$$", and
-- the same five WhataHotel perks. It is an SEO template. A column holding the
-- same constant for all 3,202 hotels would read like a quality signal while
-- carrying no information, which is rule 9's failure mode wearing a rating's
-- clothes. If the source ever varies them, that is the moment to store them.
--
-- ── street_address ────────────────────────────────────────────────────────
--
-- The load-bearing one. Google Places matching is decided by geography, so a
-- hotel whose coordinates we do not hold is capped below the match threshold
-- and never earns a rating (resolve.ts, SKIPPED_NO_GEO). The merchant's own
-- street address is geography in text form and comes from OUTSIDE Google, so
-- corroborating a candidate with it is independent evidence rather than
-- Google confirming itself.
--
-- ── bookable_online ───────────────────────────────────────────────────────
--
-- The page says "This property is not available for online booking" for some
-- hotels; the rates API answers a bare 500 for the same stay and cannot be
-- told apart from a genuine upstream fault. Storing the page's answer lets a
-- known-unbookable property stop consuming grid slots and stop being reported
-- as a broken Amadeus mapping. NULL means the page never said either way.

ALTER TABLE hotel
    ADD COLUMN IF NOT EXISTS street_address   TEXT,
    ADD COLUMN IF NOT EXISTS postal_code      TEXT,
    ADD COLUMN IF NOT EXISTS bookable_online  BOOLEAN,
    ADD COLUMN IF NOT EXISTS page_fetched_at  TIMESTAMPTZ;

COMMENT ON COLUMN hotel.street_address IS
    'Street address from the public hotel page. Independent geographic evidence for Google Places matching.';
COMMENT ON COLUMN hotel.bookable_online IS
    'Public page states the property cannot be booked online. NULL = the page did not say.';
COMMENT ON COLUMN hotel.page_fetched_at IS
    'Last successful parse of the public hotel page. Drives the refresh queue.';

-- The resolution sweep asks for hotels that still need a Google match; the
-- address only matters for the ones lacking coordinates, which is exactly the
-- set this index serves.
CREATE INDEX IF NOT EXISTS hotel_page_refresh_idx
    ON hotel (page_fetched_at NULLS FIRST)
    WHERE is_active;
