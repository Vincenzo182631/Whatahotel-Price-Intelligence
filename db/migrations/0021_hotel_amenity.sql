-- 0021 — what a hotel actually offers, and proof it is the right hotel.
--
-- Rule 21 records that this source exposes no quality signal: no star rating,
-- no guest rating, and amenities "only behind method=info, which answers 500
-- for our key". That last clause stopped being true on 2026-09-17, when Matt
-- fixed the method. Probed over 20 hotels the same day, `info` returns a
-- CODED per-room amenity list, restaurant names, policies and area detail,
-- and it genuinely varies per property: 16 distinct values out of 17 for
-- hotel info, area info and policies, 12 of 17 for guest rooms.
--
-- That matters because of what the customer currently reads. The preference
-- selector offers nine choices and has nothing to tell them apart: five of
-- nine open "Limited preference-specific information is available", and
-- Nightlife and Business Travel return word-for-word identical fit lists.
-- The owner tested it on Four Seasons Oahu at Ko Olina and said, correctly,
-- that a feature offering nothing tangible is a hurdle in front of a booking
-- rather than a reason to make one. This is the data that can answer him.
--
-- ── Why the Amadeus code is half of this migration ────────────────────────
--
-- `info` is keyed on hotelName + hotelCity, NOT on the id every other part of
-- this system uses, and its response carries no hotel name at all — measured,
-- the only name-shaped field is session.sessionName, the constant "Guest".
-- So nothing in an `info` response says which property it describes.
--
-- Attaching one hotel's amenities to another would be silent and permanent,
-- and it is exactly the failure rule 22 exists to prevent: "Four Seasons
-- Hotel Miami" and "Four Seasons Resort Palm Beach" share most of their
-- words. Name similarity cannot separate two properties of one brand.
--
-- What the response DOES carry is `amadeus.codes`, one per hotel and distinct
-- across all 18 that answered (RZMIAKBZ for Ritz-Carlton Miami Key Biscayne,
-- MCAUAARM for Marriott Aruba). The `hotel` method — keyed by ID, so
-- unambiguous — returns the same identity as `ama-property`, which the
-- adapter has parsed since the beginning and never stored.
--
-- Storing it turns a name lookup into a checkable one: ask `info` by name,
-- compare the code it returns against the code the id lookup gave us, and
-- write nothing when they disagree. Two independent id spaces corroborating
-- each other, which is the same shape rule 24 uses for street addresses.
ALTER TABLE hotel ADD COLUMN IF NOT EXISTS amadeus_property TEXT;

COMMENT ON COLUMN hotel.amadeus_property IS
  'Amadeus property code from the by-ID hotel lookup (ama-property). The '
  'identity check for method=info, which is keyed by name and returns no '
  'name of its own. NULL means the lookup has not run or the source gave '
  'none — never a licence to skip the check.';

-- One row per (hotel, amenity code). The source's own code is the key: its
-- LABEL is free text that may be reworded upstream, and re-labelling would
-- otherwise read as a new amenity appearing.
CREATE TABLE IF NOT EXISTS hotel_amenity (
    hotel_id   BIGINT      NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    -- RMACODE from GUESTROOMS.ROOMRMA, e.g. "74" for Non-smoking.
    code       TEXT        NOT NULL,
    -- RMAVAL, kept so a human can read what a code means without a lookup
    -- table we would have to guess at and maintain.
    label      TEXT        NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hotel_id, code)
);

COMMENT ON TABLE hotel_amenity IS
  'Per-hotel room amenities from method=info, written ONLY when the info '
  'response Amadeus code matches hotel.amadeus_property. Not a fact table '
  'for scoring: nothing under packages/core/src/scoring may read it (rule '
  '21 — included value stays the only validated quality evidence in the '
  'score). It exists to let the preference layer say something true.';

-- `last_seen` is what makes a disappearance visible. An amenity the source
-- stops reporting is NOT deleted: we cannot tell "the hotel removed it" from
-- "this response was thin", and deleting on one thin answer would make the
-- customer-facing list flicker. A reader that cares about freshness filters
-- on last_seen; nothing here ever silently drops a row.
CREATE INDEX IF NOT EXISTS hotel_amenity_freshness_idx
    ON hotel_amenity (hotel_id, last_seen DESC);
