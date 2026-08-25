# WhataHotel Price Intelligence — working notes

Embedded hotel price-intelligence platform. Answers one question: _is this hotel
rate actually a good deal?_

The full MVP specification is in [`docs/mvp/`](./docs/mvp/). **Read
`docs/mvp/README.md` before changing scoring behaviour** — most of what looks
like an arbitrary constant is a documented decision.

## Commands

```bash
npm install && npm run build
npm test                 # unit + scenario + property + integration
npm run typecheck
npm run format

npm run db:up            # Postgres 16 via docker compose (port 5433)
npm run db:reset         # drop, migrate, seed reference data
npm run db:check         # schema behaviour checks (safe against a populated DB)
npm run config:seed      # regenerate the scoring-config seed from defaults.ts

ALLOW_SYNTHETIC_SEED=1 npm run db:seed-dev   # synthetic rates + rollups + comps
npm run api              # http://localhost:3000 (widget demo at /)
npm run smoke            # API contract checks against a running server
npm run calibrate -- --sweep --report out.md   # calibration runbook (doc 11)

# Credentials: cp .env.example .env, then fill it in. `.env` is gitignored and
# the scripts below load it via --env-file-if-exists. An exported variable wins
# over .env, so CI secrets are never shadowed.
WAH_API_KEY=... npm run collect -- --catalog miami   # sync hotels + their perks
WAH_API_KEY=... npm run collect -- --catalog-sweep   # sync the WHOLE catalogue
WAH_API_KEY=... npm run collect                      # top up the grid + refresh what is due
WAH_API_KEY=... npm run collect -- --bootstrap       # grid only, skip the due-refresh
WAH_API_KEY=... npm run collect -- --dry-run         # show the plan, call nothing
```

**Setting up a production database:** run the **Database setup** workflow with
`confirm: apply` — it never needs the connection string outside a repository
secret. See [`docs/runbooks/database.md`](./docs/runbooks/database.md).

Collection runs from `.github/workflows/collect.yml` **every 6 hours**, live
since 2026-08-18. Six hours is the scheduler's shortest tier interval; anything
coarser silently caps every tier at the cron period. It does not quadruple API
spend — `planCollection` returns only stays actually due. **Read
[`docs/runbooks/collection.md`](./docs/runbooks/collection.md) before changing
it**, and if it ever has to be switched off, comment the two `schedule:` lines
rather than deleting them and record why: every day it is off is a day of
baseline this source cannot backfill.

Integration tests run only when `DATABASE_URL` is set; they skip otherwise so
`npm test` works without a database.

## Architecture

```
packages/core/     pure scoring engine — NO I/O of any kind
packages/data/     the ONLY SQL in the project
packages/ingest/   adapters, pipeline, rollups, comp sets, scheduler
packages/calibration/  point-in-time replay, metrics, weight sweep
apps/api/          Node http server (docs/mvp/06)
apps/web/public/   framework-free embeddable widget (docs/mvp/08)
                   mount() defaults to the LIVE model; model: 'history' for the other
db/migrations/     schema (docs/mvp/05)
db/checks/         schema behaviour checks
tests/             scenarios S1–S9, invariants P1–P12, unit, integration
```

`packages/core` has no database, network, clock or filesystem access. Its
dependencies are its arguments. That is what makes every scenario testable from
fixtures and every stored score reproducible — **do not introduce I/O into it.**
`input.now` is injected for the same reason; never call `Date.now()` inside the
engine.

## Rules that are not style preferences

1. **Money is integer minor units.** Never floats. `roundHalfAwayFromZero`
   exists because Postgres `round(numeric)` and JS `Math.round` disagree, and a
   recomputed score must match a stored one.
   **ADR is the base room rate, never the grand total over nights.**
   `nightly_amount_minor` is `(total_amount_minor - taxes_fees_minor) / nights`
   (migration 0011), which reconstructs the source's own per-night NET rate and
   matches how whatahotel.com quotes a night. Dividing the gross total inflated
   every nightly figure by 18-31% and put the widget on a different basis than
   the page it embeds into. `total_amount_minor` stays GROSS — the stay total is
   what the customer pays — so the two carry SEPARATE basis labels in the API
   and the widget. One label describing both is wrong about one of them.
