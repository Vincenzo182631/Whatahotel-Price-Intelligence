# Guest reputation and the reasoning layer

Two optional integrations, both server-side, both additive:

- **Google Places** supplies a guest rating for a hotel, shown beside the price.
- **OpenAI** rewords the already-computed explanation into readable English.

Neither is required. With both keys unset the product behaves exactly as it did
before they existed: no rating block, and the deterministic sentences. That is
not a degraded mode, it is the floor everything else is measured against.

---

## The two rules that shape all of this

**1. The rating is never a term in the score.** Nothing under
`packages/core/src/scoring` reads it. A 4.8 does not raise the Deal Score and a
3.9 does not lower it. It appears in the explanation bundle as evidence a reader
can weigh, and in the API as `reputation`, carrying `affects_score: false`.

The reason is not squeamishness. A rating and a price index are different kinds
of number: "4.9 from 32 reviews" and "4.7 from 4,500" are not comparable
strengths of evidence, and a weighted score cannot express that difference — a
reader can. Folding reputation into the score would also make the score move for
a reason the customer cannot check against the page they are on.

**2. The model never computes.** It receives an `ExplanationBundle` — facts that
are already decided — and returns two or three sentences. Every numeral it
writes is checked against `constraints.allowed_numbers` before display, and a
draft containing predictive language is rejected outright (invariant P11). A
failing draft is discarded whole rather than patched: patching a wrong number
means guessing what was meant, and a good guess is how a fabrication survives its
own validator.

---

## Configuration

All server-side. **Neither key may appear in HTML, in widget JavaScript, in a
`data-` attribute, or in any variable a bundler would inline into the browser.**
The page talks to our API; only our API talks to Google and OpenAI.

```bash
GOOGLE_PLACES_API_KEY=...                 # unset ⇒ no reputation anywhere
GOOGLE_PLACES_REFRESH_HOURS=168           # how stale a cached rating may get
GOOGLE_PLACES_TIMEOUT_MS=4000
GOOGLE_PLACES_MIN_MATCH_CONFIDENCE=0.7    # below this, the match is not used

OPENAI_API_KEY=...                        # unset ⇒ template sentences always
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_MS=6000
OPENAI_INTELLIGENCE_CACHE_MINUTES=60
```

In production these are repository secrets (for the sweep) and Vercel
environment variables (for the API). `OPENAI_API_KEY` is only needed where the
API runs; `GOOGLE_PLACES_API_KEY` is only needed where the sweep runs.

---

## Resolving hotels to Google places

```bash
npm run places -- --dry-run      # show the queue, call nothing
npm run places -- --limit 500    # resolve and refresh
```

Runs automatically at the end of every collection run
(`.github/workflows/collect.yml`, batch of 200), after rates and unable to fail
the run. To run it **on its own** — after adding the key, after a threshold
change, or to see the match split before trusting it — dispatch the
**Refresh guest reputation** workflow (`.github/workflows/reputation.yml`),
which takes the same `--limit` and `--dry-run`. Doing it that way spends no
WhataHotel API calls to get at a Google sweep. A Google outage must never cost a collection window — this source has
no rate history, so a missed window is baseline that cannot be backfilled.

### The four outcomes, and what each means for next time

| Outcome      | Stored                                           | Shown     | Retried                                       |
| ------------ | ------------------------------------------------ | --------- | --------------------------------------------- |
| `VERIFIED`   | place id, rating, count, name, address, maps URI | yes       | refreshed every `GOOGLE_PLACES_REFRESH_HOURS` |
| `UNVERIFIED` | status and nothing else                          | **never** | no                                            |
| `NO_MATCH`   | status and nothing else                          | **never** | no                                            |
| call failed  | **nothing at all**                               | —         | yes, next sweep                               |

That last row is the one worth understanding. `searchText` returns `null` for a
failed call and `[]` for "Google answered and knows of no such place". Recording
`NO_MATCH` on a timeout would retire a hotel from reputation permanently over a
four-second blip, because the queue deliberately never revisits a `NO_MATCH`.

### Hotels with no coordinates are skipped, not asked about

A hotel whose location the catalogue does not hold is capped below the match
threshold, so no answer Google could give would clear the bar. The sweep does
not call for it at all: asking would spend a Text Search on a foregone
`UNVERIFIED`, and `UNVERIFIED` is never retried — one sweep would permanently
retire every such hotel over a gap in **our** data rather than a fact about
theirs.

Measured on a freshly swept destination, **14 of 15 hotels had no
coordinates**. If a sweep reports mostly `skipped for want of coordinates`,
that is a catalogue problem and not a reputation one; nothing about the Google
integration can fix it, and it resolves on its own as the catalogue records
locations.

An already-mapped hotel is still refreshed even without coordinates — the skip
is about _deciding_ a match, and a decided one does not need re-deciding.

To force a retry of an `UNVERIFIED` or `NO_MATCH` hotel — after a rename, or
after lowering the confidence threshold — clear its status:

```sql
UPDATE hotel SET google_match_status = NULL WHERE wah_hotel_id = '1234';
```

### How a match is decided

`packages/ingest/src/adapters/google/match.ts`. Name similarity is the base
(Dice coefficient over word bigrams, after stripping the words half of all hotel
names contain). **Coordinates are the arbiter**: within 300m is decisive
corroboration, beyond 5km is decisive refutation however well the names read.
City agreement is weak evidence and only ever additive.

