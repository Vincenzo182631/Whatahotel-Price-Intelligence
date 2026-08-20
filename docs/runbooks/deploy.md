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

   | Variable       | Value                                                      |
   | -------------- | ---------------------------------------------------------- |
   | `DATABASE_URL` | the Neon connection string **with the `-pooler` hostname** |
   | `CORS_ORIGIN`  | `https://www.whatahotel.com,https://whatahotel.com`        |

   **Pooler, not direct.** Serverless instances each open their own database
   connection; the direct endpoint's connection limit is sized for migrations
   and steady servers, and traffic spikes will exhaust it. This is the opposite
   of the database-setup workflow, which requires the direct endpoint — the
   two workloads genuinely want different endpoints, and each doc says which.

   **CORS is an allowlist**, comma-separated, matched against the request's
   Origin. An origin off the list gets no header at all. Unset means `*`,
   which is for development only — do not ship it.

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

## Embedding on whatahotel.com

```html
<script src="https://<deployment>/widget.js"></script>
<div id="wah-pi"></div>
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
accrued-history analysis once baselines have matured. The widget renders an
honest "not enough data yet" state rather than a fabricated score — decide
per placement whether that state should show or the container should hide.

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