2. **This is not a price predictor.** `WAIT` was retired in config v4 — gate G4,
   the eight never-WAIT guards, the boundary assertion and the `SHORT_LEAD_TIME`
   caveat are all gone, and migration 0008 makes the database reject the value
   outright. Nothing the customer reads may say what a price will do: no "prices
   will rise", no "book before it goes up", no "unlikely to soften". Invariants
   P1 (the verdict is never emitted) and P11 (no rendered explanation contains
   predictive language) are both release blockers.
3. **An absent Deal Score is `null`, never `0`.** A zero renders to the customer
   as "terrible deal". Invariant P2.
4. **The AI never computes.** It receives an `ExplanationBundle` of
   already-computed facts and rewords them. Every number it emits is validated
   against the bundle's allowlist. The deterministic template renderer must
   always work with the model disabled.
5. **Compare like with like.** Rates only ever compare within the same
   comparability class (meal plan × refundability × audience). A `ROOM` never
   merges into a `SUITE` baseline regardless of name similarity.
   **Baselines and the comp set key differently, on purpose.** Baselines use
   the class, which poisons to `UNRESOLVED` when a term is unstated — right for
   "what is normal for THIS room at THIS hotel". The Comp-Set Index uses the
   tolerant key in `normalize/compMatch.ts`, where `UNKNOWN` matches `UNKNOWN`
   but never a stated value. The class is `WAH:<rateCode>|<offer>` in
   production — the source's own plan identity, hotel-specific by construction
   — so a competitor can never share it: measured over 40 real stays, every
   competitor survived every other filter and none survived the class filter.
   Symmetric ignorance is a fair comparison; ignorance against knowledge is a
   false equivalence, and that merge stays forbidden. The tolerant match is
   weaker evidence, so `assessLiveConfidence` cannot return `HIGH` on it and
   returns `LOW` when nothing was stated at all.
6. **Weights and thresholds are config, not code.** They live in
   `packages/core/src/config/defaults.ts`, are versioned in `scoring_config`,
   and every `analysis` row records the version that produced it. They are
   starting priors and have **not** been calibrated against real data.
7. **Synthetic data never leaves development.** `scripts/seed-dev.mjs` fabricates
   rates so the pipeline can be exercised. It refuses to run without
   `ALLOW_SYNTHETIC_SEED=1`, because once synthetic rows are in
   `rate_observation` they are indistinguishable from real ones. Do not remove
   that guard, and do not point it at anything but a local database.
8. **The calibration sweep never writes config.** It emits a suggestion.
   Activating a configuration is a reviewed decision with evidence attached.
9. **A factor that cannot be measured is excluded, not scored well.** `cv` over
   one observation is not zero volatility, it is no information — scoring it
   1.00 made confidence _fall_ as the second observation arrived. Same principle
   as rule 3. Set `included: false` and let the weights renormalize.
10. **API keys are credentials.** `WAH_API_KEY`, environment only, redacted
    from every log line by `redact()`. Committed fixtures are scrubbed of the
    key and of `cfid`/`cftoken` session tokens, and a test enumerates the
    fixture directory to enforce it — do not replace that with a hardcoded
    list of filenames.
11. **View is a hard rule, like room class.** An OCEANFRONT room never merges
    with a CITY one. Both rules exist because a wrong merge mixes price tiers
    invisibly: before the view rule, five view categories spanning a 37% price
    range collapsed into one "room type".
12. **Tests are typechecked** (`tsconfig.tests.json`, wired into
    `npm run typecheck`). They import package source, so `tsc --build` does not
    see them; without this a test drifts out of sync with the interface it
    exercises and nothing complains.
13. **The property suite is seeded.** Unseeded it drew fresh inputs each run, so
    a real engine bug surfaced as intermittent flakiness. Use `FC_SEED=<n>` to
    explore deliberately, and promote any counterexample to a unit test.
14. **The stay grid must be topped up on every run, not just at cold start.**
    Lead times are relative to today, while `planCollection` only refreshes
    stays it can already see. Without the top-up the tracked set freezes at
    whatever the first run captured and empties after ~90 days — with every run
    still exiting 0. See `findMissingGridStays`.
