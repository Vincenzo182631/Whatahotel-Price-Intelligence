# Runbook — deploying the API and widget

The deploy target is **Vercel**, chosen because the AI comparison app already
lives there, so the team has the account and the habits. The repo is
deploy-ready: `vercel.json` at the root describes the whole thing, and no code
changes are needed to ship.

## What actually gets deployed

- **The widget and demo pages** — `apps/web/public/` served as static files by
  the CDN. `widget.js` carries a 5-minute cache so a fix propagates quickly.
- **The API** — one serverless function (`api/index.mjs`) that re-exports the
  same request handler `npm run api` runs locally (`apps/api/src/app.ts`).
  `/api/v1/*` and `/internal/v1/*` are rewritten to it. One handler for both
  hosts is deliberate: what a guest hits in production is byte-for-byte what
  the smoke tests exercise on a laptop.

## First-time setup (dashboard path — recommended)

1. In the Vercel dashboard: **Add New → Project → Import** this GitHub repo.
   The root `vercel.json` supplies build command, output directory and rewrites
   — pick the "Other" framework preset and change nothing.
2. Set the project's **Environment Variables** (Production):

   | Variable       | Value                                                                       |
   | -------------- | --------------------------------------------------------------------------- |
   | `DATABASE_URL` | the Neon connection string **with the `-pooler` hostname**                  |
   | `CORS_ORIGIN`  | `https://www.whatahotel.com,https://whatahotel.com,https://wah.rpx-dev.com` |
   | `WAH_API_KEY`  | the WhataHotel data API key — enables on-demand scoring                     |

   **Pooler, not direct.** Serverless instances each open their own database
   connection; the direct endpoint's connection limit is sized for migrations
   and steady servers, and traffic spikes will exhaust it. This is the opposite
   of the database-setup workflow, which requires the direct endpoint — the
   two workloads genuinely want different endpoints, and each doc says which.

   **CORS is an allowlist**, comma-separated, matched against the request's
   Origin. An origin off the list gets no header at all, and every call from
   that page fails in the browser while looking exactly like a broken embed —
   so a new host (a staging domain, say) must be added here BEFORE anyone
   tests the widget on it. `https://wah.rpx-dev.com` is included for that
   reason. Unset means `*`, which is for development only — do not ship it.

3. Deploy. Vercel builds on every push to `main` from then on.

## Verifying a deploy

```
curl https://<deployment>/api/v1/health
```

should report `"provenance": "REAL"` and a non-zero observation count. Then
load `https://<deployment>/` — the demo page renders the widget against the
deployed API. `npm run smoke` also works against a deployment:
`SMOKE_BASE=https://<deployment> npm run smoke`.

## Deploying from GitHub instead

The **Deploy** workflow (`.github/workflows/deploy.yml`) drives the same
deployment from Actions — useful when a deploy should be dispatched the way
everything else in this repo is, and it needs no dashboard setup at all. One
new repository secret: `VERCEL_TOKEN` (Vercel dashboard → Account Settings →
Tokens → Create). Everything else is automatic: the workflow creates or links
the project (`whatahotel-price-intelligence-api`) under the token's account,
derives the pooler `DATABASE_URL` from the repo's existing secret (the repo
holds the direct endpoint, which migrations need; the function must not use
it), pushes it and `CORS_ORIGIN` into the project's environment, builds, and
deploys. Dispatch with `production` unchecked for a preview URL, checked for
production.

Two secrets are optional and pushed into the function only when the repository
holds them:

| Secret                  | Reaches the function? | Without it                                              |
| ----------------------- | --------------------- | ------------------------------------------------------- |
| `WAH_API_KEY`           | yes                   | on-demand scoring degrades to the honest no-score state |
| `OPENAI_API_KEY`        | yes                   | the explanation is the deterministic template           |
| `GOOGLE_PLACES_API_KEY` | **no, by design**     | no guest rating anywhere                                |

`GOOGLE_PLACES_API_KEY` is deliberately never pushed to Vercel. The reputation
sweep runs in Actions and writes to the database; the function only reads what
was already stored, so handing it that key would widen the function's blast
radius for no capability. Set it as a repository secret only — see
[`reputation-and-reasoning.md`](./reputation-and-reasoning.md).

## Embedding on whatahotel.com

The zero-JavaScript form — one edit to the hotel-page template:

```html
<link rel="stylesheet" href="https://<deployment>/widget.css" />
<script src="https://<deployment>/widget.js" defer></script>
<div
  data-wah-pi
  data-hotel-id="#hotelID#"
  data-check-in="#checkIn#"
  data-check-out="#checkOut#"
  data-adults="#guests#"
></div>
```

