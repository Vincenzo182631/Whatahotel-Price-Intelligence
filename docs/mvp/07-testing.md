# 07 — Test Scenarios

Covers proposal request 8. All nine required scenarios, plus the invariants that must hold universally.

---

## 1. Approach

The scoring engine is a **pure function** — `(query, baseline, series, context, config) → verdict` — with no I/O. That is what makes it exhaustively testable: every scenario below is a fixture file plus an expected verdict, runnable in milliseconds with no database.

Three layers:

| Layer               | What it proves                                  | Mechanism                                                                |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| **Golden fixtures** | Named scenarios produce the expected verdict    | JSON fixture → engine → assert                                           |
| **Property tests**  | Safety invariants hold for _all_ inputs         | Generated inputs (fast-check or equivalent), ≥ 10 000 cases per property |
| **Integration**     | The pipeline preserves what the engine computed | Seeded Postgres → ingest → rollup → API → assert                         |

**Expected ranges, not exact values.** Asserting `deal_score === 91` would make every future recalibration a test rewrite. Fixtures assert bands, recommendations, ordering, and ranges — the properties that must survive calibration. Exact-value snapshots exist separately and are expected to change when config changes; a diff there is a review prompt, not a failure.

---

## 2. The nine required scenarios

Each fixture specifies: baseline distribution, same-stay series, comparables, context (lead time, demand, benefits), and the current rate.

### S1 — Excellent deal

**Setup.** 84 observations, median $748, p10 $652, tight distribution (cv 0.11). Current rate $689 → percentile 9. Comp set: 6 fresh comps, subject discount index 0.92 vs market 1.01. Series: 8 points, +9% over 7 days. Lead time 35d. Benefits: breakfast + $100 credit.

**Expect.** `deal_score` 85–97 (EXCELLENT) · `confidence` ≥ 80 (HIGH) · `recommendation` **BOOK_NOW** · `gate_fired` G2 · reasons lead with `BELOW_HISTORICAL_AVERAGE` · `caveats` empty.

**Asserts.** F1 sub-score > 85. Recommendation is BOOK_NOW. Explanation bundle's `allowed_numbers` contains every number in the rendered text.

---

### S2 — Normal price

**Setup.** 60 observations, median $740, cv 0.14. Current rate $745 → percentile 54. Comps: subject index 1.01, market median 1.00. Series flat (±0.5% over 7d). Lead 45d. No benefits.

**Expect.** `deal_score` 40–60 (FAIR) · `confidence` ≥ 75 · `recommendation` **CONSIDER** · `gate_fired` G5 · `wait_blocked_by` empty (score too high for G4, not a guard).

**Asserts.** CONSIDER, not WAIT — a normal price is not a bad one. This scenario guards against a common calibration error where the WAIT threshold drifts up and the engine starts telling people to wait on ordinary rates.

---

### S3 — Overpriced hotel

**Setup.** 70 observations, median $700, cv 0.16. Current rate $915 → percentile 96. Comps: subject index 1.31 vs market 1.02. Series flat. Lead 50d. No demand signal. No benefits.

**Expect.** `deal_score` ≤ 25 (POOR) · `confidence` ≥ 75 · `recommendation` **WAIT** · `gate_fired` G4 · reasons lead with `ABOVE_HISTORICAL_AVERAGE` and include `ABOVE_COMPARABLE_HOTELS`.

**Asserts.** This is the _only_ one of the nine that should yield WAIT. Confidence ≥ `WAIT_MIN_CONFIDENCE`. All eight never-WAIT guards evaluated clear.

---

### S4 — Rapidly increasing price

**Setup.** 55 observations, median $760. Current rate $740 → percentile ~42 (mildly _below_ typical). Series: 10 points, **+18% over 7 days**, monotonic. Lead 22d. Demand 0.4.

> Corrected during implementation. The original draft put the rate at percentile 66 while expecting a 55–75 score, which is unreachable: at that percentile F1 contributes ~34 and no amount of trend can lift the composite into range. A rate that is _mildly attractive and climbing fast_ is both internally consistent and the case the urgency gate exists for.

**Expect.** `deal_score` 55–78 · `confidence` ≥ 60 · `recommendation` **BOOK_NOW** via **G3 (urgency)**, not G2 · `wait_blocked_by` contains `W3`.

**Asserts.** A merely-acceptable rate that is climbing routes to BOOK_NOW through the urgency gate. Critically: **WAIT is blocked by W3** even though the score alone would not trigger G4 — verifying the guards run before, and independently of, the score paths. `gate_fired === 'G3'` distinguishes the reason so the explanation says "rising", not "excellent".

---

### S5 — Rapidly falling price

**Setup.** 65 observations, median $820. Current rate $700 → percentile 22 (genuinely good). Series: **−15% over 7 days**, monotonic decline. Lead 60d. Demand 0.1. cv 0.19.

