-- The source's own ranking of a hotel within its city.
--
-- `cityrates` returns up to 15 hotels per city and returns them in DESCENDING
-- rank order — measured 2026-08-20: Miami 94..3, Paris 63..11, Honolulu
-- 589..47, Doha 13..0. That is WhataHotel's answer to "which hotels in this
-- city matter", and it is the only cross-hotel prominence signal the API
-- offers: nothing anywhere returns a star rating or a guest rating.
--
-- It is stored to ORDER the comp set, not to score with. What `rank` counts is
-- undocumented, and the shape (one large value, a long tail, zeros in a thin
-- market) reads as booking volume or prominence rather than quality. Using an
-- unknown quantity to choose WHO to compare against is defensible — the worst
-- case is a comp set no worse than an arbitrary one. Using it as a quality
-- factor in the score, or rendering it to a customer as a rating, would be
-- asserting something we cannot support. See docs/runbooks/source-api-inventory.md.
--
-- Nullable on purpose: a hotel found by the id-space sweep has no rank, because
-- only cityrates carries one and only for the 15 it returns. NULL means "not
-- ranked by the source", never "ranked last".
ALTER TABLE hotel ADD COLUMN IF NOT EXISTS city_rank INTEGER;

COMMENT ON COLUMN hotel.city_rank IS
    'Source rank within its city from cityrates (higher = more prominent). '
    'NULL = the source has not ranked it. Orders the comp set; never scored.';

-- The comp-set fallback reads (destination, rank) together.
CREATE INDEX IF NOT EXISTS hotel_destination_rank_idx
    ON hotel (destination_id, city_rank DESC NULLS LAST)
    WHERE is_active;