**Both files are required, and the stylesheet is the one that gets forgotten.**
The widget does not inject its own CSS, so a page with only `widget.js`
renders every word correctly and none of the design: no card, no score tiles,
no verdict box — a column of plain text in the host page's body font, which
reads as broken rather than as unstyled. Verified by omitting it. If an
integrator reports "it looks wrong" rather than "nothing happens", check for
the `<link>` first.

**`data-wah-pi` is what the widget selects on — the element must carry it, or
one of the equivalents below.** Its VALUE is ignored (except as an optional
shorthand for the hotel id: `data-wah-pi="1198"` works), but the attribute
itself is how the element is found.

An earlier version of this page said the template "needs no id and no class",
meaning we do not require one. It was reasonably read as "identify it however
you like", and the staging embed came back as

```html
<div id="widget" class="wahpi-wrapper wahpi" data-hotel-id="2008" …></div>
```

— every stay attribute correct, and the one attribute we select on missing. The
widget mounted nothing and looked dead. So the selector now also accepts the
conventions an integrator naturally reaches for:

| form                 | example                        |
| -------------------- | ------------------------------ |
| the marker attribute | `<div data-wah-pi>`            |
| a class              | `<div class="wahpi">`          |
| an id                | `<div id="wahpi">` / `#wah-pi` |

All four are deliberate opt-in markers carrying our own name. `data-hotel-id`
alone is deliberately NOT a mount target — a search-results page can carry it
on every card, and that would render a panel per row.

### Category-specific Rate Intel: the button is the chooser

The Intel panel renders **no room-category dropdown**. The category is decided
by the WhataRate! Intel button the guest pressed, which the host page declares
on the mount element with any ONE of three identifiers — strongest first:

| attribute           | value                                            | behaviour                                                                                                       |
| ------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `data-room-code`    | the source's own `bookCode` for the priced row   | exact row: room AND rate locked server-side; `subject.room_code_match` reports the outcome                      |
| `data-room-type-id` | our `room_type_id` (from `subject.room_options`) | that category, cheapest plan; rate-plan picker still offered                                                    |
| `data-room-name`    | the label the button renders ("Deluxe King")     | resolved against the stay's real room list on first response; exact match wins, then closest prefix/containment |

```html
<div
  data-wah-pi
  data-hotel-id="1198"
  data-check-in="2026-10-30"
  data-check-out="2026-11-02"
  data-adults="2"
  data-room-code="E1KBB0"
></div>
```

Prefer `data-room-code` — it is the identifier the rates page already holds
and the only one that also pins the exact rate plan. `data-room-name` is the
fallback for a button that only knows its label; if the name matches nothing
the stay actually offers, the panel keeps the engine's pick rather than
guessing — never a blank box. Changing any of these attributes remounts the
panel for the new category, so per-row buttons can share one mount node:
update the attributes, and the panel follows with no stale state.

Absent all three, the panel shows the engine's pick (cheapest current rate).
There is no in-panel way to change category — the page is the chooser.

**If every button shows the first category**, the identifier is not reaching
the widget or not resolving, and the browser console now says which:

1. **Attributes must be real DOM attributes.** jQuery's `.data('room-code',
v)` stores in memory and never touches the DOM — the widget cannot see
   it. Use `.attr('data-room-code', v)` (or `el.setAttribute`).
2. **Set the attribute on the mount node itself**, before or after mounting
   — the widget observes attribute changes and remounts. A brand-new node
   inserted with the attribute already set also works.
3. **`data-room-code` must be the rates feed's `bookCode`** for these exact
   dates (not `rateCode`); an unknown code logs
   `[wah-pi] data-room-code "…" was not found for this stay`.
4. **`data-room-name` must correspond to the source's room names.** Exact,
   prefix, and whole-word matches land; an ambiguous or foreign label logs
   `[wah-pi] data-room-name "…" matched no room for this stay` together
   with the room names the stay actually offers — copy one of those, or
   switch to the id.

### Pre-warming: make Rate Intel open in under a second

A stay nobody has collected makes the API fetch live rates before it can
score — up to ~40 seconds the first time. The guest spends longer than that
just reading the hotel page before pressing the button, so start the work
when the page loads, not when the panel opens. Two equivalent forms:

```html
<!-- a hidden marker anywhere in the page; it is never mounted -->
<div
  data-wah-pi-prefetch
  data-hotel-id="1198"
  data-check-in="2026-10-30"
  data-check-out="2026-11-02"
  data-adults="2"
  hidden
