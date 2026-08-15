# 06 — MVP API

Covers proposal request 7. REST/JSON over HTTPS. Base path `/api/v1`.

**Conventions.** `snake_case` JSON. All monetary values as `{ "amount_minor": 68900, "currency": "USD" }` — never a bare float. All timestamps RFC 3339 UTC. Dates `YYYY-MM-DD`. `GET` for everything customer-facing (cacheable, shareable, prerenderable for the Phase 5 SEO pages).

---

## 1. Endpoint summary

| Method  | Path                                      | Purpose                        | Auth          |
| ------- | ----------------------------------------- | ------------------------------ | ------------- |
| GET     | `/api/v1/health`                          | Liveness + data freshness      | none          |
| GET     | `/api/v1/hotels`                          | Hotel search / autocomplete    | public key    |
| GET     | `/api/v1/hotels/{hotel_id}`               | Hotel detail                   | public key    |
| GET     | `/api/v1/hotels/{hotel_id}/room-types`    | Bookable room types for a stay | public key    |
| **GET** | **`/api/v1/price-intelligence`**          | **The analysis. The product.** | public key    |
| GET     | `/api/v1/hotels/{hotel_id}/price-history` | Series for the chart           | public key    |
| GET     | `/api/v1/hotels/{hotel_id}/comparables`   | Comp-set with same-date rates  | public key    |
| GET     | `/api/v1/meta/config`                     | Active scoring config version  | internal      |
| POST    | `/internal/v1/ingest/rate-observations`   | Batch ingest                   | service token |
| GET     | `/internal/v1/analyses/{public_id}`       | Full decision trace            | service token |

Phase 2 (specified, not built): `POST/GET/DELETE /api/v1/alerts`.

---

## 2. `GET /api/v1/price-intelligence` — the core endpoint

### Request

| Param          | Type   | Req | Notes                                                                                     |
| -------------- | ------ | --- | ----------------------------------------------------------------------------------------- |
| `hotel_id`     | string | ✔   | WhataHotel hotel ID (U1)                                                                  |
| `check_in`     | date   | ✔   |                                                                                           |
| `check_out`    | date   | ✔   | Must be after `check_in`, ≤ 30 nights                                                     |
| `adults`       | int    |     | Default 2, 1–10                                                                           |
| `children`     | int    |     | Default 0, 0–10                                                                           |
| `room_type_id` | string |     | Omit → the engine selects the hotel's lowest-priced available room type and reports which |
| `currency`     | string |     | Default `USD` (decision D5)                                                               |
| `include`      | csv    |     | `history`, `comparables`, `explanation`. Default `explanation`                            |

`GET /api/v1/price-intelligence?hotel_id=2962&check_in=2026-09-18&check_out=2026-09-21&adults=2&room_type_id=rt_8814&include=history,explanation`

### Response `200`

```jsonc
{
  "analysis_id": "an_01J9XQ7K3M2",
  "generated_at": "2026-08-14T09:14:22Z",

  "subject": {
    "hotel": {
      "hotel_id": "2962",
      "name": "The Ritz-Carlton Miami Beach",
      "destination": "Miami Beach",
      "luxury_tier": 5,
    },
    "room_type": {
      "room_type_id": "rt_8814",
      "name": "Ocean View King",
      "room_class": "ROOM",
      "bed_config": "KING",
      "view": "OCEAN",
      "selected_by": "USER",
    },
    "rate_plan": {
      "summary": "Breakfast included · Flexible cancellation",
      "meal_plan": "BREAKFAST",
      "refund_policy": "REFUNDABLE",
      "comparability_class": "BREAKFAST_INCLUDED|FLEXIBLE|PUBLIC",
    },
    "stay": {
      "check_in": "2026-09-18",
      "check_out": "2026-09-21",
      "nights": 3,
      "adults": 2,
      "children": 0,
      "lead_time_days": 35,
    },
  },

  "price": {
    "nightly": { "amount_minor": 68900, "currency": "USD" },
    "total": { "amount_minor": 206700, "currency": "USD" },
    "effective_nightly": { "amount_minor": 65900, "currency": "USD" },
    "tax_basis": "GROSS",
    "observed_at": "2026-08-14T09:12:00Z",
  },

  "verdict": {
    "deal_score": 91,
    "deal_score_band": "EXCELLENT",
    "confidence": 88,
    "confidence_band": "HIGH",
    "recommendation": "BOOK_NOW",
    "recommendation_label": "Book now",
    // Which gate fired. The UI needs it: "good rate AND rising" (G3) is a
    // materially different message from "excellent rate" (G2), and the customer
    // is owed the actual reason.
    "gate_fired": "G2",
    "wait_blocked_by": [],
  },

  "baseline": {
    "level": "L0",
    "level_note": null,
    "lookback_days": 90,
    "n_observations": 84,
    "typical_nightly": { "amount_minor": 74800, "currency": "USD" },
    "lowest_observed": { "amount_minor": 62100, "currency": "USD" },
    "highest_observed": { "amount_minor": 92500, "currency": "USD" },
    "percentile_rank": 9,
    "pct_below_typical": 7.9,
  },

  "factors": [
    {
      "code": "F1",
      "name": "Historical price",
      "available": true,
      "sub_score": 91,
      "weight": 0.3,
      "value": 9,
      "unit": "PERCENTILE",
    },
    {
      "code": "F2",
      "name": "Market comparison",
      "available": true,
      "sub_score": 83,
      "weight": 0.25,
      "value": -8.0,
      "unit": "PERCENT",
    },
    {
      "code": "F3",
      "name": "Recent movement",
      "available": true,
      "sub_score": 72,
      "weight": 0.15,
      "value": 9.0,
      "unit": "PERCENT",
    },
    {
      "code": "F4",
      "name": "Seasonality",
      "available": false,
      "unavailable_reason": "INSUFFICIENT_HISTORY",
    },
    {
      "code": "F5",
      "name": "Demand",
      "available": false,
      "unavailable_reason": "NO_DEMAND_SIGNAL",
    },
    {
      "code": "F6",
      "name": "Included value",
      "available": true,
      "sub_score": 74,
      "weight": 0.1,
      "value": 3000,
      "unit": "CURRENCY_MINOR",
    },
  ],

  "reasons": [
    {
      "code": "BELOW_HISTORICAL_AVERAGE",
      "direction": "POSITIVE",
      "text": "7.9% below the typical rate for this room",
    },
    {
      "code": "BELOW_COMPARABLE_HOTELS",
      "direction": "POSITIVE",
      "text": "8% below 6 comparable hotels for these dates",
    },
    {
      "code": "PRICE_RISING_7D",
      "direction": "POSITIVE",
      "text": "Rate has risen 9% in the past 7 days",
    },
  ],
  "caveats": [],

  "explanation": {
    "text": "At $689 a night this room is running about 8% under its typical rate…",
    "generator": "MODEL",
  },

  "history": {
    "granularity": "DAILY",
    "series": [{ "date": "2026-07-16", "nightly_minor": 71200 }],
    "windows": {
      "d30": { "change_pct": 4.1 },
      "d60": { "change_pct": -1.2 },
      "d90": { "change_pct": -3.8 },
    },
  },

  "data_as_of": "2026-08-14T09:12:00Z",
  "config_version": 7,
  "engine_version": "1.0.0",
}
```

