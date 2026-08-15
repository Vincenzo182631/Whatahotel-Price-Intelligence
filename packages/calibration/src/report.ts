/**
 * Report rendering — console and Markdown.
 *
 * The provenance banner is not decoration. A calibration run against synthetic
 * rates measures the harness, not the model, and a report that reads like a
 * finding would be the most damaging artefact this project could produce.
 */

import type { ScoringConfig } from '@wahpi/core';

import type { MetricResult, MetricStatus } from './metrics.js';
import type { DataProvenance, RunbookResult } from './runbook.js';
import type { SweepResult } from './sweep.js';

const STATUS_MARK: Record<MetricStatus, string> = {
  PASS: '✓',
  FAIL: '✗',
  WARN: '!',
  INSUFFICIENT_SAMPLE: '?',
};

const STATUS_WORD: Record<MetricStatus, string> = {
  PASS: 'pass',
  FAIL: 'FAIL',
  WARN: 'warn',
  INSUFFICIENT_SAMPLE: 'no data',
};

export interface ReportInput {
  readonly runbook: RunbookResult;
  readonly provenance: DataProvenance;
  readonly config: ScoringConfig;
  readonly sweep?: SweepResult;
  readonly generatedAt: string;
}

export function renderConsole(input: ReportInput): string {
  const { runbook, provenance, sweep } = input;
  const lines: string[] = [];

  lines.push('');
  lines.push('  WhataHotel Price Intelligence — calibration runbook');
  lines.push('  ' + '─'.repeat(66));

  if (provenance.syntheticShare > 0) {
    lines.push('');
    lines.push('  ⚠  SYNTHETIC DATA — THESE ARE NOT FINDINGS');
    lines.push(
      `     ${(provenance.syntheticShare * 100).toFixed(0)}% of observations come from a ` +
        'fabricated development source.',
    );
    lines.push('     This run exercises the harness. It says nothing about real hotel pricing,');
    lines.push('     and no weight change may be justified by it.');
  }

  lines.push('');
  lines.push(
    `  sample: ${runbook.sampleSize} replayed trials across ${runbook.stays} stays · ` +
      `config v${runbook.configVersion}`,
  );
  lines.push('');

  for (const metric of runbook.metrics) {
    const value = metric.value === null ? '—' : String(metric.value);
    lines.push(
      `  ${STATUS_MARK[metric.status]} ${metric.title.padEnd(28)} ` +
        `${value.padStart(8)}   target ${metric.target.padEnd(24)} [${STATUS_WORD[metric.status]}, n=${metric.sampleSize}]`,
    );
    lines.push(`      ${metric.detail}`);
    lines.push('');
  }

  lines.push('  ' + '─'.repeat(66));
  lines.push(`  overall: ${STATUS_WORD[runbook.overall]}`);
  if (runbook.blocking.length > 0) {
    lines.push(`  blocking: ${runbook.blocking.join(', ')}`);
  }

  if (sweep) {
    lines.push('');
    lines.push('  weight sweep');
    lines.push(
      `    explored ${sweep.explored} candidates · train ${sweep.trainSize} / holdout ${sweep.holdoutSize} trials`,
    );
    lines.push(
      `    loss terms judged: ${sweep.evaluableTerms}/6` +
        (sweep.reliable ? '' : '  ← NOT ENOUGH TO RANK WEIGHTS'),
    );
    lines.push(`    incumbent loss ${sweep.incumbent.loss.toFixed(3)}`);
    lines.push(`    best loss      ${sweep.best.loss.toFixed(3)}`);
    lines.push(`    ${sweep.note}`);
    if (sweep.improved) {
      lines.push('');
      lines.push('    suggested weights (NOT applied — review before activating):');
      for (const [key, value] of Object.entries(sweep.best.weights)) {
        const before = incumbentWeight(sweep, key);
        const delta = value - before;
        lines.push(
          `      ${key.padEnd(16)} ${before.toFixed(3)} → ${value.toFixed(3)}  ` +
            `(${delta >= 0 ? '+' : ''}${delta.toFixed(3)})`,
        );
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function renderMarkdown(input: ReportInput): string {
  const { runbook, provenance, config, sweep } = input;
  const out: string[] = [];

  out.push('# Calibration report');
  out.push('');
  out.push(`Generated ${input.generatedAt} · config version ${runbook.configVersion}`);
  out.push('');

  if (provenance.syntheticShare > 0) {
    out.push('> ## ⚠ Synthetic data — these are not findings');
    out.push('>');
    out.push(
      `> **${(provenance.syntheticShare * 100).toFixed(0)}% of the observations behind this report ` +
        'are fabricated** by the development seed generator.',
    );
    out.push('>');
    out.push(
      '> This run demonstrates that the calibration harness works. It measures nothing about ' +
        'real hotel pricing, and **no weight change may be justified by it**. Re-run against ' +
        'real captured rates before treating any number here as evidence.',
    );
    out.push('');
  }

  out.push('## Summary');
  out.push('');
  out.push(`- **Overall:** ${STATUS_WORD[runbook.overall]}`);
  out.push(
    `- **Sample:** ${runbook.sampleSize} replayed trials across ${runbook.stays} distinct stays`,
  );
  out.push(
    `- **Outcome horizon:** ${config.calibration.outcomeHorizonDays} days · material move threshold ${config.calibration.materialDropPct}%`,
  );
  if (runbook.blocking.length > 0) {
    out.push(`- **Blocking:** ${runbook.blocking.join(', ')}`);
  }
  out.push('');

  out.push('## Metrics');
  out.push('');
  out.push('| | Metric | Value | Target | n | Status |');
  out.push('|---|---|---|---|---|---|');
  for (const m of runbook.metrics) {
    out.push(
      `| ${STATUS_MARK[m.status]} | ${m.title} | ${m.value ?? '—'} | ${m.target} | ${m.sampleSize} | ${STATUS_WORD[m.status]} |`,
    );
  }
  out.push('');

  for (const m of runbook.metrics) {
    out.push(`### ${m.title}`);
    out.push('');
    out.push(m.detail);
    out.push('');
    if (m.rows && m.rows.length > 0) {
      out.push(...renderTable(m.rows));
      out.push('');
    }
  }

  if (sweep) {
    out.push('## Weight sweep');
    out.push('');
    out.push(
      `Explored ${sweep.explored} candidates by coordinate descent. Search ran on ` +
        `${sweep.trainSize} trials; every candidate below is scored on ${sweep.holdoutSize} ` +
        'held-out trials it never saw, split by stay so no stay appears on both sides.',
    );
    out.push('');
    out.push(`**${sweep.note}**`);
    out.push('');
    out.push(
      `Loss terms judged on the holdout: **${sweep.evaluableTerms} of 6**` +
        (sweep.reliable
          ? '.'
          : ' — too few to rank weights. Treat the ranking below as diagnostic only.'),
    );
    out.push('');

    if (sweep.improved) {
      out.push('### Suggested weights');
      out.push('');
      out.push(
        '> Not applied. Activating a configuration is a reviewed decision with evidence attached (doc 10 §11).',
      );
      out.push('');
      out.push('| Weight | Current | Suggested | Δ |');
      out.push('|---|---|---|---|');
      for (const [key, value] of Object.entries(sweep.best.weights)) {
        const before = incumbentWeight(sweep, key);
        const delta = value - before;
        out.push(
          `| \`score.weight.${key}\` | ${before.toFixed(3)} | ${value.toFixed(3)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} |`,
        );
      }
      out.push('');
    }

    out.push('### Top candidates by held-out loss');
    out.push('');
    out.push('| Rank | Holdout loss | Train loss | F1 | F2 | F3 | F4 | F5 | F6 |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    sweep.ranked.forEach((c, i) => {
      const w = c.weights;
      out.push(
        `| ${i + 1} | ${c.loss.toFixed(3)} | ${c.trainLoss.toFixed(3)} | ${w.f1Historical.toFixed(2)} | ` +
          `${w.f2Market.toFixed(2)} | ${w.f3Trend.toFixed(2)} | ${w.f4Seasonality.toFixed(2)} | ` +
          `${w.f5Demand.toFixed(2)} | ${w.f6Value.toFixed(2)} |`,
      );
    });
    out.push('');
  }

  out.push('## Data provenance');
  out.push('');
  out.push('| Source | Authoritative | Observations |');
  out.push('|---|---|---|');
  for (const s of provenance.sources) {
    out.push(
      `| \`${s.code}\` | ${s.authoritative ? 'yes' : 'no'} | ${s.observations.toLocaleString()} |`,
    );
  }
  out.push('');

  out.push('## Method');
  out.push('');
  out.push(
    'Each trial is a **point-in-time replay**: the engine is re-run using only observations ' +
      'captured on or before a past instant, then the verdict is compared against what the ' +
      'price actually did afterwards. This is possible because `rate_observation` is ' +
      'append-only with a capture timestamp.',
  );
  out.push('');
  out.push('Two approximations, unavoidable without history tables that do not exist:');
  out.push('');
  out.push(
    '- benefits and demand context are read at current values, not as of the replay instant;',
  );
  out.push('- the comparable *set* is current, though comparable *rates* are as-of.');
  out.push('');

  return out.join('\n');
}

/** Typed lookup into the weight vector — avoids an unsound index-signature cast. */
function incumbentWeight(sweep: SweepResult, key: string): number {
  const weights = sweep.incumbent.weights;
  return key in weights ? weights[key as keyof typeof weights] : 0;
}

function renderTable(rows: ReadonlyArray<Readonly<Record<string, string | number>>>): string[] {
  const first = rows[0];
  if (!first) return [];
  const headers = Object.keys(first);
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${headers.map((h) => String(r[h] ?? '')).join(' | ')} |`),
  ];
}
