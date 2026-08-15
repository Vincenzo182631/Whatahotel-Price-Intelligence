#!/usr/bin/env node
/**
 * Calibration runbook CLI.
 *
 *   npm run calibrate                      # runbook only
 *   npm run calibrate -- --sweep           # also search for better weights
 *   npm run calibrate -- --report out.md   # write a Markdown report
 *   npm run calibrate -- --stays 120 --points 8
 *
 * Never writes to scoring_config. Activating a configuration is a reviewed
 * decision with evidence attached (docs/mvp/10 §11).
 */
import { writeFile } from 'node:fs/promises';

import { closePool, loadActiveConfig } from '../packages/data/dist/index.js';
import {
  DEFAULT_COLLECT_OPTIONS,
  DEFAULT_SWEEP_OPTIONS,
  collectSamples,
  detectProvenance,
  renderConsole,
  renderMarkdown,
  runRunbook,
  sweep,
} from '../packages/calibration/dist/index.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return true;
  return value;
}

const options = {
  stays: Number(arg('stays', DEFAULT_COLLECT_OPTIONS.stays)),
  pointsPerStay: Number(arg('points', DEFAULT_COLLECT_OPTIONS.pointsPerStay)),
  minObservations: Number(arg('min-observations', DEFAULT_COLLECT_OPTIONS.minObservations)),
};
const wantSweep = arg('sweep', false) !== false;
const reportPath = arg('report', null);

async function main() {
  const started = Date.now();

  const provenance = await detectProvenance();
  if (provenance.totalObservations === 0) {
    console.error('No observations in the database. Nothing to calibrate.');
    process.exit(1);
  }

  const { config, fromDatabase } = await loadActiveConfig();
  if (!fromDatabase) {
    console.warn('! Scoring config not found in the database; using compiled defaults.\n');
  }

  process.stdout.write(
    `• Replaying up to ${options.stays} stays × ${options.pointsPerStay} points … `,
  );
  let lastPct = -1;
  const samples = await collectSamples(config, {
    ...options,
    onProgress: (done, total) => {
      const pct = Math.floor((done / total) * 10) * 10;
      if (pct !== lastPct) {
        process.stdout.write(`${pct}% `);
        lastPct = pct;
      }
    },
  });
  console.log(
    `\n  ${samples.length} trials collected in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  if (samples.length === 0) {
    console.error(
      '\nNo replayable trials. Calibration needs stays with a span of captured history —\n' +
        'at least a few observations before and after a replay point. Seed more data or\n' +
        'lower --min-observations.',
    );
    process.exit(1);
  }

  const runbook = runRunbook(samples, config);

  let sweepResult;
  if (wantSweep) {
    process.stdout.write('• Sweeping weights ');
    sweepResult = sweep(samples, config, {
      ...DEFAULT_SWEEP_OPTIONS,
      onProgress: () => process.stdout.write('.'),
    });
    console.log('');
  }

  const reportInput = {
    runbook,
    provenance,
    config,
    sweep: sweepResult,
    generatedAt: new Date().toISOString(),
  };

  console.log(renderConsole(reportInput));

  if (typeof reportPath === 'string') {
    await writeFile(reportPath, renderMarkdown(reportInput), 'utf8');
    console.log(`  report written to ${reportPath}\n`);
  }

  await closePool();

  // A FAIL is a finding, not a crash — but only when the data is real. Against
  // synthetic data the harness always exits 0, because a synthetic "failure"
  // would be a meaningless red build.
  if (runbook.overall === 'FAIL' && provenance.syntheticShare === 0) process.exit(2);
}

main().catch(async (err) => {
  console.error('\nCalibration failed:', err.message);
  await closePool();
  process.exit(1);
});
