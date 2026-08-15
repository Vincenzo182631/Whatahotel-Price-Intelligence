# 03 — Confidence Score and the BOOK NOW / WAIT Engine

Covers proposal requests 3 and 4.

---

## 1. What Confidence means

> **Confidence = how much we trust this Deal Score, given the quantity, freshness, consistency and cleanliness of the data behind it.**

Confidence measures the *evidence*, never the *price*. A rate can score 95 with 30% confidence (a spectacular-looking deal on three stale observations of a badly matched room) or 50 with 95% confidence (an unambiguously ordinary rate). These are different situations and the customer must be able to tell them apart.

Confidence has one job in the product: **it gates what we are willing to recommend.** A high Deal Score with low confidence must never become a confident instruction.

---

## 2. The six confidence factors

Each produces a value in `[0, 1]`. Data sources are the same records used for scoring, so no additional capture is required.

### 2.1 `f_volume` — historical data volume

**Effect: more observations → higher confidence, with diminishing returns.**

```
n = |H(Q)|  (observations in the baseline after outlier trimming)

f_volume = min( 1, ln(1 + n) / ln(1 + VOLUME_TARGET_N) )     -- default target 60
```

Logarithmic because the 5th observation adds far more certainty than the 55th. At n = 12 (`MIN_OBS_ABS`) this yields ≈ 0.61; at 30 ≈ 0.84; at 60 = 1.0. Below `MIN_OBS_ABS` the engine does not compute a confidence at all — it returns `INSUFFICIENT_DATA` (§3, gate G0).

### 2.2 `f_freshness` — data freshness

**Effect: stale data collapses confidence quickly.** Hotel rates move daily; a five-day-old price is not a current price.

```
age_h = hours since the *current rate* was observed

f_freshness = 1.0                                     if age_h ≤ FRESH_FULL_HOURS   (6)
            = linear 1.0 → 0.2 across the interval    if FRESH_FULL < age_h ≤ FRESH_ZERO_HOURS (72)
            = 0.05                                    if age_h > FRESH_ZERO_HOURS
```

Piecewise-linear rather than exponential decay because it is explainable to a non-technical reviewer and its behaviour at the boundaries is obvious. Beyond 72 hours the value is a floor rather than zero so that the geometric mean does not annihilate — but at 0.05 it will drive the result below every action threshold anyway, which is the intent.

A second, weaker term applies to the *baseline* rather than the current rate: if `rate_baseline.computed_at` is older than `BASELINE_MAX_AGE_HOURS` (24), multiply `f_freshness` by 0.9.

### 2.3 `f_consistency` — cross-source agreement

**Effect: sources disagreeing about the same rate means at least one is wrong.**

```
Take observations of the same tuple within the same observation slot, across sources.
cv_sources = stddev(nightly) / mean(nightly)

f_consistency = 1 − min( 1, cv_sources / CONSISTENCY_CV_MAX )   -- default 0.15

Single source only → f_consistency = SINGLE_SOURCE_CONFIDENCE   -- default 0.85
```

The single-source default is below 1.0 deliberately: with one source we have no corroboration, and claiming full confidence would overstate what we know. It is not punitive (0.85) because a single authoritative first-party source is a legitimate and probably common situation at MVP.

### 2.4 `f_coverage` — market coverage

**Effect: a market comparison built on two hotels is weak.**

```
f_coverage = min( 1, n_fresh_comps / COVERAGE_TARGET_COMPS )    -- default 5
```

**Only included when factor F2 actually ran.** If F2 is UNAVAILABLE, `f_coverage` is excluded from the product and its weight redistributes — the absence of a market comparison is already penalized once via `f_completeness` (§2.7); charging for it twice would double-count.

### 2.5 `f_volatility` — price volatility

**Effect: a wildly volatile rate makes any point-in-time judgement less reliable.**

```
cv_hist = stddev(H) / mean(H)          (on trimmed distribution)

f_volatility = 1 − min( 1, cv_hist / VOLATILITY_CV_MAX )        -- default 0.35
f_volatility = max( f_volatility, VOLATILITY_FLOOR )            -- default 0.25
```

