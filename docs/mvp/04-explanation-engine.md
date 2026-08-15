# 04 — Explanation Engine

Covers proposal request 5. Implements the proposal's §8 principle: _"The AI should not be responsible for deciding whether a rate is good… with AI used to explain the result in natural language."_

---

## 1. The contract

```
   Scoring Engine  ──►  ExplanationBundle  ──►  LLM  ──►  validator  ──►  prose
   (deterministic)      (facts only, JSON)                (numeric        (cached)
                                                           allowlist)
                                │
                                └──────────────────────────► deterministic template
                                                              (fallback, always available)
```

**The language model receives the bundle and nothing else.** No raw observations, no database access, no tools, no ability to recompute. Its entire job is to turn a list of computed facts into two or three readable sentences.

Three properties make this structurally true rather than merely intended:

1. **The bundle is the only input.** The prompt is assembled from the bundle; there is no retrieval step and no raw-data channel.
2. **Output is validated against the bundle before display** (§4). Any number the model emits that is not in the bundle's allowlist rejects the output.
3. **A deterministic template renderer exists for every bundle shape.** If the model is unavailable, slow, or fails validation, the customer sees correct prose anyway. The AI layer is an enhancement, never a dependency.

---

## 2. The `ExplanationBundle`

Emitted by the scoring engine, persisted with the analysis, hashed for cache keying.

```jsonc
{
  "bundle_version": 1,
  "analysis_id": "an_01J9X…",
  "config_version": 7,

  "subject": {
    "hotel_name": "The Ritz-Carlton Miami Beach",
    "room_type_name": "Ocean View King",
    "check_in": "2026-09-18",
    "check_out": "2026-09-21",
    "nights": 3,
    "adults": 2,
    "children": 0,
    "rate_plan_summary": "Breakfast included · Flexible cancellation",
  },

  "verdict": {
    "recommendation": "BOOK_NOW",
    "deal_score": 91,
    "deal_score_band": "EXCELLENT",
    "confidence": 88,
    "confidence_band": "HIGH",
    "gate_fired": "G2",
  },

  "price": {
    "currency": "USD",
    "nightly_minor": 68900,
    "total_minor": 206700,
    "tax_basis": "GROSS",
    "effective_nightly_minor": 65900,
    "observed_at": "2026-08-14T09:12:00Z",
  },

  "baseline": {
    "level": "L0",
    "n_observations": 84,
    "lookback_days": 90,
    "median_nightly_minor": 74800,
    "p10_nightly_minor": 65200,
    "p90_nightly_minor": 88100,
    "min_nightly_minor": 62100,
    "max_nightly_minor": 92500,
  },

  // Ordered by contribution to the verdict, strongest first.
  "factors": [
    {
      "code": "BELOW_HISTORICAL_AVERAGE",
      "direction": "POSITIVE",
      "magnitude": 7.9,
      "unit": "PERCENT",
      "fact": "The current rate is 7.9% below the typical rate for this room over the last 90 days.",
      "supporting": { "current_minor": 68900, "median_minor": 74800, "percentile": 9 },
    },
    {
      "code": "BELOW_COMPARABLE_HOTELS",
      "direction": "POSITIVE",
      "magnitude": 8.0,
      "unit": "PERCENT",
      "fact": "The rate is 8% below the median of 6 comparable luxury hotels for the same dates.",
      "supporting": { "comp_count": 6, "comp_median_minor": 74900 },
    },
    {
      "code": "PRICE_RISING_7D",
      "direction": "POSITIVE",
      "magnitude": 9.0,
      "unit": "PERCENT",
      "fact": "The rate for this stay has increased 9% over the past 7 days.",
      "supporting": { "window_days": 7, "start_minor": 63200 },
    },
    {
      "code": "BENEFITS_INCLUDED",
      "direction": "POSITIVE",
      "magnitude": 3000,
      "unit": "CURRENCY_MINOR",
      "fact": "Included benefits are valued at about $30 per night, giving an effective rate of $659.",
      "supporting": { "benefits": ["Breakfast for 2", "$100 hotel credit"] },
    },
  ],

  "caveats": [],

  "constraints": {
    "allowed_numbers": [91, 88, 7.9, 8, 9, 84, 90, 6, 689, 748, 652, 881, 621, 925, 659, 30, 3, 2],
    "currency_symbol": "$",
    "must_not_predict": true,
    "max_sentences": 3,
  },
}
```

### Field rules

- **Every element of `factors` is already computed.** `fact` is a complete, correct, human-readable sentence produced deterministically by the engine. The model's job is to _select and combine_ these, not to derive them.
- **`magnitude` is always a number with an explicit `unit`** (`PERCENT`, `CURRENCY_MINOR`, `DAYS`, `COUNT`, `SCORE`) so the renderer and the validator never have to parse prose.
- **`direction`** is `POSITIVE` / `NEGATIVE` / `NEUTRAL` _with respect to the customer's interest_, not with respect to price. A falling price is `NEGATIVE` for a BOOK_NOW verdict.
- **`caveats`** carries anything qualifying the verdict — thin baseline, loose ladder level, high volatility, poor matching. When non-empty the UI must display at least one, and the explanation must mention it.

