# The WhataHotel data API — what it offers, and what to reuse

Read from the AI comparison app's **repository** (`Vincenzo182631/whatahotel`,
`lib/services/live-rates.ts`) on 2026-08-20, and verified by calling the live
API from this project. The earlier runbook
([`ai-comparison-integration.md`](./ai-comparison-integration.md)) was written
from the deployed client bundle and said to confirm against the repository
before building on it. This is that confirmation, plus an endpoint inventory.

Where the two disagree, this document wins: it was read from source and
measured against the API.

---

## The five methods

| method      | key params                               | returns                                                           | our use today            |
| ----------- | ---------------------------------------- | ----------------------------------------------------------------- | ------------------------ |
| `rates`     | `hotel`, `checkIn`, `checkOut`, `guests` | the full room + offer list for one exact stay                     | **yes** — the fact table |
| `cityrates` | `city`, `checkIn`, `checkOut`, `guests`  | up to **15** hotels in a city, **ranked**, with dated totals      | catalogue sync only      |
| `search`    | `hotelSearch`                            | up to **12** hotels matching a name fragment                      | catalogue sync only      |
| `hotel`     | `hotel`                                  | one hotel's identity, geo and perks — answers for an arbitrary id | **yes** — enrolment      |
| `info`      | `hotelName`, `hotelCity`                 | description, amenities, dining, room features, policies, tax note | **no** — see below       |

Success codes are not uniform: `hotel` answers `100`, the rest answer `200`.
Every response is HTTP 200 regardless; the real outcome is `wahData.status.code`
(see `client.ts`).

---

## `cityrates` is the "best hotels in city" endpoint — and it ranks

This is the endpoint the request describes, and it carries a signal neither
project scores on today. Each hotel comes back with a `rank`, and **the list is
returned in descending rank order**. Measured 2026-08-20, `2026-10-15 → 10-17`,
2 guests:

| city     | ranks returned                                             |
| -------- | ---------------------------------------------------------- |
| Miami    | 94, 39, 35, 23, 15, 14, 13, 12, 10, 9, 7, 5, 3, 3, 3       |
| Paris    | 63, 62, 43, 35, 29, 28, 25, 23, 21, 18, 18, 16, 15, 11, 11 |
| Honolulu | 589, 99, 66, 52, 47, …                                     |
| Doha     | 13, 4, 2, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0               |

Every hotel also carries its `perks` array (6 on the first hotel of all four
cities), `rateTotal`, `images`, `city`, `country` and a `rates-url`.

What `rank` actually counts is **not documented and not measured** — the shape
(one large value, a long tail, zeros in a thin market) is consistent with
booking volume or prominence, not with a quality rating. Do not present it to a
customer as a quality score, and do not weight the Deal Score on it, until we
know what it is. It is defensible **now** as a _shortlisting_ signal: which
hotels a destination's comp set should be built from, which is exactly the
question the request asks.

**The 15-hotel cap still applies.** Miami, Honolulu, Paris, London and Doha all
returned exactly 15. `cityrates` gives us the source's own top-15 for a city —
which is a better comp-set seed than "nearest by coordinates", but it is not
the city's inventory. The id-space sweep remains the only complete view
(rule 17).

---

## `info` would answer the quality question — but not for our key

This is the endpoint that carries what the request calls quality signals:

```
method=info&hotelName=<name>&hotelCity=<city>
  → wahData.hotel.HOTELINFO[]      { HOTELTITLE, HOTELDESC }  description, tax, amenity sections
                 .RESTAURANTS[]    on-site dining
                 .GUESTROOMS[]     room descriptors + feature lists
                 .ATTRACTIONINFO[] nearby attractions
                 .POLICYINFO[]     hotel policies
```

The AI app parses exactly this into `HotelInfo { description, amenities,
restaurants, tax, attractions, roomTypes, policies }` (`getHotelInfo`), and
keyword-maps the free text into canonical amenity keys (`detectAmenityKeys`).

**It returns `500` for every hotel with our API key.** Measured across seven
name/city combinations — The Royal Hawaiian/Honolulu, Halekulani/Honolulu,
Ritz-Carlton Key Biscayne/Miami (both spellings), Miami Beach EDITION/Miami
Beach, Fairmont Doha/Doha — all `500`, all "An error has occured while
processing this request". The AI app's own code treats sparse `info` results as
routine (it retries twice and caches an empty result for only 2 minutes), so
flakiness is expected there too, but a uniform 500 across every probe points at
authorisation rather than data.