15. **Partitions must stay ahead of the data — and, on the free tier, behind
    it too.** `rate_observation` is partitioned **daily** (migration 0015;
    monthly until then) with a `DEFAULT`, so running past the last real
    partition is silent — rows keep landing, and then _block_ the partition
    that should have held them. `ensure_rate_observation_partitions()`
    maintains the window and rescues anything stranded; `scripts/migrate.mjs`
    calls it on every run. Schema checks 10 and 11 enforce it. Daily
    granularity exists because of Neon's free-tier project cap: the size
    counter only falls on `TRUNCATE`/`DROP` (never `DELETE` + `VACUUM`), so
    retention must drop whole partitions — and a partition must be a day, not
    a month, for that to fit inside 512 MB.
    `enforce_rate_observation_retention()` runs from migrate **only when
    `RATE_OBSERVATION_RETAIN_DAYS` is set** — the collect workflow sets `7`;
    a developer database never sets it, so seeded history survives. The cost:
    observations older than the window are gone — baselines, analyses and the
    catalogue persist, but same-stay series and calibration replay are capped
    at the window. **After a Neon plan upgrade, delete that env line from
    `collect.yml` and history accrues again.** If the project ever fills
    anyway, the next collect run's retention drop self-heals it — `DROP`
    needs no free space.
16. **A stay that yields nothing must back off.** It has no observation, so the
    grid sees it as missing and would re-request it every run forever;
    `collection_attempt` exists solely to stop that. It is not a fact table —
    nothing in it reaches a baseline or a score. Any success resets the counter.
    Backoff keys on the **grid slot** (`hotel|lead|nights|adults`), never the
    date: wanted dates shift daily, so date keys reset the counter every UTC
    day and the backoff can never outlast the 6-hour cron (migration 0010).

17. **The catalogue is the source's whole inventory, not a curated list.** The
    widget has to answer on every hotel page on whatahotel.com, so nothing may
    require a human to enrol a hotel or a city. Two mechanisms, both automatic:
    `enrollHotel` on the first request for an unknown id, and the weekly
    `--catalog-sweep`. The sweep walks the hotel-id space because **the source
    cannot list itself** — measured 2026-08-20, `search` returns at most 12
    hotels for any term and `cityrates` at most 15 for any city, so "Miami has
    15 hotels" was the cap, never the inventory. Two things about the sweep are
    not negotiable: it **only ever adds** (an unknown id and a server fault
    both answer `500`, so a probe cannot tell them apart and deactivating on
    one would let a bad afternoon empty the catalogue), and what it finds
    starts at collection tier **`OFF`** — catalogued and scoreable on demand,
    but out of the scheduled grid, because the measured inventory is **3,202
    hotels across 705 destinations** (first full sweep, 2026-08-20), which at
    `WARM` is ~147k stays and a cycle of roughly a month. `promoteHotelForCollection` moves a hotel
    to `WARM` the first time a guest actually looks at it, so scheduled API
    spend follows real demand instead of the whole of inventory.

    **The same applies to automatic city syncs.** `syncHotelsFromCity` takes
    the tier explicitly: `WARM` when a human asked (`--catalog miami`), `OFF`
    for anything a page view triggered. A city sync writes up to 15 hotels, so
    at `WARM` one guest opening one hotel in a new destination adds ~690 stays
    to the scheduled grid — measured, the plan went from ~690 to 2,519 pending
    before this was fixed. Comparables never need scheduling:
    `findComparableIdentities` includes `OFF` hotels deliberately, and their
    rates are fetched live for the exact stay being scored.

18. **The source prices in the hotel's currency, not the caller's.** Doha
    answers in QAR, Miami in USD. Every stored-rate query filters on currency —
    correctly, because mixing them would compare 1,600 QAR to 1,600 USD — so a
    hard-coded `USD` default made every non-US hotel report "no rate for these
    dates" when what we actually had was a rate we refused to look at. A
    request that does not pin a currency is answered in whatever the hotel is
    quoted in (`findQuotedCurrency`: the most recent observation, then
    `hotel.base_currency`). Pinning still means what it says — a caller that
    asks for USD gets USD or nothing, never a silent substitution. **Never
    convert.** We have no FX rates, and inventing one would put a fabricated
    number in front of a customer.