**Expect.** `deal_score` 60–80 · `confidence` ≥ 70 · `recommendation` **CONSIDER** · reasons include `PRICE_FALLING_7D` (direction `NEGATIVE`).

**Asserts.** The hardest genuine case. The rate is good historically (F1 high) but falling (F3 low), and the score lands mid-high while the two factors disagree. The engine must **not** emit WAIT — score 60–80 is far above `WAIT_SCORE_MAX` (42) — and must not emit a confident BOOK_NOW that ignores the decline. CONSIDER with an honest "prices have been falling" reason is the correct, humble answer. This scenario protects the boundary between "good rate" and "good time".

---

### S6 — Insufficient historical data

**Setup.** **7 observations** (below `MIN_OBS_ABS` = 12), spread over 40 days, baseline reached L3. Current rate present and fresh. No comps.

**Expect.** `recommendation` **INSUFFICIENT_DATA** · `gate_fired` **G0** · `deal_score` **null** · `caveats` contains `LIMITED_HISTORY` · explanation generator `TEMPLATE`.

> The original draft also expected confidence < 40. In practice it lands near 47 — the seven observations we do hold are fresh and well-matched, so the evidence is thin rather than bad. The observation floor (`MIN_OBS_ABS`) is what forces G0 here, and it does so independently of confidence. That is the correct mechanism: _"we don't have enough history"_ is a different statement from _"the data we have is untrustworthy"_, and the engine should not have to conflate them.

**Asserts.** `deal_score` is `null`, **not 0** — the single most important assert in the suite, because a 0 renders as "terrible deal". The API returns `200`, not an error. The customer-facing text states plainly that history is still being built.

---

### S7 — High price volatility

**Setup.** 50 observations, median $800, **cv 0.55** (range $420–$1,480; flash sales and peak spikes). Current rate $610 → percentile 18. Series erratic, no clear trend. Lead 40d.

**Expect.** `deal_score` 60–88 (the percentile is real) · `confidence` **55–74**, out of the HIGH band, depressed by `f_volatility` at its 0.25 floor · `recommendation` **BOOK_NOW or CONSIDER** · `caveats` contains `HIGH_VOLATILITY`.

**Asserts.** Score and confidence **diverge** — 79 against 73 here, versus 85 against 88 in S1 on comparable data quality. If the score were instead suppressed alongside confidence, the design would be wrong: volatility does not make the percentile false, it makes it fragile. This scenario is what proves the two-number design earns its keep.

> **Calibration finding.** The original draft expected confidence 45–65 and a blocked BOOK_NOW. At the specified weights, volatility alone does not depress confidence below `BOOK_MIN_CONFIDENCE` — with plentiful, fresh, well-matched data, one weak factor moves the geometric mean to 73, not 60. Volatility _does_ block WAIT (guard W6), but there is no equivalent guard on BOOK_NOW. Whether that is a gap or correct behaviour is a real open question: recommending a rate at the 18th percentile is defensible even when the price is erratic. **Left as specified rather than re-tuned to force the expected outcome**; flagged for the calibration runbook.

---

### S8 — Poor room-type matching

**Setup.** 40 observations, but composition: 12 `SOURCE_ID` (1.0), 10 `ALIAS_FUZZY` (0.65), 18 `ATTRIBUTE_INFERRED` (0.5) → `f_match` ≈ 0.66. Baseline reached L4 (borrowed sibling room types). 25% of observations `UNRESOLVED` comparability class.

**Expect.** `confidence` ≤ 55 (LOW) after `f_match`, the L4 multiplier (0.60) and the unresolved-class penalty (0.85) compound · `recommendation` **CONSIDER** or **INSUFFICIENT_DATA** — never WAIT (W8 blocks on baseline ≥ L3), never BOOK_NOW (confidence < 60) · `caveats` contains `WEAK_ROOM_MATCH` and `BASELINE_WIDENED`.

**Variant S8b.** Same, but `f_match` = 0.45 → **INSUFFICIENT_DATA** via G0 (`MATCH_MIN` = 0.50).

**Asserts.** The multiplicative confidence design compounds these penalties rather than averaging them away. Under an arithmetic mean this scenario would still clear 70 and permit a recommendation — the test exists specifically to catch that regression.

---

### S9 — Conflicting market signals

**Setup.** F1 says excellent (percentile 12, sub-score 88). F2 says poor — subject index 1.15 while comps sit at 0.88, i.e. the whole market is discounting harder (sub-score 22). F3 mildly rising (+2%). F5 demand 0.55. All factors available, high data quality throughout.

**Expect.** `deal_score` 50–70 (FAIR) · `confidence` ≥ 75 — **confidence stays high**, because the data is good; the _signals_ conflict, not the evidence · `recommendation` **CONSIDER** · reasons include **both** `BELOW_HISTORICAL_AVERAGE` (POSITIVE) and `ABOVE_COMPARABLE_HOTELS` (NEGATIVE).