**This corrects something I reported earlier in this project.** I said the
source provides no amenity data. That was wrong: it provides amenities, dining,
room features and policies through `info`. What is true is that we cannot
currently reach them, and that no endpoint returns a **star rating or a guest
rating** — those genuinely are not in the API.

Action: ask whether `info` is enabled for `WAH_API_KEY`, or whether the AI
app's `WHATAHOTEL_API_KEY` has a scope ours lacks. Until it answers,
quality-adjusted comparison has no amenity input.

---

## What to reuse, and what not to

### Reuse the endpoints and the call patterns

- **`getCityHotels` / `getCityRates`** — the `cityrates` call, its 30-minute
  cache and its one-retry-on-empty. Worth copying: the retry is there because
  the endpoint returns empty under throttle rather than erroring.
- **The concurrency queue.** The app bounds `cityrates` calls through
  `cityQueue`. Our client has its own semaphore; keep both bounded, and treat
  the cap as a statement about a shared upstream rather than a tuning knob.
- **`getLiveHotel`** (`method=hotel`) for identity — same call `enrollHotel`
  already makes.

### Do NOT reuse the rate parse

`fetchLiveRatesOnce` de-duplicates rooms **by `roomName`, keeping the cheapest**,
and its `LiveRoom` carries no meal plan and no refundability. That is fine for
a comparison card; it is not fine here. This project established that one
`rateCode` carries several priced offers distinguished only by the prose prefix
of `roomDesc`, and rule 5 forbids comparing across meal plan, refundability and
audience. Collapsing to the cheapest name discards exactly the terms the
comparability class is built from.

Our `packages/ingest/src/adapters/whatahotel/parse.ts` is strictly richer here.
**Keep ours.**

### Two facts the app records that we should hold to

- **`rateDaily` from `cityrates` and `search` is unreliable** — the app's
  comment cites a hotel returning `$43` where the real nightly was `$122`, and
  it never displays that figure, using `rateTotal ÷ nights` for ranking only.
  We have a `cityStartingRates()` in `catalog.ts` that reads `rateDaily` from
  `cityrates`. It is **exported but never called**; delete it rather than leave
  a loaded gun. (`rateDaily` from `method=rates` is a different field and is
  sound — that one we verified 6/6 against stored ADR.)
- **Credentials never reach the browser.** Confirmed in source: the API key is
  a server-only env var and the client calls the app's own `/api/rates`. Same
  rule as ours (rule 10).

---

## The earlier runbook's three open questions, now answered

1. **Does the route handler hold the full rate list, or only `entryNightly`?**
   It holds the full list. `LiveRates.rooms` is every room the source returned,
   sorted by price; `entryNightly` is just `rooms[0].nightly`. **But** the
   parse drops meal plan and refundability, so the list as typed is still not
   enough to score honestly — the raw `method=rates` payload is, and that is
   what we already fetch ourselves.
2. **Is `sourceHotelId` always the whatahotel.com hotel ID?** Yes —
   `toLiveHotel` maps `h.hotelID` straight through, with no translation
   anywhere in the service.
3. **Repository access.** Granted; this document is the result.

---

## Where this leaves the comp set

Today the comp set is: the curated `hotel_comparable` set when one exists,
otherwise the nearest same-destination hotels by coordinates (`compBasis:
'DESTINATION'`). Both are drawn from **our catalogue**.

`cityrates` offers a third source that is drawn from the **source's own
ranking**, for the guest's exact dates, in one call. It is a better shortlist
than proximity for the case that matters — a hotel in a destination we have
barely collected — because it is the source's opinion of which hotels in that
city are worth showing, rather than an accident of which ids the sweep reached
first.

That is a scoring-behaviour change and belongs behind
`docs/mvp/02-deal-score.md` and a config version, not a quiet edit. The
mechanics it needs are already built: `topUpComparablesOnDemand` fetches
comparables live for an exact stay, and `findComparableIdentities` is the one
place that decides who the comparables are.