19. **A comp set built from the destination says so.** `rebuildComparables`
    ranks on accrued baselines, so a hotel catalogued this week has no curated
    peers, and the Comp-Set Index is 45% of the live score. The fallback is the
    same filter the curated set starts from — same destination — and the result
    carries `compBasis: 'DESTINATION'`, which the API publishes.

    **The trigger is too few USABLE comps, not an empty table.** A curated set
    that exists and yields nothing is the worse case, and it was the one left
    unhandled: hotel 1198 held a ranked comp set that produced 0 usable rates
    on three separate stays, so the index was permanently unavailable in our
    best-collected destination — and the on-demand top-up could not rescue it,
    fetching 128 competitor rates and inserting none, because every one was
    already stored and none matched the subject's terms. The pool was wrong,
    not stale. `loadLiveIntelligence` re-asks with `widen` once it can count
    the usable comps, and keeps the curated answer when widening finds no more
    — reporting a fallback that changed nothing would be a false admission of
    weaker evidence. Market Compression follows the same choice, or the two
    signals describe different markets. It is weaker
    evidence and must never be rendered as a curated peer comparison. The
    curated set takes over automatically on the first rollup that has baselines
    to rank.

    **Within the destination, the SOURCE's ranking chooses who to compare
    against.** `cityrates` answers "the best hotels in this city" — up to 15,
    in descending `rank` order — and `discoverCityComparables` calls it with
    the guest's own dates before the comp set is built, so the shortlist is the
    source's opinion rather than an accident of which ids the sweep reached
    first. The rank is stored on `hotel.city_rank` (migration 0012) and orders
    the fallback; distance breaks ties for anything the source has not ranked.
    **`city_rank` orders, it never scores.** What it counts is undocumented and
    reads like volume or prominence, not quality, so weighting the score on it
    or rendering it as a rating would assert something we cannot support.
    Discovery only finds and ranks hotels — their rates still come from the
    ordinary on-demand fetch, through the ordinary pipeline, with the ordinary
    term classification. `cityrates`' own `rateDaily` is unreliable and is
    never used as a price.

20. **Compare a room to an equivalent room, not to the market's cheapest.**
    The comp set matches on rate TERMS, which answers "is this the same
    product commercially" and says nothing about whether it is the same kind of
    room. Without a room filter, a guest asking about an ocean-view suite was
    measured against whatever each competitor's cheapest terms-matching room
    happened to be — so a dearer category scored badly by construction rather
    than by evidence, which is exactly the "do not penalise a room for costing
    more" failure. `loadLiveIntelligence` walks three rungs, strongest first,
    stopping at the first that can carry the index: same class AND view, then
    same class, then any room. Measured on hotel 2008 (Sep 8-11): the $994
    Garden Suite scores **6.3 MARKET** against other suites, where against
    entry-level rooms it scored 1.1 PREMIUM — and the $774 Historic Ocean still
    scores 1.3 PREMIUM against other ocean-view rooms, because there the
    premium is real. The rung used rides in the response as
    `signals.comp_set.room_match`, and `ANY` must never be presented as
    equivalence: it means nobody else sells that category.

21. **Expensive is not the same as bad.** The Comp-Set Index is a price ratio,
    and at 45% weight a hotel 30% above its comp set scored zero on the largest
    component whatever it offered. Config v5 adds **Premium Justification**:
    the value a rate INCLUDES against the value its comparables include, in
    money, so it can be set against a price premium without inventing units.
    Where both sides are known the comp-set sub-score is computed on the
    EFFECTIVE ratio — each side net of its inclusions — and the bands stay on
    the raw CSI, because "priced above comparable hotels" is a fact about the
    price. **The quality signals the brief asks for do not exist in this
    source**: no endpoint returns a star rating or a guest rating, and
    amenities live only behind `method=info`, which answers 500 for our key.
    (Google Places supplies a guest rating — see rule 22 — but it is context
    beside the price, not a term in the score, so it does not change this.)
    Included value is the only validated quality evidence we hold, and when
    neither side's is known the answer is `LIMITED_DATA` with the penalty
    unchanged. A comparable that told us nothing is silent, not zero — scoring
    it zero would manufacture a justified premium out of gaps in our own data.

22. **Reputation is evidence, never a term.** The Google rating (migration 0013) informs the explanation and is shown beside the price. Nothing under
    `packages/core/src/scoring` reads it, and the API says so with
    `affects_score: false`. A rating and a price index are different kinds of
    number — 4.9 from 32 reviews and 4.7 from 4,500 are not comparable
    strengths of evidence, and a weighted score cannot express that difference
    while a reader can. An unmatched, doubtfully matched or unrated hotel
    renders NO rating rather than a zero one: 0.0 stars is a claim about a real
    property, and the same principle as rule 3. `UNVERIFIED` and `NO_MATCH`
    data is never used or displayed, and a FAILED lookup writes **nothing at
    all** — recording `NO_MATCH` on a timeout would retire a hotel from
    reputation forever, because the queue deliberately never revisits one.
    Matching is decided by geography, not by name: "Four Seasons Hotel Miami"
    and "Four Seasons Resort Palm Beach" share most of their words, so a hotel
    whose coordinates we do not hold is capped below the threshold and never
    verified on name alone. **The refresh interval is the entire ongoing
    bill**: 3,033 resolvable hotels is ~92,000 billed Places calls a month at
    24h and ~13,200 at the 168h default, and a rating averaged over thousands
    of reviews moves by hundredths over months — so a daily refresh buys 7x
    the cost for precision the signal does not have. See
    `docs/runbooks/reputation-and-reasoning.md`.