></div>
```

```js
// or programmatically, e.g. as soon as the booking form knows the dates
WahPriceIntelligence.prefetch({
  hotelId: '1198',
  checkIn: '2026-10-30',
  checkOut: '2026-11-02',
  adults: 2,
});
```

Both fire the exact request the panel itself would and discard the response —
the point is that the server fetches, ingests and caches the stay. When the
guest opens Rate Intel moments later, the answer is stored and renders in
well under a second. Each distinct stay is warmed once per page view;
failures are silent (the panel's own request still handles errors honestly).
Prefetching a stay the guest never opens costs one API round per comparable —
use it on hotel detail pages, not on search-result grids.

**The stay can come from the page instead of attributes**, which is what lets
ONE template edit cover every hotel page on the site. Each field is resolved
independently, first hit wins:

1. the element's own `data-*` attribute,
2. the page's booking form — `#checkIn` / `#checkOut` / `#guests` and the usual
   `name=` equivalents,
3. the URL query string — `hotelID`, `checkIn`, `checkOut`, `guests`,
   `children`, several spellings each,
4. the URL path — `/hotels/<id>/…`, for the hotel id.

So `showRates.cfm?hotelID=2008&checkIn=2026-09-08&checkOut=2026-09-11&guests=2`
needs only `<div data-wah-pi></div>`, and so does a hotel page that keeps the
id in its path and the dates in its picker. Dates may be `YYYY-MM-DD` or
`MM/DD/YYYY`.

**It recalculates when the guest changes something, with no reload.** The
widget watches the data-attributes, the booking form's inputs, and
`history.pushState`/`replaceState`/`popstate`, and remounts (debounced) when
the resolved stay actually changes — a different hotel or different dates get
a fresh score in place.

**No hotel needs to be enrolled first.** A hotel id the catalogue has never
seen is looked up against the source on that first request, and its city with
it; a weekly sweep keeps the catalogue equal to the source's inventory ahead of
time. An id the SOURCE does not recognise is still an honest 404 and a hidden
panel — nothing is invented to fill the gap.

The script mounts every `[data-wah-pi]` element it finds, derives the API base
from its own `src`, validates the inputs (missing or invalid values — a past
check-in, an inverted range — mean NO request rather than a broken panel), and
**remounts automatically when the data-attributes change**, so a calendar that
swaps dates without a page reload just works.

**A hidden panel says why, in the console.** Hiding is correct for a guest, but
it makes a working embed and a broken one look identical to whoever is
integrating it, so the widget logs one `[wah-pi]` line: a `warn` when the
configuration is unusable (no hotel id, unparseable dates), and an `info` when
the embed is fine and the hotel simply is not collected yet. Check that console
line first when "nothing happens".

An uncatalogued hotel or a service failure hides the panel entirely
(`data-unavailable="notice"` opts into a message instead); the honest "could
not verify enough live data" state for a catalogued hotel always shows — that
message is the product being truthful, not failing.

The programmatic form is unchanged for pages that want control:

```html
<script>
  WahPriceIntelligence.mount(document.getElementById('wah-pi'), {
    apiBase: 'https://<deployment>',
    hotelId: '1198', // the page's own hotelID — same identifier
    checkIn: '2026-10-30',
    checkOut: '2026-11-02',
    adults: 2,
  });
</script>
```

`mount()` defaults to the live-market model. Pass `model: 'history'` for the
accrued-history analysis once baselines have matured.

**Room categories.** When a stay has more than one bookable room the panel
shows a "Room category" dropdown, priced, cheapest first. Choosing one
re-requests with `room_type_id` and re-scores from scratch — the comp set, the
nearby dates and the terms match all key off the chosen room, so the verdict
moves with the category rather than the price alone. A single-room stay shows
no dropdown. A pinned category that stops being bookable (sold out, or the
guest moved the dates) falls back to the lowest available rate with a console
note, rather than reporting "not found" for a hotel that still has rates.

**On-demand scoring.** A stay nothing has collected triggers a live fetch
server-side — the guest's exact stay plus its comparables, ingested through
the same pipeline as scheduled collection, then scored — so any valid dates on
a catalogued hotel get an answer, in seconds on the first ask and from cache
after. The widget shows staged progress ("Checking this stay…", "Comparing
live rates at similar hotels…") while that runs. It requires `WAH_API_KEY` in
the function's environment (the Deploy workflow pushes it from the repo
secret); without the key the path silently degrades to the honest no-score
state. Every on-demand fetch is recorded in the same attempt ledger as
scheduled collection, so a sold-out stay backs off rather than being re-fetched
per page view, and every successful fetch permanently widens the dataset.

## The two things most likely to bite

- **A stale build serving old code.** The function bundles `apps/api/dist`,
  which `npm run build` produces during the Vercel build — if a deploy ever
  seems to ignore a change, confirm the build step ran rather than a cache
  serving the previous output.
- **Widget on whatahotel.com, API blocked.** If the widget renders but every
  request fails in the browser console with a CORS error, `CORS_ORIGIN` is
  missing the exact origin (scheme and subdomain both count:
  `https://www.whatahotel.com` and `https://whatahotel.com` are different
  entries).
