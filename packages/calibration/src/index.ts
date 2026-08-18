export { outcomeAfter, replayAt, replayPointsFor, sampleReplayTargets } from './replay.js';
export type { Outcome, ReplayResult, ReplayTarget } from './replay.js';

export {
  allMetrics,
  bookNowRegret,
  coverage,
  factorCorrelation,
  pearson,
  scoreDistribution,
  scoreStability,
} from './metrics.js';
export type { MetricResult, MetricStatus, Trial } from './metrics.js';

export {
  DEFAULT_COLLECT_OPTIONS,
  collectSamples,
  detectProvenance,
  evaluate,
  runRunbook,
} from './runbook.js';
export type { CollectOptions, DataProvenance, ReplaySample, RunbookResult } from './runbook.js';

export { DEFAULT_SWEEP_OPTIONS, computeLoss, configFor, normalize, sweep } from './sweep.js';
export type { Candidate, SweepOptions, SweepResult, WeightVector } from './sweep.js';

export { renderConsole, renderMarkdown } from './report.js';
export type { ReportInput } from './report.js';