23. **The customer never reads a Deal Score below 6.0.** Owner business rule
    (2026-08-24): WhataHotel sells every hotel the widget appears on, so the
    score's on-page job is ranking good against better, not talking a guest
    out of the catalogue. `applyScoreDisplayFloor`
    (`packages/core/src/scoring/liveScore.ts`, floor `SCORE_DISPLAY_FLOOR =
60`) is applied at the RESPONSE BOUNDARY in both API routes, to the same
    result object the explanation bundle is built from, so the number, band,
    verdict and narrative stay coherent. Three things the floor must never
    do: it never touches what the engine computes or what `persistAnalysis`
    stores (calibration needs true scores — flooring them would poison the
    only data that can ever set the weights); it never turns an absent score
    into a number (rule 3 — null stays null); and it never edits the facts —
    a floored response may still say "priced above comparable hotels",
    because that is a statement about the price, not the verdict. 60 sits in
    the MARKET band, so the floored copy reads "Market rate / Consider
    booking", never a recommendation against the hotel.

## Adding or changing a factor

1. Update `docs/mvp/02-deal-score.md` with the rationale first.
2. Add the weight to `defaults.ts` (weights must sum to 1.0; validated).
3. Regenerate the seed: `npm run config:seed`.
4. Re-run the scenario suite — band or recommendation changes in S1–S9 must be
   explained before merging.

## Current state

Built and verified: schema and migrations, ingestion pipeline with room-type and
rate-plan normalization, baseline rollups at every ladder level, comp-set
builder, collection scheduler, the full scoring engine, the explanation bundle
and template renderer, the REST API, and the embeddable widget.

**The production source adapter is built** — `packages/ingest/src/adapters/whatahotel/`,
against the real `/data/api.cfm`, and exercised end to end (`npm run collect`).
Its header comment records what the API does and does not provide; the U-register
in `docs/mvp/README.md` is now mostly answered.

Things about this source that are not guessable and cost real money to relearn:

- **Every response is HTTP 200.** The real outcome is `wahData.status.code`. A
  client trusting HTTP reads a 401 as a successful empty result and ingests
  nothing while reporting healthy.
- **`rateDaily` is NET per night; `rateTotal` is GROSS per stay.** Verified by
  probing 1-night against 3-night stays. Using `rateDaily` understates every
  price by the tax factor (~25%).
- **`rateCode` is not the rate plan.** One code carries several priced offers,
  distinguished only by the prose prefix of `roomDesc`. Keying identity on the
  code alone silently discarded the cheapest offer of every three.
- **Status `204` means sold out**, not an error. `500` is a genuine fault and is
  never swallowed.
- **The API emits invalid JSON** (trailing commas) on roughly 20% of `rates`
  calls for some hotels, deterministically. `json.ts` repairs exactly that and
  nothing else.
- **No rate history (U3).** Baselines accrue forward from the first capture;
  expect `INSUFFICIENT_DATA` for roughly the first two weeks. That is the design
  working.

`WHATAHOTEL_INGEST_TUNING` carries the ingest settings this source requires —
room-type discovery on, fuzzy and attribute matching off. Each value fixes a
merge observed in live data; do not relax them without re-measuring.

M7 tooling is built (`npm run calibrate`), but **calibration itself needs real
data**. Running it against the synthetic seed exercises the harness and nothing
more — the report says so in a banner, and the CLI exits 0 on a synthetic FAIL
so it cannot redden a build with a meaningless failure.

Config v2 removed **F5 (Demand)** from the Deal Score: it was an affine function
of F1 and carried no independent signal. Demand still drives gate G3, where it
acts on the recommendation rather than the score. A regression test asserts the
factor list is exactly `[F1, F2, F3, F4, F6]`.

Config v3 added the **live-market model** — Comp-Set Index, Calendar Delta and
Market Compression (`packages/core/src/scoring/liveSignals.ts` and
`liveScore.ts`, fed by `packages/data/src/loadLiveIntelligence.ts`). It scores
from rates that exist today rather than from accrued history, which is what
makes it usable before a baseline has built up.