### `INSUFFICIENT_DATA` response — also `200`

Not an error. The system worked correctly and its answer is "we don't know yet."

```jsonc
{
  "analysis_id": "an_01J9XQ8P4N7",
  "subject": { "…": "…" },
  "price": {
    "nightly": { "amount_minor": 68900, "currency": "USD" },
    "observed_at": "2026-08-14T09:12:00Z",
  },
  "verdict": {
    "deal_score": null,
    "deal_score_band": null,
    "confidence": 31,
    "confidence_band": "INSUFFICIENT",
    "recommendation": "INSUFFICIENT_DATA",
    "recommendation_label": "Not enough data yet",
  },
  "baseline": { "level": "L3", "n_observations": 6, "lookback_days": 90 },
  "caveats": [
    {
      "code": "LIMITED_HISTORY",
      "text": "We have only 6 recorded rates for this room, and need at least 12.",
    },
  ],
  "explanation": {
    "text": "We're still building price history for this room, so we can't assess this rate yet. The current rate is $689 per night.",
    "generator": "TEMPLATE",
  },
  "data_as_of": "2026-08-14T09:12:00Z",
}
```

`deal_score` is `null`, never `0`. A zero would render as "terrible deal" and would be a lie.

### Errors

| Status | `error.code`                              | When                                                                         |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------------- |
| 400    | `INVALID_PARAMETER`                       | Malformed dates, `check_out ≤ check_in`, nights > 30, occupancy out of range |
| 404    | `HOTEL_NOT_FOUND` / `ROOM_TYPE_NOT_FOUND` | Unknown or inactive                                                          |
| 409    | `NO_CURRENT_RATE`                         | Hotel known but no live rate for this stay (sold out / not bookable)         |
| 429    | `RATE_LIMITED`                            | Includes `Retry-After`                                                       |
| 503    | `UPSTREAM_UNAVAILABLE`                    | Rate source down and no cached rate within `MAX_CURRENT_AGE_HOURS`           |

```jsonc
{
  "error": {
    "code": "NO_CURRENT_RATE",
    "message": "No available rate for these dates.",
    "details": { "hotel_id": "2962", "check_in": "2026-09-18" },
  },
  "request_id": "req_01J9…",
}
```

### Caching and performance

- `Cache-Control: public, max-age=900, stale-while-revalidate=3600` (`API_CACHE_TTL_SECONDS`). Rates do not move minute-to-minute; a 15-minute cache absorbs most traffic.
- `ETag` on the analysis fingerprint; `304` on revalidation.
- **The endpoint never calls the rate source synchronously on a cache miss.** It reads the newest stored observation and one `rate_baseline` row. If no observation is fresh enough, it enqueues a priority capture and returns `INSUFFICIENT_DATA` or `409`. This is what keeps p95 latency flat and external API cost decoupled from traffic (assessment risk R7).
- Target: p95 < 200 ms warm, < 500 ms cold.

