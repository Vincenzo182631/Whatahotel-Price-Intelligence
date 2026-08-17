# 11 — Calibration Tooling (M7)

Implements the calibration runbook from [doc 02 §4](./02-deal-score.md#4-score-bands-and-calibration) and the targets from [doc 10 §10](./10-configuration-registry.md).

```bash
npm run calibrate                                    # runbook
npm run calibrate -- --sweep                         # + weight search
npm run calibrate -- --stays 120 --points 8 --report calibration.md
```

---

## 1. Why replay rather than reading stored analyses

The obvious approach — read the `analysis` table and check how those scores fared — cannot answer the question that matters. Stored analyses were produced by one configuration, so they can tell you how _that_ config performed and nothing about any alternative. Calibration exists precisely to compare alternatives.

So the harness **replays**: it reconstructs what the engine _would have seen_ at a past instant using only observations captured on or before it, re-scores under any candidate configuration, and compares the verdict against what the price actually did next.

This works only because `rate_observation` is append-only with a capture timestamp. That property was specified in [doc 01 §5](./01-data-architecture.md) for data-integrity reasons; backtesting is the second dividend.

```
   observations captured ≤ T          observations captured in (T, T+14d]
   ─────────────────────────►  T  ────────────────────────────────►
        reconstruct input        score              measure outcome
        (baseline, series,     (any config)      (did it get cheaper?)
         comparables as-of)
```

### Two phases, deliberately separated

| Phase            | Cost                             | Runs               |
| ---------------- | -------------------------------- | ------------------ |
| `collectSamples` | Database-bound, seconds per stay | **Once**           |
| `evaluate`       | Pure, microseconds               | Thousands of times |

That split is what makes a weight sweep affordable, and it guarantees every candidate is judged on **identical evidence** rather than on a fresh sample that might differ for unrelated reasons.

### Honest approximations

Flagged in every report, because a backtest that hides its own leakage is worse than none:

- **Benefits and demand context are read at current values**, not as of the replay instant. Neither has a history table.
- **The comparable _set_ is current**, though comparable _rates_ are as-of.

---

## 2. The metrics

| Metric             | Asks                                                       | Target                  |
| ------------------ | ---------------------------------------------------------- | ----------------------- |
| Score distribution | Is the score centred and spread, or piled at one end?      | mean within ±12 of 50   |
| Factor correlation | Are two factors measuring the same thing?                  | no pair above \|r\| 0.6 |
| BOOK_NOW regret    | How often was a rate we said to book beaten shortly after? | ≤ 10%                   |
| Score stability    | Does the score drift when the price does not?              | p95 Δ ≤ 10 points       |
| Coverage           | How often can we not answer at all?                        | ≤ 25%                   |

**Every metric reports `INSUFFICIENT_SAMPLE` rather than a verdict when it lacks evidence.** A report that cannot distinguish "we passed" from "we could not tell" is worse than no report — it converts ignorance into false confidence, which is the exact failure the Confidence Score exists to prevent elsewhere in this product.

Two design notes worth knowing:

- **Stability uses a price tolerance** (`stabilityPriceTolerancePct`, default 1%) rather than requiring an identical price. Requiring exact equality makes the metric unmeasurable on any hotel that reprices daily — which is most of them. A 1% price move cannot justify a 10-point score swing.
- **Regret ignores immaterial drops** (`materialDropPct`, default 2%). A rate beaten by $1 is noise, not a missed opportunity.

---

## 3. The weight sweep

Coordinate descent over the five Deal Score weights, with three guards that matter more than the search itself:

1. **Holdout split by stay.** Candidates are ranked on stays the search never saw. Splitting by _trial_ rather than by _stay_ would leak — two replays of the same stay are not independent.
2. **A margin requirement.** A candidate must beat the incumbent by `minImprovement` (0.02). Weights that are merely _different_ are not better.
3. **Reported reliability.** The loss counts only the metric terms the holdout could actually judge, and the sweep **refuses to rank weights when fewer than four of six terms were measurable**. A loss built from one surviving term is not comparable to one built from five.

**The sweep never writes to `scoring_config`.** It emits a ranked suggestion. Activating a configuration is a reviewed decision with evidence attached ([doc 10 §11](./10-configuration-registry.md)), and a search that could silently move the weights would defeat the purpose of versioning them.

---

## 4. The synthetic-data guard

`detectProvenance` measures how much of the underlying data comes from a non-authoritative source. When any of it is synthetic, both the console output and the Markdown report lead with:

> **⚠ SYNTHETIC DATA — THESE ARE NOT FINDINGS**

and the CLI exits 0 even on a FAIL, so a synthetic run cannot redden a build with a meaningless failure.

This is the single most important behaviour in the tool. A calibration report is the most authoritative-looking artefact this project produces — a table of metrics against targets, with a pass/fail verdict. If such a report could be generated from fabricated rates without saying so, it would be the most damaging thing here.

---

## 5. What the harness found

Run against synthetic data, so **none of the metric values are findings**. Two results are structural and hold regardless of the data:

### F1/F5 were not independent — a design defect · **RESOLVED in config v2**

Measured r = 0.82; the algebra gives r = 1.0 at constant demand pressure. `score_F5 = (50 − 50D) + D · score_F1` — F5 was an affine transform of F1 and added no independent information.

**Resolved: F5 was removed from the Deal Score**, and its 0.10 redistributed proportionally across the remaining five factors. Demand continues to drive guard W4 and urgency gate G3, where it acts on the _recommendation_ rather than the _score_ and so cannot double-count the percentile. Full write-up in [doc 02 §3, F5](./02-deal-score.md).

A regression test asserts the factor breakdown is exactly `[F1, F2, F3, F4, F6]` and that demand still reaches the decision trace, where gate G3 reads it — so the dependency cannot return unnoticed.

### Comparables were not filtered to the subject's comparability class

[Doc 01 §4](./01-data-architecture.md) requires every comp-set comparison to stay within the query's class. The implementation selected each comparable's cheapest room across _all_ classes, so a subject's flexible bed-and-breakfast rate could be compared against a comparable's non-refundable room-only discount. **Fixed** in both the live path and the replay.

---

## 6. Running it for real

The harness is ready; the data is not. When real captured rates exist:

1. Run `npm run calibrate -- --stays 200 --points 10 --report calibration-v1.md`.
2. Expect FAILs. The weights in config v2 are documented priors, not findings, and were never expected to survive contact with data.
3. Work the blocking metrics in order of customer harm: **BOOK_NOW regret first** — it is the failure a traveler actually feels — then coverage, then correlation.
4. Use `--sweep` for a starting direction, never as the decision. Check `loss terms judged`; below 4 of 6 the ranking is not evidence.
5. Insert the new config as a **new version** with the report attached in `scoring_config.note`, then re-run the golden fixtures (doc 07 §2). Band or recommendation changes in S1–S9 must be explained before activation.