The floor exists because high volatility does not make the percentile *meaningless* — a rate at the 5th percentile of a volatile distribution is still genuinely low. It makes it less durable, which is a confidence question, not a validity question. Note that `f_volatility` also directly blocks WAIT (§3) — the recommendation is where volatility does its real damage.

### 2.6 `f_match` — room and rate matching quality

**Effect: if we are not sure the historical rows describe the same room, nothing downstream is trustworthy.** This is the factor most likely to catch a silent catastrophe.

```
Per-observation weight by match method:
    SOURCE_ID           1.00
    ALIAS_EXACT         0.95
    ALIAS_FUZZY         0.60–0.90  (scaled by trigram similarity)
    ATTRIBUTE_INFERRED  0.50
    UNMATCHED           excluded from H entirely

f_match = weighted mean of match_confidence over H ∪ {current}

Additional penalties (multiplicative):
    × 0.90  if the current rate's comparability_class is UNRESOLVED
    × 0.85  if > UNRESOLVED_SHARE_MAX (0.20) of H is UNRESOLVED
```

### 2.7 `f_completeness` — factor coverage *(added beyond the six requested)*

**Effect: a Deal Score built from two of six factors deserves less trust than one built from six.**

```
weight_coverage = Σ(weights of available factors) / Σ(all weights)
f_completeness  = COMPLETENESS_FLOOR + (1 − COMPLETENESS_FLOOR) × weight_coverage
```

This is not in the requested list but is required to keep the design honest: doc 02 redistributes weight when factors are missing, which would otherwise let a one-factor score present as confidently as a six-factor one. Without it, missing data is invisible in the output.

**Why a floor rather than the raw ratio** (`COMPLETENESS_FLOOR`, default 0.75). F4 (seasonality) and F5 (demand) are expected to be UNAVAILABLE at launch *by design* — F4 needs a year of history, F5 needs an events feed we may not have. Applying the raw coverage ratio would cap every confidence score at roughly 80 permanently, penalising the product for a known, planned data gap rather than for a data-quality problem. The floor keeps the penalty meaningful without making it structural. Discovered while building the scenario suite: under the raw ratio, S1 — a textbook excellent deal on clean data — could not reach the HIGH confidence band.

### 2.8 Baseline level multiplier

Not a factor but a direct multiplier from the widening ladder (doc 01 §6):

| Level | L0 | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| Multiplier | 1.00 | 0.95 | 0.88 | 0.80 | 0.60 |

---

## 3. Combining confidence — and why it is multiplicative

```
Confidence = 100 × baseline_level_multiplier × Π ( fᵢ ^ (wᵢ / Σw) )
             over the included factors
```

**Suggested factor weights** (configurable, `confidence.weight.*`):

| Factor | Weight | Rationale |
|---|---|---|
| `f_volume` | 0.25 | The foundation — no amount of freshness rescues n = 4 |
| `f_freshness` | 0.20 | A stale price is the most common real-world failure |
| `f_match` | 0.20 | The most damaging failure when it goes wrong |
| `f_volatility` | 0.15 | Bounds how durable the judgement is |
| `f_consistency` | 0.10 | Valuable but often unavailable (single source) |
| `f_coverage` | 0.10 | Only when F2 ran |
| `f_completeness` | applied as a multiplier | Prevents thin scores presenting as thick ones |

**Weighted geometric mean, not arithmetic.** This is the key design choice. With an arithmetic mean, five strong factors mask one catastrophic one: data three weeks stale (`f_freshness` = 0.05) alongside five factors at 0.9 still averages ≈ 0.76 — which would let the system confidently recommend action on a price that no longer exists. Under a geometric mean the same inputs yield ≈ 0.45, and the recommendation engine correctly refuses to say WAIT.

The principle: **confidence should be limited by its weakest evidence, not rescued by its strongest.** Any single factor approaching zero should approach zero overall, and only the geometric mean has that property.

### Confidence bands