---

## 3. Supporting endpoints

### `GET /api/v1/hotels`

`q` (**optional**; min 2 chars when given), `limit` (default 10, max 50). With `q`, trigram search over `hotel.name`; without it, a plain alphabetical listing. Returns `hotel_id`, `name`, `destination`, `luxury_tier`, and `has_price_intelligence` — a boolean telling the UI whether this hotel has enough baseline coverage to be worth analyzing. Prevents leading customers into a guaranteed `INSUFFICIENT_DATA`.

> `q` was required in the original draft. A host page needs a browsable picker as well as type-ahead, and forcing it to invent a throwaway query string to get one is the kind of API that gets worked around rather than used.

### `GET /api/v1/hotels/{hotel_id}/room-types`

Params `check_in`, `check_out`, `adults`, `children`. Returns available room types with current nightly price, comparability class, `n_observations`, and `intelligence_available`. Populates the room selector.

### `GET /api/v1/hotels/{hotel_id}/price-history`

Params: stay tuple, `window` ∈ `30|60|90` (default 90), `granularity` ∈ `daily|weekly`.

Returns the same-stay series `S(Q)` plus baseline reference lines (`typical`, `p10`, `p90`) and `n_observations` per point so the chart can visually thin sparse regions rather than implying continuous data.

```jsonc
{
  "window_days": 90,
  "currency": "USD",
  "series": [{ "date": "2026-05-17", "nightly_minor": 74100, "n_observations": 2 }],
  "reference": { "typical_minor": 74800, "p10_minor": 65200, "p90_minor": 88100 },
  "current": { "date": "2026-08-14", "nightly_minor": 68900 },
  "gaps": [{ "from": "2026-06-02", "to": "2026-06-09" }],
}
```

`gaps` is explicit so the chart can break the line rather than interpolate across missing days. Interpolating invented prices into a chart the customer reads as history would be a quiet form of lying.

### `GET /api/v1/hotels/{hotel_id}/comparables`

Stay tuple + `limit` (default 6). Returns comp hotels with current nightly rate, their own typical rate, the discount index used by factor F2, and freshness. Also returns `n_fresh_comps` so the UI can suppress the section below `MIN_COMPS`.

### `GET /api/v1/health`

```jsonc
{
  "status": "ok",
  "database": "ok",
  "ingest": {
    "last_success_at": "2026-08-14T09:00:00Z",
    "minutes_since": 14,
    "reject_rate_24h": 0.004,
  },
  "data": {
    "observations": 58320,
    "baselines": 2862,
    "stale_baselines": 0,
    // REAL | SYNTHETIC | MIXED | EMPTY
    "provenance": "SYNTHETIC",
    "sources": [
      {
        "code": "SYNTHETIC_DEV",
        "display_name": "Synthetic development data (NOT REAL RATES)",
        "is_synthetic": true,
        "observations": 58320,
      },
    ],
  },
  "engine_version": "1.0.0",
  "config_version": 7,
}
```

Degrades to `"status": "degraded"` when ingest is stale beyond threshold — the condition that quietly destroys the product's correctness while every service still appears healthy.

**`data.provenance`** says whether the stored rates are real, fabricated, or both. It is derived from `source.is_synthetic`, so it tracks the data rather than restating an assumption.

Any surface that displays rates should render its data-source notice from this field rather than hardcoding one. The demo harness previously hardcoded a "synthetic data — no number here is real" banner, and went on displaying it over live hotel pricing once a real source was collected; a label that is not derived from the data is not a label.

`MIXED` is the state worth alarming on. Once fabricated rows are in `rate_observation` they are indistinguishable from real ones (CLAUDE.md rule 7), so any score computed over a mixed database is meaningless — and nothing else in the system will tell you.

---

## 4. Internal endpoints

### `POST /internal/v1/ingest/rate-observations`

Batch of raw records, max `INGEST_BATCH_MAX` (1000). Returns per-record outcome (`inserted` / `duplicate` / `rejected` with reason). Idempotent via the dedup index (doc 05 §3), so retries are safe.

### `GET /internal/v1/analyses/{public_id}`

Full stored analysis including `decision_trace`, `explanation_bundle`, per-factor rows, and config version. This is the endpoint that answers "why did we show this customer a 91?" months later, and it is the reason doc 05 persists the breakdown.

---

## 5. Cross-cutting

- **Auth** — public browser key (domain-restricted, rate-limited per IP) for `/api/v1`; service token for `/internal/v1`. Internal paths are network-restricted, never exposed at the edge.
- **Rate limiting** — token bucket per key + IP; `429` with `Retry-After`.
- **Versioning** — path-versioned. `config_version` and `engine_version` on every analysis response so a client can detect a scoring change.
- **Observability** — `request_id` on every response and log line; metrics on latency, cache hit rate, recommendation distribution, `INSUFFICIENT_DATA` rate, and explanation validation failure rate. A rising `INSUFFICIENT_DATA` rate is the earliest signal that collection has broken.
- **CORS** — allowlist whatahotel.com origins (U18).