With no coordinates for our own hotel, confidence is capped at 0.65 — below the
default threshold — so such a hotel is never verified on name alone. This is
deliberate: "Four Seasons Hotel Miami" and "Four Seasons Resort Palm Beach"
share most of their words, and only geography separates them.

The cost of a wrong match is showing one property's reputation on another
property's page, which is worse than showing none. Hence 0.7, and hence the
default answer being "not sure".

---

## What the API returns

```jsonc
"reputation": {
  "source": "GOOGLE",
  "rating": 4.6,
  "review_count": 3241,          // always beside the rating, never alone
  "display_name": "…",
  "affects_score": false,
  "comparable_median_rating": 4.2,   // null until 3 comparables carry one
  "comparables_with_rating": 3
},
"explanation": {
  "text": "…",
  "sentences": ["…"],
  "source": "TEMPLATE" | "MODEL" | "CACHE"
}
```

`reputation` is `null` — the whole block — when the hotel is unmatched,
doubtfully matched, or unrated. **Never a zero rating.** 0.0 stars is a claim
about a property, and one we have no basis for. Same principle as an absent Deal
Score being `null` rather than 0.

`explanation.source` is published because a reader of the API is entitled to
know whether a sentence was written by a template or by a model that was then
checked against the facts.

---

## The Premium Justification assessment (Phase 4)

On top of the deterministic money-vs-money premium justification, the model
produces a structured verdict — is the premium supported by the evidence? —
published as `premium_justification.assessment`:

```jsonc
{
  "level": "HIGH | MEDIUM | LOW | INSUFFICIENT_DATA",
  "reasoning": "…",
  "key_positive_factors": [],
  "key_negative_factors": [],
  "confidence": "HIGH | MEDIUM | LOW", // computed by CODE, never the model
  "recommendation": "…",
  "evidence_used": ["google_rating", "…"], // every key checked against the bundle
  "source": "MODEL | DETERMINISTIC",
}
```

This is the one place verified Google reputation may SUPPORT a judgement —
and it still moves no number: `premium_justification.level` and the Deal
Score are unchanged beside it. The gate (`validateAssessment`) rejects a
verdict whole for: an invented numeral, predictive language, citing evidence
the bundle does not carry, a HIGH with neither reputation nor included-value
evidence, or malformed structure. Rejected or absent, the deterministic
mapping ships (`source: "DETERMINISTIC"`), and `NOT_PREMIUM` stays honestly
`null`. Confidence follows a coded ladder — 6+ comparables can reach HIGH, 3
reach MEDIUM, fewer is LOW, capped by room-match quality and by whether a
verified reputation exists at all.

No brand is named anywhere in this logic. An expensive hotel earns HIGH only
from evidence: what the rate includes, and what verified guests say.

## When the prose is not the model's

`source: "TEMPLATE"` on a request you expected the model to answer means one of:

- `OPENAI_API_KEY` is not set in the API's environment;
- the call timed out (`OPENAI_TIMEOUT_MS`, default 6s) or was refused;
- the draft failed validation.

The third is the interesting one. The rejection reasons are on the server-side
result (`violations`) and are deliberately not returned to the browser — they
describe our validator, not the customer's stay. To see them, call the endpoint
from a server with `LOG_REQUESTS=1` and read the reasoner's `onResult` output,
or reproduce with `tests/unit/reasoner.test.ts`, which drives every failure path
through an injected endpoint with no key and no network.

A rising rate of validation failures is a signal about the prompt or the model,
not about the data. The customer never sees the difference, which is exactly why
it needs watching rather than trusting.

---

## Cost

Places charges per call and per field. The field masks in `places.ts` are the
complete list of what we store — widening one changes the bill, so it is a
deliberate edit and the test asserts the exact mask string.

A hotel costs one Text Search plus one Details call to resolve, then one Details
call per `GOOGLE_PLACES_REFRESH_HOURS`.

### The refresh interval is the whole ongoing bill

Measured against the production catalogue on 2026-08-21:

|                                                      |                        |
| ---------------------------------------------------- | ---------------------- |
| Catalogued hotels                                    | 3,202                  |
| Unplaceable — no coordinates, skipped without a call | 169 (5.3%)             |
| Resolvable                                           | 3,033                  |
| First sweep                                          | ~6,066 calls, one time |

After that, the recurring cost is one Details call per resolvable hotel per
refresh interval, and nothing else:

| `GOOGLE_PLACES_REFRESH_HOURS` | Details calls/month |
| ----------------------------- | ------------------- |
| 24                            | ~92,000             |
| **168 (the default)**         | **~13,200**         |
| 720                           | ~3,100              |

168 rather than 24 because a property's guest rating is an average over
thousands of reviews. It moves by hundredths over months, and no guest decision
turns on today's value against last Tuesday's — so a daily refresh buys 7x the
bill for precision the signal does not have. Lower it only with a reason that
survives that arithmetic.

Re-run `npm run places -- --dry-run` to re-measure; it prints the queue size,
the unplaceable count and the call estimate, and needs no key to do it.

Resolution is never done on a page view:
a rating belongs to the hotel rather than to the stay, so there is nothing
per-request to look up, and a guest's request should not pay for a discovery
that benefits everyone after them.

The consequence, stated rather than hidden: a hotel enrolled between two sweeps
has no rating yet and renders with none — the same honest absence as an
unmatched one.

OpenAI is called once per distinct set of facts per
`OPENAI_INTELLIGENCE_CACHE_MINUTES`. The cache key is a hash of the bundle, so
two guests looking at the same stay in the same hour share one call, and a stay
whose price moved gets a fresh one.