| Band | Range | Meaning |
|---|---|---|
| High | 75–100 | Full recommendation, full detail |
| Moderate | 55–74 | Recommendation shown with caveats |
| Low | 40–54 | Score band shown, BOOK_NOW/CONSIDER only, never WAIT |
| Insufficient | 0–39 | No score shown → `INSUFFICIENT_DATA` |

---

## 4. The recommendation engine

Four outputs: `BOOK_NOW`, `WAIT`, `CONSIDER`, `INSUFFICIENT_DATA`.

The engine is a **strictly ordered gate sequence. First match wins.** Ordering is the mechanism that makes the safety rules unconditional — the never-WAIT guards are evaluated before any path that could emit WAIT, so no combination of inputs can route around them.

Every evaluation records which gate fired and every guard that tripped, in `analysis.decision_trace`.

### Gate G0 — data sufficiency → `INSUFFICIENT_DATA`

Fires if **any** of:

| Condition | Default threshold | Config key |
|---|---|---|
| Factor F1 unavailable | — | — |
| `n_observations` < 12 | `MIN_OBS_ABS` | `rec.min_obs_abs` |
| Weight coverage < 0.55 | `MIN_WEIGHT_COVERAGE` | `score.min_weight_coverage` |
| `f_match` < 0.50 | `MATCH_MIN` | `rec.match_min` |
| Current rate age > 24h | `MAX_CURRENT_AGE_HOURS` | `rec.max_current_age_hours` |
| Confidence < 40 | `CONF_FLOOR` | `rec.confidence_floor` |
| Baseline level = L4 **and** confidence < 55 | | `rec.l4_confidence_min` |

Output carries reason codes explaining *which* data is missing — the UI must say "we don't have enough history for this room yet", never fail silently or show a fabricated score.

### Gate G1 — never-WAIT guards

Evaluated next, **before** any recommendation is chosen. Each sets `wait_blocked = true` with a reason code. These do not by themselves produce an output; they remove WAIT from the set of possible outputs.

| # | Guard | Default | Why |
|---|---|---|---|
| W1 | Confidence < `WAIT_MIN_CONFIDENCE` | **70** | **The mandatory rule.** Telling someone to wait on weak evidence risks real money |
| W2 | `lead_time_days` < `WAIT_MIN_LEAD_DAYS` | 10 | Too close to the stay for a decline to plausibly materialize |
| W3 | 7-day trend rising ≥ `WAIT_RISE_BLOCK_PCT` | 2% | Prices are moving against the customer |
| W4 | `demand_pressure` ≥ `WAIT_DEMAND_BLOCK` | 0.60 | Event or sellout pressure — rates will not soften |
| W5 | Scarcity: `rooms_left` ≤ `SCARCITY_BLOCK` (where U11 available) | 3 | The room may simply be gone |
| W6 | `f_volatility` < `WAIT_MIN_VOL_CONFIDENCE` | 0.40 | Too erratic to time |
| W7 | Only non-refundable inventory available | — | No downside protection if wrong |
| W8 | Baseline level ≥ L3 | — | Baseline too loose to assert a rate is high |

**W1 is the hard requirement.** It is implemented in three independent places so it cannot regress:
1. Gate G1 itself;
2. an assertion at the engine's return boundary — `if (rec === WAIT && confidence < WAIT_MIN_CONFIDENCE) throw`;
3. a property-based test over generated inputs asserting the invariant holds universally (doc 07 §3).

Defence in depth is warranted because this is the rule with the clearest path to customer harm.

### Gate G2 — strong deal → `BOOK_NOW`

```
deal_score ≥ BOOK_SCORE_MIN (72)  AND  confidence ≥ BOOK_MIN_CONFIDENCE (60)
```
The confidence bar for BOOK_NOW (60) is deliberately lower than for WAIT (70). The asymmetry is intentional: booking a rate at the 15th percentile with moderate evidence has bounded downside — the customer gets a demonstrably below-average rate and, on a refundable plan, can rebook. Waiting has unbounded downside: the rate can rise, or the room can vanish. **Our error costs are asymmetric, so our thresholds are too.**

### Gate G3 — urgency → `BOOK_NOW`