**Asserts.** Conflict must not be laundered into a middling score with no explanation. Both opposing reasons must survive into the bundle so the customer is told _why_ the verdict is equivocal. Also asserts that conflicting factors do **not** reduce confidence — a frequent modelling error that would conflate "we're unsure" with "the answer is 'it depends'".

---

## 3. Property-based invariants

Run over generated inputs; each must hold universally.

| #       | Invariant                                                                                                 | Why                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **P1**  | `recommendation === 'WAIT' ⇒ confidence ≥ WAIT_MIN_CONFIDENCE`                                            | **The mandatory rule.** Third of three enforcement layers (doc 03 §4) |
| **P2**  | `recommendation === 'INSUFFICIENT_DATA' ⇔ deal_score === null`                                            | Never a fabricated score, never a suppressed real one                 |
| **P3**  | **Monotonicity:** lowering the current price, with the trend series held fixed, never lowers `deal_score` | Catches sign errors — the most embarrassing possible bug              |
| **P4**  | `deal_score ∈ [0,100] ∪ {null}` and `confidence ∈ [0,100]`                                                | Clamping is applied everywhere                                        |
| **P5**  | Adding observations that match the existing distribution never lowers `confidence`                        | `f_volume` is monotonic                                               |
| **P6**  | Increasing the age of the current rate never raises `confidence`                                          | `f_freshness` is monotonic                                            |
| **P7**  | Weights of available factors sum to 1.0 after redistribution (±1e-9)                                      | Redistribution is correct                                             |
| **P8**  | Every number in the rendered explanation appears in `constraints.allowed_numbers`                         | Doc 04 validator V1                                                   |
| **P9**  | The engine is deterministic — same inputs and config version, same output                                 | No hidden clock or randomness                                         |
| **P10** | `n_observations < MIN_OBS_ABS ⇒ INSUFFICIENT_DATA`                                                        | G0 cannot be bypassed                                                 |
| **P11** | Any never-WAIT guard tripping ⇒ `recommendation ≠ 'WAIT'`                                                 | All eight guards, individually and combined                           |
| **P12** | `baseline_level ≥ L3 ⇒ confidence ≤ 0.80 × unwidened equivalent`                                          | Ladder penalty applied                                                |

P1, P3 and P11 are the release blockers. A failure in any of them stops a deploy.

---

## 4. Integration and data-layer tests

| Area                    | Test                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Ingest idempotency      | Same batch twice → identical row count; second run reports all duplicates                                         |
| Dedup slot              | Two captures in one slot → one row; across slots → two                                                            |
| Partition routing       | Observation lands in the correct monthly partition; a date beyond all partitions lands in default and alarms      |
| Money integrity         | No float anywhere; `total/nights` rounding verified against known cases; net vs gross never mixed in one baseline |
| Comparability isolation | A `NON_REFUNDABLE` observation never enters a `FLEXIBLE` baseline                                                 |
| Room-class hard rule    | A SUITE never merges into a ROOM baseline regardless of string similarity                                         |
| Widening ladder         | Progressive sparsity moves L0→L4 in order and stops at `MIN_OBS_TARGET`                                           |
| Baseline correctness    | Percentiles from the rollup match direct computation over raw facts                                               |
| DB constraint           | Attempting to insert a WAIT analysis with confidence 65 is rejected by `analysis_wait_confidence_ck`              |
| API contract            | Response validates against the published schema for every recommendation type                                     |
| Cache                   | `INSUFFICIENT_DATA` is not cached as long as a scored result (shorter TTL — it should recover as data arrives)    |
| Timezone                | A stay date near midnight in the hotel's timezone buckets to the correct DOW and lead time                        |

---

## 5. Fixture layout

```
tests/
  support/fixtures.ts             builders: quantile-ladder distributions,
                                  series, comp sets, queries
  fixtures/scenarios.ts           S1–S9 + S8b, each with a `protects` note
  scenarios.test.ts               runs every scenario against its expectation
  properties/invariants.test.ts   P1–P12
  unit/core.test.ts               money, stats, confidence factors, config
  unit/engine-edges.test.ts       defensive branches in factors and gates
db/checks/schema_checks.sql       9 schema behaviour checks
```

Scenarios are declarative TypeScript rather than JSON, so distributions can be generated from an explicit **quantile ladder** — `[[0, 62100], [0.085, 68500], [0.5, 74800], …]` — letting each scenario state exactly where the current rate should land and how fat the tails are. A JSON blob of 84 pre-computed values would say the same thing far less legibly.

Each scenario carries a `protects` string explaining what it guards, so a future engineer changing a weight can see immediately what they are about to break.

**Coverage requirement:** ≥ 90% branch and ≥ 95% line coverage on the scoring engine, the confidence calculator, and the recommendation gates, enforced by `vitest.config.ts` thresholds. (Revised down from "100% branch": some defensive branches — a zero denominator that upstream validation already prevents — are not reachable through the public API, and contorting the code to reach them would trade real safety for a coverage number.)