### Reason code enum

Positive: `BELOW_HISTORICAL_AVERAGE`, `NEAR_HISTORICAL_LOW`, `NEW_LOW`, `BELOW_COMPARABLE_HOTELS`, `PRICE_RISING_7D`, `LOW_SEASON`, `BENEFITS_INCLUDED`, `HIGH_DEMAND_RATE_STILL_LOW`, `LIMITED_AVAILABILITY`.

Negative: `ABOVE_HISTORICAL_AVERAGE`, `NEAR_HISTORICAL_HIGH`, `ABOVE_COMPARABLE_HOTELS`, `PRICE_FALLING_7D`, `PEAK_SEASON`, `EVENT_DRIVEN_DEMAND`, `NO_BENEFITS_INCLUDED`.

Caveats: `LIMITED_HISTORY`, `BASELINE_WIDENED`, `HIGH_VOLATILITY`, `STALE_DATA`, `WEAK_ROOM_MATCH`, `SINGLE_SOURCE`, `NO_COMPARABLES`, `SHORT_LEAD_TIME`, `UNRESOLVED_RATE_TERMS`.

Each code maps to a fixed template string, so the deterministic fallback covers every possible bundle without gaps.

---

## 3. Prompt contract

System prompt (fixed, versioned alongside `bundle_version`):

> You write one short paragraph explaining a hotel price assessment to a traveler.
>
> You will receive a JSON object containing facts that have already been calculated. Your only task is to express those facts in natural, confident prose.
>
> Rules:
>
> - Use only the facts provided. Never calculate, infer, estimate, or add information.
> - Never state or imply a number that does not appear in `constraints.allowed_numbers`.
> - Never predict what a price will do in the future.
> - Never contradict or soften `verdict.recommendation`.
> - If `caveats` is non-empty, mention at least one plainly.
> - Maximum `constraints.max_sentences` sentences. No lists, no headings, no emoji.
> - Lead with the single most important factor, which is the first element of `factors`.

Model call parameters: temperature ≤ 0.3, capped output tokens, hard timeout `EXPLANATION_TIMEOUT_MS` (default 2500). On timeout → template fallback. The customer never waits on the model.

---

## 4. Output validation

Applied to every model response before it can be displayed. Any failure discards the response and renders the template instead — silently to the customer, loudly to monitoring.

| #   | Check                    | Rule                                                                                                                                                                                                                                                   |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1  | **Numeric allowlist**    | Extract every numeral from the output (including those inside `$1,234` and `8%`). Each must appear in `constraints.allowed_numbers` within a rounding tolerance of `NUMERIC_TOLERANCE` (0.5). This is the primary guard against fabricated statistics. |
| V2  | **Verdict consistency**  | Output must not contain language contradicting the recommendation (a WAIT-flavoured phrase under a BOOK_NOW verdict, or vice versa), checked against a phrase list per verdict.                                                                        |
| V3  | **No prediction**        | Reject forward-looking claims about price ("will drop", "expect to fall", "prices should"), matched against a prohibited-pattern list. The system does not forecast in MVP and must not appear to.                                                     |
| V4  | **Caveat coverage**      | If `caveats` is non-empty, at least one caveat concept must appear.                                                                                                                                                                                    |
| V5  | **Length and format**    | Within sentence cap; no markdown, links, or HTML.                                                                                                                                                                                                      |
| V6  | **No invented entities** | Hotel and room names appearing in the output must match `subject`.                                                                                                                                                                                     |

Validation failures are logged with the bundle hash and the offending text, and tracked as `explanation_validation_failure_rate`. A sustained rise is a signal to revisit the prompt — and, because the fallback always renders, never a customer-facing incident.

---

## 5. Caching

Key: `sha256(bundle_json_canonical) + locale + prompt_version`.

Because the bundle contains rounded, discretized facts, many distinct queries produce identical bundles and share a cached explanation. Expected hit rate is high, which matters for cost (R7 in the assessment). TTL `EXPLANATION_CACHE_TTL_HOURS` (default 24), and entries are invalidated whenever `config_version` or `prompt_version` changes.

---

## 6. Deterministic fallback renderer

Pure function, no I/O, no model. Composes the top `MAX_TEMPLATE_FACTORS` (3) `fact` strings plus a verdict clause and any caveat.

Example output for the bundle above:

> The current rate is 7.9% below the typical rate for this room over the last 90 days, and 8% below the median of 6 comparable luxury hotels for the same dates. The rate for this stay has increased 9% over the past 7 days. Based on this, we recommend booking now.

Serviceable, accurate, and shippable on its own. **The MVP should launch with the fallback path fully working before the model path is enabled**, so the AI layer can be turned off at any moment without customer impact.