```
deal_score ≥ BOOK_URGENCY_SCORE (60)
AND confidence ≥ BOOK_MIN_CONFIDENCE (60)
AND ( trend_7d ≥ URGENCY_RISE_PCT (3%)
      OR demand_pressure ≥ URGENCY_DEMAND (0.60)
      OR rooms_left ≤ SCARCITY_BLOCK (3) )
```
A merely decent rate that is actively climbing is worth acting on. Reason code distinguishes G2 from G3 so the explanation says "good rate *and* rising" rather than "excellent rate".

### Gate G4 — poor deal, safe to wait → `WAIT`

```
NOT wait_blocked
AND deal_score ≤ WAIT_SCORE_MAX (42)
AND confidence ≥ WAIT_MIN_CONFIDENCE (70)      -- redundant with W1, intentionally restated
AND trend_7d ≤ WAIT_MAX_TREND_PCT (0%)          -- flat or falling
AND lead_time_days ≥ WAIT_MIN_LEAD_DAYS (10)    -- redundant with W2, intentionally restated
```
The redundancy with G1 is deliberate belt-and-braces on the only genuinely risky output.

### Gate G5 — default → `CONSIDER`

Everything else. `CONSIDER` is the honest middle: the rate is ordinary, or the signals conflict, or confidence supports a score but not a directive. **It should be the most common output**, and the UI must present it as informative rather than as a failure to decide (doc 08).

---

## 5. Decision matrix

Illustrative outcomes at default thresholds:

| Deal Score | Confidence | 7d Trend | Demand | Lead | → Output | Gate |
|---|---|---|---|---|---|---|
| 91 | 88 | +9% | low | 35d | **BOOK_NOW** | G2 |
| 78 | 65 | flat | low | 60d | **BOOK_NOW** | G2 |
| 64 | 72 | +5% | low | 40d | **BOOK_NOW** | G3 |
| 64 | 72 | flat | low | 40d | **CONSIDER** | G5 |
| 88 | 45 | flat | low | 40d | **CONSIDER** | G5 — conf < 60 blocks BOOK_NOW |
| 30 | 82 | −4% | low | 45d | **WAIT** | G4 |
| 30 | 62 | −4% | low | 45d | **CONSIDER** | G5 — **W1 blocks WAIT** |
| 30 | 82 | −4% | low | 5d | **CONSIDER** | G5 — W2 blocks WAIT |
| 25 | 85 | +3% | low | 50d | **CONSIDER** | G5 — W3 blocks WAIT |
| 28 | 80 | −5% | 0.8 | 40d | **CONSIDER** | G5 — W4 blocks WAIT |
| 95 | 35 | — | — | — | **INSUFFICIENT_DATA** | G0 |
| any | any (n = 7) | — | — | — | **INSUFFICIENT_DATA** | G0 |

Note rows 7–10: a poor score with good confidence still does not yield WAIT whenever any guard trips. **The system is designed to under-recommend WAIT.** That is the correct bias — the cost of a wrong WAIT is a customer who loses a room or pays more and blames WhataHotel; the cost of an unnecessary CONSIDER is a customer who reads one more sentence.

---

## 6. Output contract

Every evaluation returns:

```
recommendation      : BOOK_NOW | WAIT | CONSIDER | INSUFFICIENT_DATA
deal_score          : 0–100 | null        (null when INSUFFICIENT_DATA)
deal_score_band     : EXCELLENT | GOOD | FAIR | BELOW_AVERAGE | POOR | null
confidence          : 0–100
confidence_band     : HIGH | MODERATE | LOW | INSUFFICIENT
gate_fired          : G0 | G2 | G3 | G4 | G5
wait_blocked_by     : [W1, W4, …]
reason_codes        : [ … ]                (ordered by contribution, doc 04)
factors             : per-factor breakdown with availability, raw value, sub-score, weight
data_as_of          : timestamptz          (observation time of the current rate)
baseline_level      : L0–L4
config_version      : int
```

`gate_fired`, `wait_blocked_by` and `factors` are persisted for every analysis. They are what makes a customer complaint answerable months later, and they are the raw material for the calibration runbook in doc 02 §4.
