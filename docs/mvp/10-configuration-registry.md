# 10 — Configuration Registry

Every tunable weight and threshold in the MVP, in one place. Covers the proposal's requirement to *"clearly identify which weights and thresholds should be configurable so we can calibrate them later."*

---

## 1. How configuration works

- Stored as a single JSONB document in `scoring_config` (doc 05 §5), **versioned and append-only**.
- Exactly one row is active (`is_active`), enforced by a partial unique index.
- Every `analysis` row records the `config_version` that produced it, so any historical score remains reproducible after recalibration — and so the calibration runbook can compare cohorts across versions.
- Changing configuration is a **data change, not a deploy**: insert a new version, activate it. Rollback is reactivating the prior version.
- The engine reads config once per request from an in-process cache with a short TTL.

**Every value below is a starting prior with a stated rationale. None is a finding.** They exist to be replaced by calibrated values once real data is available (doc 02 §4).

---

## 2. Deal Score weights

| Key | Default | Rationale |
|---|---|---|
| `score.weight.f1_historical` | **0.30** | Directly answers the customer's question; rests on our own data. Highest relevance and highest reliability |
| `score.weight.f2_market` | **0.25** | The only external check on F1; depends on comp-set quality (U12) we don't yet control |
| `score.weight.f3_trend` | **0.15** | Real signal, but describes timing more than attractiveness; its main role is in the recommendation gates |
| `score.weight.f4_seasonality` | **0.10** | Overlaps F1's stratified baseline; low weight pending the correlation check |
| `score.weight.f5_demand` | **0.10** | Valuable context, least likely to have data at MVP |
| `score.weight.f6_value` | **0.10** | Strategically the differentiator, but the least certain data (U10). Weight reflects data confidence, not importance. Expected to rise in Phase 2 |

Must sum to 1.00; validated on config insert.

## 3. Deal Score gains and caps

| Key | Default | Rationale |
|---|---|---|
| `score.trend.window_days` | 7 | Matches proposal's 7-day framing; 14/30 also computed for display |
| `score.trend.gain` | 250 | +10% over 7d → sub-score 75; ~20% saturates without clipping ordinary movement |
| `score.trend.min_series_points` | 4 | Below this a slope is noise |
| `score.season.gain` | 150 | A season 20% below annual norm → sub-score 80 |
| `score.season.min_history_days` | 365 | Seasonality is meaningless without a full cycle |
| `score.season.correlation_max` | 0.60 | Above this, F4 duplicates F1 and should be folded in |
| `score.value.gain` | 200 | Benefits worth 25% of the rate saturate the factor |
| `score.value.benefit_cap_pct` | 0.25 | Stops an implausible benefit valuation dominating the score |
| `score.value.breakfast_realization` | 0.70 | Not every guest uses breakfast every morning |
| `score.value.credit_realization` | 0.80 | Credit is often partially unspent |
| `score.value.upgrade_probability` | 0.35 | Upgrades are subject to availability; face value would overstate them |
| `score.market.min_comps` | 3 | Below three, a median is not meaningful |
| `score.min_weight_coverage` | 0.55 | Below this, too little of the model ran to publish a score |
| `score.lookback_days` | 90 | Matches the proposal's 90-day framing |
| `score.outlier_trim` | `[0.01, 0.99]` | Removes error fares and closeouts without discarding real extremes |

## 4. Score bands

| Key | Default |
|---|---|
| `score.band.excellent_min` | 85 |
| `score.band.good_min` | 70 |
| `score.band.fair_min` | 50 |
| `score.band.below_average_min` | 30 |

## 5. Baseline and ladder

| Key | Default | Rationale |
|---|---|---|
| `baseline.min_obs_abs` | 12 | Hard floor; below it no score is published |
| `baseline.min_obs_target` | 30 | Ladder stops climbing once reached |
| `baseline.lead_buckets` | `[0-3, 4-7, 8-14, 15-30, 31-60, 61-120, 121+]` | Lead-time/price relationship is non-monotonic; buckets are honest about what we can support |
| `baseline.level_multiplier.l0…l4` | 1.00 / 0.95 / 0.88 / 0.80 / 0.60 | Each relaxation makes the comparison less like-for-like |
| `baseline.max_age_hours` | 24 | Beyond this the rollup itself is stale |
| `baseline.capture_slot_minutes` | 60 | Dedup granularity |

## 6. Confidence

