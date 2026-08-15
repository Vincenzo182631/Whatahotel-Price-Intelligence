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

const sql = `-- Scoring configuration, version 1.
--
-- GENERATED FILE — do not edit by hand.
-- Source of truth: packages/core/src/config/defaults.ts
-- Regenerate with: npm run config:seed
--
-- Every value is a STARTING PRIOR with a documented rationale, not a finding.
-- See docs/mvp/10-configuration-registry.md, and the calibration runbook in
-- docs/mvp/02-deal-score.md §4 that must replace these before launch.

INSERT INTO scoring_config (version, config, is_active, note, created_by)
VALUES (
    1,
    $config$
${json}
$config$::jsonb,
    true,
    'Initial priors from the MVP specification. Not calibrated against real data.',
    'mvp-spec'
)
ON CONFLICT (version) DO NOTHING;
`;

await writeFile(join(root, 'db/seeds/002_scoring_config_v1.sql'), sql, 'utf8');
console.log('• Wrote db/seeds/002_scoring_config_v1.sql');
