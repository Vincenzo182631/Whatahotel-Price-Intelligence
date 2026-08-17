#!/usr/bin/env node
/**
 * Emits db/seeds/002_scoring_config_v1.sql from DEFAULT_CONFIG.
 *
 * The TypeScript module is the single source of truth; this keeps the seed in
 * lockstep with it. A test asserts the two never drift apart, so regenerate
 * (npm run config:seed) after changing defaults.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { DEFAULT_CONFIG } = await import(join(root, 'packages/core/dist/config/defaults.js'));

const json = JSON.stringify(DEFAULT_CONFIG, null, 2);

const NOTES = {
  1: 'Initial priors from the MVP specification. Not calibrated against real data.',
  2:
    'F5 (Demand) removed from the Deal Score: it was an affine function of F1 ' +
    '(score_F5 = (50 - 50D) + D * score_F1) and carried no independent signal. ' +
    'Its 0.10 weight was redistributed proportionally across the remaining five ' +
    'factors. Demand still drives the urgency gate G3. ' +
    'Still not calibrated against real data.',
  3:
    'Adds the live-market model: Comp-Set Index, Calendar Delta and Market ' +
    'Compression, scored from rates that exist today rather than from accrued ' +
    'history. Uncalibrated.',
  4:
    'Retires WAIT. "It may be worth waiting" is a claim about tomorrow\'s price ' +
    'and this system does not forecast. Gate G4, the eight never-WAIT guards and ' +
    'the rec.wait config block are gone, along with the SHORT_LEAD_TIME caveat ' +
    'that argued against waiting. rec.book.urgencyScarcityRooms carries over the ' +
    'one value that did non-predictive work. Uncalibrated.',
};
const NOTE = NOTES[DEFAULT_CONFIG.version] ?? 'Uncalibrated.';

/**
 * SQL string literal. NOT JSON.stringify — that emits double quotes, which
 * Postgres reads as an identifier, so the seed fails with
 * `column "..." does not exist`.
 */
const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

const sql = `-- Scoring configuration, version ${DEFAULT_CONFIG.version}.
--
-- GENERATED FILE — do not edit by hand.
-- Source of truth: packages/core/src/config/defaults.ts
-- Regenerate with: npm run config:seed
--
-- Every value is a STARTING PRIOR with a documented rationale, not a finding.
-- See docs/mvp/10-configuration-registry.md, and the calibration runbook in
-- docs/mvp/02-deal-score.md §4 that must replace these before launch.

-- Exactly one config may be active (partial unique index), so stand down any
-- earlier version before activating this one. Prior versions are KEPT: every
-- analysis row references the version that produced it, and deleting one would
-- make those scores irreproducible.
UPDATE scoring_config SET is_active = false
 WHERE is_active AND version <> ${DEFAULT_CONFIG.version};

INSERT INTO scoring_config (version, config, is_active, note, created_by)
VALUES (
    ${DEFAULT_CONFIG.version},
    $config$
${json}
$config$::jsonb,
    true,
    ${sqlString(NOTE)},
    'mvp-spec'
)
ON CONFLICT (version) DO UPDATE
   SET config = EXCLUDED.config,
       is_active = true,
       note = EXCLUDED.note;
`;

await writeFile(join(root, 'db/seeds/002_scoring_config.sql'), sql, 'utf8');
console.log(`• Wrote db/seeds/002_scoring_config.sql (version ${DEFAULT_CONFIG.version})`);
