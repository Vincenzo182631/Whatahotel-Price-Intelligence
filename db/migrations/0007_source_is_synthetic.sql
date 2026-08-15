-- Whether a source produces FABRICATED rates.
--
-- `is_authoritative` does not answer this: it describes how much a source is
-- trusted, not whether its numbers are real. A low-trust source can be entirely
-- real, and nothing before this column recorded the difference.
--
-- The gap had a visible consequence. The widget demo harness carried a
-- hardcoded "Synthetic data — these are not real hotel prices" banner. Once the
-- database held live WhataHotel rates, that banner was displaying genuine
-- Four Seasons pricing under a notice saying no number on the page was real.
-- A safety label that is not derived from the data is not a safety label.
--
-- Recording it here rather than inferring it from a magic source code means the
-- API can report provenance truthfully, and a mixed database — the state rule 7
-- in CLAUDE.md warns about, where fabricated rows sit indistinguishably beside
-- real ones — becomes visible instead of silent.

ALTER TABLE source
    ADD COLUMN is_synthetic BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN source.is_synthetic IS
    'True when this source fabricates rates. Never true for a production source.';

-- Any source already recorded as synthetic-by-convention keeps its meaning.
UPDATE source SET is_synthetic = true WHERE code = 'SYNTHETIC_DEV';
