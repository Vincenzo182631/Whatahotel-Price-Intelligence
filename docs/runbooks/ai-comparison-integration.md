# Runbook — integrating with the WhataHotel AI comparison app

The AI comparison app (`whatahotel.vercel.app`, Next.js on Vercel) is where
Price Intelligence is most likely to reach a guest first. It already solves
several problems this project was about to solve independently, and it already
holds the on-demand rate path we were treating as unbuilt work.

**Everything below was read from the deployed client bundle on 2026-08-18.**
Client bundles show the request shape and the rendering, not the server. Where
this document states something about server behaviour it says so and marks it
as unconfirmed. Confirm against the app's repository before building on it.

---

## The identifier is shared — no mapping layer

`whatahotel.com` uses `hotelID` in its URLs. The comparison app carries
`sourceHotelId` per hotel. This project stores `hotel.wah_hotel_id`. Verified
against three properties:

| ID     | Hotel                          | Note                           |
| ------ | ------------------------------ | ------------------------------ |
| `1198` | The Ritz-Carlton, Key Biscayne | matches our collected data     |
| `1326` | Four Seasons Hotel Miami       | matches our collected data     |
| `3554` | EB Hotel Miami                 | the persistent HTTP 500 source |

One identifier across all three systems. Do **not** build a translation table;
if one ever appears in a diff, something upstream has changed and that is the
thing to investigate.

---

## The rate path already exists

```
GET /api/rates?id={hotelId}&checkIn={date}&checkOut={date}
  → { live: boolean, entryNightly, total, currency }
```

Client-side behaviour, read from the bundle:

- **Lazy.** Rates are requested through an `IntersectionObserver` with a 300px
  `rootMargin`, so a card fetches only as it approaches the viewport.
- **Bounded.** A client-side semaphore caps concurrent rate requests at 4;
  the rest queue.
- **Cached 30 minutes** (`staleTime: 1_800_000`).
- **Live or nothing.** The hook returns `null` unless `live` is true and
  `entryNightly` is present. A rate that cannot be validated is not rendered.

That last point is the same rule this project enforces (`docs/mvp/README.md`,
data-validation constraints): never show a rate that is not live-validated,
never substitute a guessed value. Two independently built systems arrived at
it, which is a good sign it is not negotiable.

### This closes the on-demand question

The open decision was whether to fetch rates for stays outside the collection
grid — the grid tracks 23 lead-times × {1,3} nights × 2 adults per hotel, so a
guest picking their own dates falls outside it most of the time.

That fetch already happens, for every rate card the guest scrolls to. The work
is not building an on-demand path; it is **joining the one that exists.**

---

## Integration: score inside `/api/rates`, not beside it

Two placements are possible. Prefer the first.

**Server-side, inside the route handler.** `/api/rates` calls this project's
scoring API and returns the rate and its assessment together.

- One round trip, one cache entry, one freshness horizon.
- The scored rate is provably the rate on screen.

**Client-side, alongside.** The card calls `/api/rates` and our API separately.

- Two fetches can straddle a price change, so the verdict describes a rate the
  guest is not looking at. That surfaces as an inexplicably wrong assessment
  with no way to reproduce it — the failure is silent and blames the engine.

Use the server-side placement. The extra coupling is worth removing a class of
bug that cannot be diagnosed from the outside.

### Where the verdict renders

The cards already have a justification slot: `matchReason`, under the heading
_"Why your advisor recommends this"_. The explanation belongs there. No new
component is required, and the deterministic template renderer already produces
text of roughly the right length.

Note the app renders a separate `/100` score for **Sargassum** (seaweed)
conditions. It is unrelated to price, but two `/100` badges on one card is a
presentation decision someone should make deliberately rather than discover.

---

## The blocking question: `entryNightly` is a "from" price

`entryNightly` is the cheapest offer at a hotel. It is the weakest possible
price signal, and scoring it directly would break rule 5 (compare like with
like).

One hotel's cheapest offer may be non-refundable and room-only; another's may
include breakfast and free cancellation. Those are different products at
different prices, and a baseline built across comparability classes cannot
assess a bare minimum against them. The result would be a confident, wrong
verdict — exactly the failure the comparability classes exist to prevent.

**Before wiring anything, establish whether the route handler already holds the
full rate list and merely surfaces the minimum.**

- If it does, pass the list through and classify as normal. Small change.
- If it only ever requests the entry rate, it must request more, or Price
  Intelligence cannot honestly score what the app displays.

This is unconfirmed from the client bundle and is the first thing to check.

The same caveat applies to the app's own cross-hotel price comparison,
independently of this project: ranking hotels on unnormalized "from" prices can
present the more expensive property as the cheaper one.

---

## Guest traffic is uncollected data

Every `/api/rates` call is a live rate observation for a stay a real person
cared about, and it is currently discarded once rendered.

Writing those into `rate_observation` would:

- extend coverage beyond the fixed grid, to whatever dates guests actually ask
  about — the coverage gap, closed as a side effect of use;
- weight the accruing history toward stays with demand behind them;
- cost nothing extra in API calls, because the request has already been made.

Two things to respect if this is built:

1. **Provenance stays honest.** These are real rates from the same source, so
   they are not synthetic — but tag the ingest batch so guest-driven
   observations are distinguishable from scheduled ones. A shift in collection
   mix should be visible, not inferred.
2. **The scheduler must not double-count.** `planCollection` decides what is
   due from what it can already see; a guest-driven observation makes a stay
   look fresh. That is correct — it _is_ fresh — but the grid top-up
   (`findMissingGridStays`) and the `collection_attempt` backoff both key on
   stay identity, so verify the interaction rather than assuming it.

---

## Practices worth keeping, from both sides

Read out of the comparison app and worth holding to across both codebases:

- **Credentials never reach the client.** 767 KB of client bundle contains no
  API key, no `api.cfm` URL, and no `whatahotel.com` endpoint — every source
  call happens in a route handler. Same rule as this project's rule 10.
- **Fetch only what is about to be seen.** The `IntersectionObserver` pattern
  belongs in our widget too: a Price Intelligence panel below the fold should
  not call the API until the guest scrolls toward it.
- **Bound your own concurrency.** A cap of 4 in the client is a deliberate
  choice about a shared upstream, not a performance detail.
- **Agree one freshness horizon.** The app caches rates 30 minutes; this
  project has `rec.maxCurrentAgeHours`. Two products disagreeing about what
  "current" means will eventually show a guest a fresh rate beside a stale
  verdict. Pick one number and record it in both places.
- **Absent means absent.** The app renders nothing rather than a stale rate;
  this project excludes an unmeasurable factor rather than scoring it neutral.
  Same principle, and the reason both are trustworthy.

---

## What is still needed from the app's side

1. The server-side shape of `/api/rates` — specifically whether the full rate
   list is available, with meal plan, refundability and room descriptor.
2. Confirmation that `sourceHotelId` is always the `whatahotel.com` hotel ID,
   including for any property added through a different path.
3. Repository access, to add the scoring call inside the route handler.

Until (1) is answered, treat any assessment rendered against `entryNightly` as
unsound and do not ship it.