**A stored subject rate is not an answerable stay.** The Comp-Set Index is 45%
of the live score and needs `minComps` competitor rates on the subject's terms,
so a hotel we have collected in a destination we have not scores nothing —
and the on-demand path could not fix it, because it fires only when the
SUBJECT is missing. `topUpComparablesOnDemand` fetches just the comparables in
that case. It carries its OWN hold (`countRecentAttempts`) and cannot borrow
the subject's: `wasStayRecentlyFruitless` keys on the stay that succeeded, so
for this case it is false forever and every page view would refetch the comp
set. One fresh attempt row on any comparable means the pass already happened.

**On-demand scoring is live** (2026-08-20): a live-intelligence request for a
stay nothing has collected fetches that exact stay — plus its comparables —
from the source right then, ingests it through the ordinary pipeline, and
scores it (`packages/ingest/src/pipeline/onDemand.ts`). This deliberately
relaxed the old "never call a rate source on a page view" rule; what did NOT
relax is honesty — an unverifiable stay still renders no score. Guards: only
catalogued active hotels, a lead window (≤300 days), a fruitless-attempt hold
(shared `collection_attempt` ledger, so widget traffic cannot hammer a
sold-out stay), and a comparables cap per request. Requires `WAH_API_KEY` in
the API's environment; degrades silently to the honest 409 without it. The
widget auto-mounts from `data-wah-pi` attributes and remounts when they
change — see `docs/runbooks/deploy.md`.

**Universal hotel support is live** (2026-08-20). The widget detects the stay
from the page — explicit `data-wah-pi-*` attributes first, then the booking
form, then the URL query string, then the URL path (`/hotels/<id>/`) — and
remounts when any of that changes, so a guest editing the date picker gets a
recalculated score with no reload. Nothing in it is destination-specific. The
catalogue side is rule 17. Two source facts made this work at all: the `hotel`
method answers for an arbitrary id (so no hotel has to be pre-registered), and
its success code is **`100`, not `200`** — a client accepting only `200` throws
on every hotel lookup, which is what stopped automatic enrolment working the
first time.

Config v4 **retired WAIT** (see rule 2). Reading the eight never-WAIT guards as
a list makes the case: each one meant "we cannot responsibly predict this", and
eight of them means we cannot predict it at all. Two of their values survive
because they describe the market now rather than later —
`rec.book.urgencyScarcityRooms` and `rec.book.urgencyDemand`, both feeding gate
G3.

**Reputation and the reasoning layer are live** (2026-08-21, migration 0013).
`packages/ingest/src/adapters/google/` resolves hotels to Google places — geo is
the arbiter, name similarity alone cannot separate two properties of the same
brand — and `packages/ingest/src/adapters/openai/` rewords the finished facts.
The live model now has its own `ExplanationBundle`
(`packages/core/src/explanation/liveBundle.ts`) with the same numeric allowlist
the history model has had since M5, plus a deterministic renderer that must keep
working with the model disabled (rule 4) and `validateNarrative`, which rejects
a draft whole rather than patching it. Both integrations are optional: with
neither key set, the API returns `reputation: null` and
`explanation.source: "TEMPLATE"`, and nothing else about the response moves.
`OPENAI_API_KEY` and `GOOGLE_PLACES_API_KEY` are server-side only — never in
HTML, widget JavaScript, a data attribute, or anything a bundler inlines into
the browser.

**The personalization layer is live** (Phase 6, 2026-08-22). The widget asks
"what matters most to you?" and the API takes `preference=` — nine options plus
the default `GENERAL_VALUE`, which produces byte-for-byte the un-personalized
response. The hard rule: **a preference never changes a number.** It cannot,
structurally — personalization (`packages/core/src/explanation/personalization.ts`)
is built FROM the finished bundle after every number is decided, and a test
compares all objective blocks across all ten preferences. What a preference
does move: which facts are foregrounded, the alternative's RANKING among
already-eligible candidates (never its eligibility), and the alternative's
reason sentence. The preference travels inside the bundle, so the reasoner's
cache separates per preference for free. Honesty constraint: the source's
`info` endpoint answers nothing, so we hold NO amenity/family/nightlife/quiet/
business data — those preferences say "limited information is available"
rather than inventing a fit, fit lists are capped at three and never padded,
and model-written personalization passes the same allowlist/prediction/
absent-evidence gate as the assessment or the deterministic one ships.

The weights in every version so far remain uncalibrated priors.