| Key | Default | Rationale |
|---|---|---|
| `confidence.weight.volume` | 0.25 | The foundation — no amount of freshness rescues n=4 |
| `confidence.weight.freshness` | 0.20 | The most common real-world failure |
| `confidence.weight.match` | 0.20 | The most damaging failure when it goes wrong |
| `confidence.weight.volatility` | 0.15 | Bounds how durable the judgement is |
| `confidence.weight.consistency` | 0.10 | Valuable but often unavailable (single source) |
| `confidence.weight.coverage` | 0.10 | Only included when F2 ran |
| `confidence.volume_target_n` | 60 | Point of full credit on the log curve |
| `confidence.fresh_full_hours` | 6 | Within this, a rate is simply current |
| `confidence.fresh_zero_hours` | 72 | Beyond this, effectively worthless |
| `confidence.consistency_cv_max` | 0.15 | Cross-source spread above this suggests one source is wrong |
| `confidence.single_source_value` | 0.85 | Below 1.0 — one source means no corroboration — but not punitive |
| `confidence.coverage_target_comps` | 5 | Point of full credit |
| `confidence.volatility_cv_max` | 0.35 | Above this, a point estimate is fragile |
| `confidence.volatility_floor` | 0.25 | Volatility makes a percentile fragile, not false |
| `confidence.unresolved_share_max` | 0.20 | Tolerated share of unresolved rate terms in a baseline |
| `confidence.band.high_min` | 75 | |
| `confidence.band.moderate_min` | 55 | |
| `confidence.band.low_min` | 40 | |

## 7. Recommendation gates

| Key | Default | Rationale |
|---|---|---|
| `rec.confidence_floor` | 40 | Below this we publish no recommendation at all |
| `rec.match_min` | 0.50 | Below this we cannot claim the history describes this room |
| `rec.max_current_age_hours` | 24 | A day-old price is not a current price |
| `rec.min_obs_abs` | 12 | Mirrors the baseline floor |
| `rec.l4_confidence_min` | 55 | Extra bar when the baseline borrowed sibling rooms |
| `rec.book.score_min` | 72 | Entry to the strong-deal path |
| `rec.book.confidence_min` | **60** | **Lower than WAIT's bar — deliberate.** Booking a demonstrably below-average rate has bounded downside; waiting does not |
| `rec.book.urgency_score_min` | 60 | A decent rate that is climbing is still worth acting on |
| `rec.book.urgency_rise_pct` | 3.0 | |
| `rec.book.urgency_demand` | 0.60 | |
| **`rec.wait.confidence_min`** | **70** | **The mandatory rule.** Never recommend waiting on weak evidence |
| `rec.wait.score_max` | 42 | Only a genuinely poor rate justifies waiting |
| `rec.wait.min_lead_days` | 10 | Closer than this, a decline cannot plausibly materialize |
| `rec.wait.rise_block_pct` | 2.0 | Prices moving against the customer |
| `rec.wait.demand_block` | 0.60 | Event or sellout pressure — rates will not soften |
| `rec.wait.scarcity_block` | 3 | The room may simply be gone |
| `rec.wait.min_volatility_confidence` | 0.40 | Too erratic to time |
| `rec.wait.max_trend_pct` | 0.0 | Flat or falling only |

## 8. Explanation layer

| Key | Default |
|---|---|
| `explanation.enabled` | `true` — set `false` to serve templates only |
| `explanation.model` | configured Claude model ID |
| `explanation.temperature` | 0.3 |
| `explanation.timeout_ms` | 2500 |
| `explanation.max_sentences` | 3 |
| `explanation.numeric_tolerance` | 0.5 |
| `explanation.cache_ttl_hours` | 24 |
| `explanation.max_template_factors` | 3 |
| `explanation.prompt_version` | 1 |

## 9. Collection and operations

| Key | Default |
|---|---|
| `collection.tier.hot_interval_hours` | 6 |
| `collection.tier.warm_interval_hours` | 24 |
| `collection.tier.cold_interval_hours` | 72 |
| `collection.hot_lead_days_max` | 30 |
| `collection.hot_viewed_within_days` | 7 |
| `collection.batch_max` | 1000 |
| `retention.raw_months` | 18 |
| `retention.analysis_days` | 180 |
| `api.cache_ttl_seconds` | 900 |
| `api.insufficient_data_cache_ttl_seconds` | 300 |

## 10. Calibration targets

Not engine inputs — the measurable goals the runbook (doc 02 §4) evaluates against.

| Key | Target | Meaning |
|---|---|---|
| `calibration.book_now_regret_rate_max` | 0.10 | Share of BOOK_NOW rates beaten by a lower rate within 14 days |
| `calibration.wait_success_rate_min` | 0.60 | Share of WAIT recommendations where the price actually fell within 14 days |
| `calibration.score_stability_max_delta` | 10 | Maximum score movement on re-run absent a real price change |
| `calibration.insufficient_data_rate_max` | 0.25 | Share of queries returning no score — above this, coverage is too thin to launch |

---

## 11. Change control

1. Weight and threshold changes are reviewed like code — proposed with the calibration evidence that motivates them.
2. `score.weight.*` must sum to 1.00; validated on insert.
3. **`rec.wait.confidence_min` has a hard floor of 60 in code.** A configuration attempting to set it lower is rejected. Configuration must not be able to disable the safety rule it was designed to enforce.
4. Every activation records who, when, and why in `scoring_config.note`.
5. After any activation, re-run the golden fixtures (doc 07 §2). Band or recommendation changes in S1–S9 must be explained before the config goes live.
