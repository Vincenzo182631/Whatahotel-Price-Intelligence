# 02 — Deal Score v1

Covers proposal request 2. For each factor: data required, calculation, suggested weight, rationale.

---

## 1. What the Deal Score means

> **Deal Score = how attractive this specific rate is, for this specific room, right now — relative to what this room normally costs and what the market is doing.**

It is **not** a hotel quality score, **not** a value-for-money score against other hotels' absolute prices, and **not** a prediction. Stating this precisely matters because it determines what belongs in the formula: a premium hotel priced normally scores ~50, and a mediocre hotel deeply discounted scores high. That is correct behaviour.

### Scoring semantics: percentile, not percent-below-average

The proposal's example shows a rate ~8% below the 90-day average scoring **91**. A naive "percent below average × constant" mapping would need an arbitrary multiplier to reach 91 from 8%, and would behave erratically across hotels with different price volatility — 8% below average is unremarkable at a volatile resort and extraordinary at a stable city hotel.

**We use percentile rank instead.** A score of 91 means _"this rate is cheaper than roughly 91% of comparable observed rates for this room."_ That is:

- distribution-aware (self-calibrating to each hotel's volatility),
- unit-free and comparable across hotels,
- robust to outliers,
- and directly explainable to a customer in one sentence.

The proposal's example remains reachable and coherent under this definition. The percentage-below-average figure is still computed and displayed as a _supporting fact_ — it is just not the scoring mechanism.

---

## 2. Structure

Five factors, each producing a sub-score on 0–100, combined as a weighted mean over the factors that are **available** for the query.

```
DealScore = round( Σ (wᵢ_normalized × scoreᵢ) )   for i ∈ Available
where wᵢ_normalized = wᵢ / Σ(w over Available)
```

**Availability and redistribution.** Any factor lacking sufficient data is marked `UNAVAILABLE`, contributes nothing, and its weight is redistributed proportionally across the rest. This is preferable to substituting a neutral 50, which would drag every score toward the middle and mask missing data. Redistribution is visible: the analysis records which factors ran, and missing factors reduce the Confidence Score (doc 03).

**Hard requirements:**

- **F1 is mandatory.** Without a historical distribution there is no Deal Score → `INSUFFICIENT_DATA`.
- Available factors must carry at least `MIN_WEIGHT_COVERAGE` (default 0.55) of total weight → else `INSUFFICIENT_DATA`.

### Factor summary

| ID     | Factor                      | Weight         | Mandatory | Depends on   |
| ------ | --------------------------- | -------------- | --------- | ------------ |
| **F1** | Historical Price Percentile | **0.33**       | Yes       | U3, U4       |
| **F2** | Market / Comp-Set Position  | **0.28**       | No        | U12          |
| **F3** | Recent Price Movement       | **0.17**       | No        | U2, U3       |
| **F4** | Seasonality                 | **0.11**       | No        | ≥1yr history |
| ~~F5~~ | ~~Demand / Events~~         | **removed v2** | —         | see below    |
| **F6** | Effective Value (Benefits)  | **0.11**       | No        | U10          |
|        | **Total**                   | **1.00**       |           |              |

**All five weights are configurable** (`score.weight.*`, doc 10). They are starting priors, justified below, to be recalibrated once real data exists — see §4.

---

## 3. The factors

### F1 — Historical Price Percentile · weight 0.33 · mandatory

**Why it matters.** This is the question the customer actually asked: _is this cheap for this room?_ It is the only factor computable from our own data alone, the only one that works when the hotel has no comparables, and the most defensible to explain. It carries the largest weight because it is both the most relevant and the most reliable.

**Data required.** Historical distribution `H(Q)` (doc 01 §6): observations for `(hotel, room_type, comparability_class)` within the lookback window, filtered by the widening ladder. Requires U3 (history exists) and U4 (per-room rates). Minimum `MIN_OBS_ABS` = 12 observations, target `MIN_OBS_TARGET` = 30.

**Calculation.**

```
current  = current nightly amount (minor units, gross basis)
H        = baseline distribution for the query, outliers trimmed to [p1, p99]

pct_rank = ( |{h ∈ H : h < current}| + 0.5 × |{h ∈ H : h = current}| ) / |H|

score_F1 = 100 × (1 − pct_rank)
```

Mid-rank tie handling avoids a discontinuity when many observations sit at an identical rate (common with fixed seasonal pricing).

**Supporting facts emitted** (for display and explanation, not for scoring): `pct_below_median = (median − current) / median`, `median`, `p10`, `p90`, `min`, `max`, `n_observations`, `baseline_level`.

**Worked example** (proposal's case): current $689, median $748 → `pct_below_median` = 7.9%, displayed as "≈8% below the typical rate". If 9% of the 90-day observations were below $689, `pct_rank` = 0.09 and `score_F1` = 91.

**Edge cases.** All observations identical → `pct_rank` = 0.5, `score_F1` = 50, and volatility is zero which _raises_ confidence (correctly: a stable rate is confidently "normal"). Current rate below every observation → 100, and the `NEW_LOW` reason code fires.

---

### F2 — Market / Comp-Set Position · weight 0.28

**Why it matters.** A rate can be cheap for the hotel and still poor value if the whole market is discounting harder that week. This factor supplies the market context the proposal's "Market Comparison" feature promises, and it is the second-largest weight because it is the one signal F1 structurally cannot see.

**Data required.** A comparable set (U12): hotels in the same destination, same luxury tier, overlapping price band, `MIN_COMPS` (default 3) of which must have a **fresh** rate for the same stay dates and the same comparability class. Each comp also needs its own baseline median.

**Calculation — compare discount depth, not absolute price.**

Comparing raw prices would simply report that a Ritz-Carlton costs more than a Marriott — true, useless, and it would permanently suppress scores at premium hotels. Instead we compare how far each hotel is discounting _relative to its own norm_:

```
For the subject hotel h:
    index_h = current_nightly_h / median(H(h))

For each comparable j with a fresh rate for these dates:
    index_j = current_nightly_j / median(H(j))

score_F2 = 100 × (1 − pct_rank of index_h among {index_j} ∪ {index_h})
```

An index of 0.85 means "priced 15% below its own norm". If every comparable sits at 1.02 while the subject sits at 0.85, the subject is the standout and `score_F2` approaches 100.

**Supporting fact for display.** The proposal's example phrasing ("8% below comparable hotels") is a _raw_ median comparison and is computed separately for display:
`pct_vs_comp_median = (median(current_nightly_j) − current_nightly_h) / median(current_nightly_j)`.
This is shown to the customer; `index`-based percentile is what scores. Keeping them distinct prevents a premium hotel from being penalized in the score while still giving the customer the plain comparison they expect.

**Unavailable when** fewer than `MIN_COMPS` comparables have fresh same-date rates, or the subject lacks its own baseline median. Weight redistributes; `f_coverage` in the Confidence Score drops.

---

### F3 — Recent Price Movement · weight 0.17

**Why it matters.** Direction of travel changes what to do with the same score. A rate at the 60th percentile that has been climbing 3% a week is a better thing to book today than the same rate drifting down. Weighted moderately in the _score_ — because movement describes urgency more than attractiveness — and weighted heavily in the _recommendation engine_ (doc 03 §3), which is where it belongs.

**Data required.** Same-stay series `S(Q)` — repeated observations of the identical stay tuple (requires U2, U8 for stable rate plan codes). Minimum `MIN_SERIES_POINTS` = 4 observations within the window.

**Calculation.**

```
window   = TREND_WINDOW_DAYS (default 7; 14 and 30 also computed for display)
slope    = Theil–Sen estimator over (observed_at, nightly) pairs in window
delta_pct = (slope × window) / nightly_at_window_start

score_F3 = clamp( 50 + delta_pct × TREND_GAIN , 0 , 100 )
```

`TREND_GAIN` default **250**: a +10% move over 7 days yields 50 + 25 = 75; −10% yields 25. Chosen so that a 20% weekly swing — near the practical extreme for a single stay — saturates the factor without clipping ordinary movement.

**Theil–Sen rather than least squares** because it tolerates the occasional spurious capture (a flash sale, a mis-parsed rate) without swinging the trend. With only 4–10 points, one bad value would dominate an OLS slope.

> **Implementation finding.** That robustness is real at 8 points (a single endpoint spike leaves the slope exactly correct, where OLS is dragged sevenfold) but **not at the configured 4-point minimum** — with four points, an endpoint outlier contaminates 3 of the 6 pairwise slopes, enough to move the median. Raising `score.trend.min_series_points` to 6 would close the gap at the cost of making F3 unavailable more often early on. Both behaviours are covered by explicit unit tests; the choice is left for calibration rather than made unilaterally.

**Sign convention.** Rising price → higher score: the rate in front of the customer is better than what is coming. This is deliberate and is the one place where the Deal Score incorporates timing rather than pure price level. Flagged for calibration review — if it proves to confuse customers ("why did the score go up when the price went up?"), the alternative is to move F3's entire weight into the recommendation engine and drop it from the score. **D7: decision deferred to calibration.**

**Unavailable when** fewer than `MIN_SERIES_POINTS` observations of the same stay exist — which will be common at launch for stays nobody has queried before.

---

### F4 — Seasonality · weight 0.11

**Why it matters.** Identifies structurally cheap periods — a shoulder-season rate is genuinely attractive in a way a peak-season rate at the same percentile is not.

**⚠️ Double-counting warning.** F1's baseline is _already stratified by season band_ at ladder levels L0–L2. A separate seasonality factor therefore risks measuring the same thing twice. F4 is deliberately scoped to capture only what F1 cannot: the **absolute** seasonal position of the stay date, rather than the rate's position within its season.

**Data required.** At least `SEASONALITY_MIN_HISTORY_DAYS` (default 365) of observations for the hotel, or a destination-level seasonal calendar. **At MVP launch this will almost certainly be UNAVAILABLE** unless U3 reveals a year or more of existing history. This is stated plainly rather than assumed away — F4 is specified so the shape is settled, but it should be expected to sit dormant and redistribute its weight until history matures.

**Calculation.**

```
seasonal_index = median(rates for hotel/room in this season band, all history)
                 / median(rates for hotel/room across all season bands)

score_F4 = clamp( 50 + (1 − seasonal_index) × SEASON_GAIN , 0 , 100 )
```

`SEASON_GAIN` default **150**: a season priced 20% below the annual norm scores 80.

**Calibration guard.** Once ≥ 1 year of data exists, compute the correlation between `score_F1` and `score_F4` across a sample. If |r| > `SEASON_CORR_MAX` (default 0.6), F4 is redundant and its weight should be folded into F1. This check is a required item in the calibration runbook.

---

### F5 — Demand / Events · **REMOVED in config v2**

**Removed from the Deal Score.** F5 was an affine function of F1 and therefore carried no independent information about price attractiveness.

The original definition was `score_F5 = 50 + D·50·(1 − 2P)`. Since `F1 = 100(1 − P)`, substituting gives:

```
score_F5 = (50 − 50D) + D · score_F1
```

At constant demand pressure the correlation with F1 is exactly 1.0; the calibration harness measured 0.82 across a sample where D varied. F5's weight was therefore borrowed from F1 rather than adding a sixth perspective, and the factor-correlation check failed on it correctly.

**Demand did not go away — it moved to where it is genuinely independent.** It continues to drive:

- **Gate G3**, where demand pressure ≥ 0.60 routes a merely decent rate to BOOK_NOW. (It also drove guard W4, which blocked WAIT; WAIT was retired in config v4.)
- **Gate G3**, the urgency path to BOOK_NOW.
- **A displayed reason** (`EVENT_DRIVEN_DEMAND`), so the customer is still told _why_ a rate is elevated.

These act on the **recommendation**, not on the score, so they cannot double-count the percentile. That is the distinction the original design missed.

**Weight redistribution.** F5's 0.10 was redistributed proportionally across the remaining five factors, preserving their intended relative importance:

| Factor         | v1   | v2       |
| -------------- | ---- | -------- |
| F1 Historical  | 0.30 | **0.33** |
| F2 Market      | 0.25 | **0.28** |
| F3 Trend       | 0.15 | **0.17** |
| F4 Seasonality | 0.10 | **0.11** |
| F6 Value       | 0.10 | **0.11** |

Folding the whole 0.10 into F1 was considered and rejected: although F5's contribution was partly F1's in disguise, moving it all there would push F1 beyond the importance the original design intended relative to F2 and F3.

### F6 — Effective Value / Benefits · weight 0.11

**Why it matters.** The proposal (§5) names this the major differentiator, and it is where WhataHotel's preferred-partner relationships convert into something a competitor cannot copy. It is weighted at 0.11 not because it matters little, but because **benefit data quality at MVP is the least certain input** (U10) — a weight that reflects data confidence, not strategic importance. Expected to rise substantially in Phase 2 when Effective Stay Value becomes a full surface.

**Data required.** Structured benefits attached to the rate plan or hotel (U10), each with a monetary valuation or valuation rule, and a per-stay vs per-night basis.

**Valuation rules** (configurable, per benefit type):

| Benefit                                | Basis     | Default valuation                                                                     |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------------- |
| Breakfast for 2                        | per night | Configured per hotel tier, or hotel's published price × `BREAKFAST_REALIZATION` (0.7) |
| Hotel/resort credit                    | per stay  | Face value × `CREDIT_REALIZATION` (0.8) — not all credit is used                      |
| Room upgrade (subject to availability) | per stay  | Price delta to next tier × `UPGRADE_PROBABILITY` (0.35)                               |
| Late checkout                          | per stay  | Flat configured value                                                                 |
| Welcome amenity                        | per stay  | Flat configured value                                                                 |

The realization discounts are the honest part of this design: a benefit that _might_ materialize is not worth its face value, and pretending otherwise would inflate every preferred-partner rate. All are configurable and should be calibrated against actual redemption data once available.

**Calculation.**

```
benefit_value_per_night = ( Σ per_night_values ) + ( Σ per_stay_values / nights )
benefit_value_per_night = min( benefit_value_per_night,
                               nightly × BENEFIT_CAP_PCT )        -- default cap 0.25

value_ratio      = benefit_value_per_night / nightly
effective_nightly = nightly − benefit_value_per_night

score_F6 = clamp( 50 + value_ratio × VALUE_GAIN , 0 , 100 )       -- VALUE_GAIN default 200
```

The cap prevents an implausible benefit valuation from dominating the score.

**D2 — does `effective_nightly` replace `nightly` in F1/F2?** **Recommendation: no, not in v1.** Historical observations will have inconsistent benefit coverage, so scoring effective-against-nominal would produce a systematic phantom discount. `effective_nightly` is computed, stored and displayed, but the baseline comparison stays nominal-to-nominal. Revisit once benefit coverage on historical rows is measured.

---

## 4. Score bands and calibration

| Band          | Range  | Customer label |
| ------------- | ------ | -------------- |
| Excellent     | 85–100 | Excellent rate |
| Good          | 70–84  | Good rate      |
| Fair          | 50–69  | Typical rate   |
| Below average | 30–49  | Above typical  |
| Poor          | 0–29   | Expensive      |

Boundaries configurable (`score.band.*`). Band label — never the bare number — is the primary UI element at low confidence (doc 08, decision D4).

### Why these weights

The priors follow a single rule: **weight tracks a factor's reliability and its relevance to the question asked**, in that order.

- F1 (0.33) — directly answers the question and rests on our own data. Highest on both counts.
- F2 (0.28) — the only external check on F1; slightly lower because it depends on comp-set quality (U12) that we do not yet control.
- F3 (0.17) — genuinely informative but describes timing more than attractiveness, and its main job is in the recommendation engine.
- F4, F6 (0.11 each) — each contributes real signal but each rests on the least certain data. Equal weights are a deliberate admission that we have no basis yet to rank them; calibration should separate them.

**These are priors, not findings.** They must not survive contact with real data unexamined.

### Calibration runbook (post-launch, before any weight is treated as settled)

1. **Distribution check** — scores across a representative query sample should be broadly centred near 50 with usable spread. A mean far off 50, or mass piled at the extremes, indicates a mis-set gain constant.
2. **Factor correlation matrix** — any pair with |r| > 0.6 is double-counting; fold one into the other. **F1/F5 was found this way and F5 was removed in v2**; F1/F4 remains the outstanding suspect.
3. **Retrospective accuracy** — for stays where later observations exist, did BOOK_NOW rates in fact prove cheaper than the subsequent 14-day minimum? Track the rate at which a BOOK_NOW was beaten (`book_now_regret_rate`); target below `REGRET_TARGET` (10%).
4. _(retired in config v4)_ — this slot held WAIT validation: for WAIT recommendations, did the price actually fall within 14 days? With no such recommendation there is nothing to measure. The metric numbering keeps the hole so older calibration reports stay readable.
5. **Score stability** — the same query re-run a day later should not swing more than `STABILITY_MAX_DELTA` (10 points) absent a real price change. Instability signals a starved baseline.

Every one of these is measurable from data the system already persists (doc 05 `analysis` table), which is why the analysis record stores the full factor breakdown and config version.
