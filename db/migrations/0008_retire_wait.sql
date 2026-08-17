-- Retire WAIT.
--
-- WAIT told a customer that this rate might get better if they held off. That
-- is a forecast, and this system has no basis for one: there is no reliable
-- rate history behind it and the product deliberately does not predict prices.
-- The engine no longer emits it (gate G4 is gone, and the TypeScript
-- Recommendation type no longer contains the value).
--
-- The database was the third enforcement layer for the never-WAIT rule, bounding
-- the confidence at which WAIT was permitted. That bound is now replaced by a
-- flat refusal: no row may carry the value at any confidence. The layer is kept
-- rather than dropped — it costs nothing and it is what stops a future caller
-- reintroducing the verdict by writing straight to the table.

ALTER TABLE analysis DROP CONSTRAINT analysis_wait_confidence_ck;

ALTER TABLE analysis
    ADD CONSTRAINT analysis_no_wait_ck CHECK (recommendation <> 'WAIT');

-- Guard codes W1–W8 existed only to remove WAIT from the set of possible
-- outputs. With no such output there is nothing for them to block, and nothing
-- writes the column any more.
ALTER TABLE analysis DROP COLUMN wait_blocked_by;

-- The enum value itself stays. Removing a value from a Postgres enum means
-- recreating the type and rewriting every column that uses it, and the CHECK
-- above already makes the value unusable. Keeping it also keeps any historical
-- row readable rather than orphaning it behind a type that no longer describes
-- it.
