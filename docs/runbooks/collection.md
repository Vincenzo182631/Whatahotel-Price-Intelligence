# Runbook — scheduled rate collection

Collection is the only thing that produces the data everything else scores.
**This source has no rate history (U3).** It answers "what is the rate now",
never "what was it", so a day not collected is a day of baseline that can never
be recovered — not by a longer run tomorrow, not by any backfill. Treat a failed
collection as data loss, not as a retryable job.

---

## What one run does

`npm run collect` does three things, in order:

1. **Extends the stay grid.** For every active hotel it ensures a stay exists at
   each target lead time (anchor pairs 14/17, 35/38, 63/66 with ±7/±14-day
   satellites — see `DEFAULT_GRID_SPEC`) for 1- and 3-night stays. Those leads
   are relative to _today_, so the grid rolls forward as time passes. This step
   is idempotent — after the first run it only adds the dates that have newly
   come into range.

   Coverage is **±1 day tolerant** (`GRID_COVERAGE_TOLERANCE_DAYS`): a wanted
   date counts as tracked if a stay of the same hotel/nights/adults exists
   within a day of it. Without that tolerance the daily rollover re-proposed
   the whole grid: no two grid leads differ by one day, so each new UTC day's
   wanted dates were disjoint from yesterday's, every one of them looked
   untracked, and the run truncated at `--limit` — measured 2026-08-19 as
   "690 new, 231 due", with 421 stays cut and HOT-tier refreshes starved.
   ±1 is safe because adjacent grid leads are at least 3 days apart, so one
   tracked stay can never satisfy two wanted dates.

2. **Refreshes what is due.** `planCollection()` returns tracked stays whose last
   capture is older than their tier's interval.
3. **Rolls up.** Baselines at every ladder level, then comp sets.

Step 1 is not optional. Without it the tracked set is frozen at whatever the
first run captured, ages out one day at a time as check-in dates pass, and after
about 90 days there is nothing left to collect — while every run still exits 0.

### Stays that yield nothing

Because step 1 rebuilds the grid from lead-time offsets, a stay that produces no
observation still looks "missing" on the next run, and would be asked for again
every run forever. `collection_attempt` records what each attempt did so the
collector can back off: the first three failures are free, then the retry delay
doubles — 1h, 2h, 4h … capped at one week. **Any success resets the counter to
zero**, so a stay that starts pricing again is picked straight back up.

The delay is in hours, so it interacts with how often the cron fires: at
6-hourly, the early doublings are shorter than the gap between runs and so pass
unnoticed, and a genuinely dead stay takes roughly a dozen attempts over three
or four days to settle at the weekly cap. That is deliberate — backing off
faster would risk exiling a stay that is merely mid-outage.

`last_outcome` says why a stay yielded nothing:

| Outcome           | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `OK`              | rates returned and stored                                  |
| `NO_AVAILABILITY` | status 204 — genuinely sold out for those dates            |
| `ERROR`           | status 500 after retries — the API refuses this hotel/date |
| `EMPTY`           | status 200 Success, zero rooms                             |

`EMPTY` is worth understanding before assuming a parser bug. The payload's
`result` object distinguishes the two cases: `{"count": 0, "filtered": 65}` means
the API found 65 rooms and filtered every one of them away server-side, not that
the hotel is empty. Check with a direct call before changing any parsing:

```bash
curl -s "https://whatahotel.com/data/api.cfm?method=rates&hotel=<id>\
&guests=2&checkIn=<date>&checkOut=<date>&apiKey=$WAH_API_KEY" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["wahData"]["result"])'
```

To see what is currently backed off:

```sql
SELECT h.wah_hotel_id, a.check_in, a.nights, a.consecutive_failures, a.last_outcome
  FROM collection_attempt a JOIN hotel h ON h.id = a.hotel_id
 WHERE a.consecutive_failures > 0
 ORDER BY a.consecutive_failures DESC;
```

---

## Cadence

The scheduler assigns each stay a tier and a refresh interval:

| Tier | When                                         | Interval |
| ---- | -------------------------------------------- | -------- |
| HOT  | lead ≤ 30 days, or viewed in the last 7 days | 6 hours  |
| WARM | everything else inside the horizon           | 24 hours |
| COLD | far-out, never viewed                        | 72 hours |

**Collect every 6 hours**, matching the shortest tier interval. That is what
the GitHub schedule runs at (Option A, live since 2026-08-18). Anything coarser
silently caps every tier at the cron period: a daily job would give HOT stays a quarter of their
intended cadence, and factor F3 (trend) far fewer points inside its 7-day
window, which lowers confidence and pushes more analyses to INSUFFICIENT_DATA.

Six-hourly does **not** multiply API calls by four. `planCollection` returns
only stays that are actually due, so WARM and COLD stays are skipped on the
intermediate firings; the extra cost is roughly the HOT set, which is what the
tiering exists to spend on. Measured against a full 15-hotel grid (177 tracked
stays, 2,570 observations) a firing with nothing due and no gaps plans in 0.14s
across four queries and makes no API calls.

The one thing a shorter period does multiply is retries of stays that yield
nothing, since those are re-proposed until the backoff engages — 33 of them on
the current set, for roughly the first day. That is bounded and self-limiting,
but it is why the backoff exists at all.

Going finer than 6 hours buys nothing: no tier asks for it, so the extra
firings would find nothing due and simply idle.

---

## Option A — GitHub Actions (schedule LIVE)

> **`.github/workflows/collect.yml` fires on `cron: '0 */6 * * *'`.** It was
> turned on 2026-08-18, after the first real run against the production
> database succeeded: 690 stays planned, 8,549 rates ingested, 0 rejected,
> 6,072 baseline rows, 104 comparable pairs across 15 hotels.
>
> The schedule was held off until then for a specific reason worth remembering
> if it is ever switched off again: with the schedule active and no
> `DATABASE_URL`, the job fails four times a day — correct behaviour, since a
> silent healthy-looking no-op would be far worse, but it fills the Actions tab
> with red that everyone learns to ignore. Better honestly off than noisily
> broken. That trade no longer applies: both secrets are set and the run is
> green.
>
> **If you need to turn it off**, comment out the two `schedule:` lines rather
> than deleting the block, and say here why and until when. Every day the
> schedule stays off is a day of baseline this source cannot backfill — see U3
> at the top of this document. Off is a pause, not a resting state.
>
> **Turning it back on** is the same four steps it took the first time:
> provision a Postgres reachable from GitHub-hosted runners, set both secrets
> (below), run the workflow manually with `dry_run: true` to prove credentials
> and connectivity without spending budget, then uncomment the `schedule:`
> lines.

`.github/workflows/collect.yml`. Requires two repository secrets:

| Secret         | Value                                                   |
| -------------- | ------------------------------------------------------- |
| `WAH_API_KEY`  | the WhataHotel data API key                             |
| `DATABASE_URL` | a Postgres URL reachable **from GitHub-hosted runners** |

Set them under _Settings → Secrets and variables → Actions_. Never commit either.

**The reachability requirement is the catch.** GitHub-hosted runners come from
GitHub's IP ranges; if the database sits inside a VPC or behind an IP allowlist,
this workflow cannot reach it and the job will fail on connect. In that case use
Option B, or register a self-hosted runner inside the network and change
`runs-on`.

Manual run, including a no-op plan:

```
Actions → Collect rates → Run workflow → dry_run: true
```

The run summary lists what was collected; the full log is attached as an
artifact for 14 days.

---

## Option B — cron on a server

Same commands, no reachability constraint. Put the credentials in a file only
the service user can read — **not** in the crontab line, where they would be
visible to `ps` and to anyone who can read `/var/spool/cron`.

```bash
sudo install -m 0600 /dev/null /etc/wahpi.env
sudo tee /etc/wahpi.env >/dev/null <<'EOF'
WAH_API_KEY=...
DATABASE_URL=postgres://user:pass@host:5432/wahpi
EOF
```

```cron
# /etc/cron.d/wahpi-collect     (every 6 hours, matching the HOT tier)
0 */6 * * *  wahpi  set -a; . /etc/wahpi.env; set +a; \
  cd /srv/wahpi && /usr/bin/npm run collect -- --limit 800 --concurrency 6 \
  >> /var/log/wahpi/collect.log 2>&1
```

`flock` if runs could ever overlap:

```cron
0 */6 * * *  wahpi  /usr/bin/flock -n /var/lock/wahpi-collect.lock -c '...'
```

### systemd timer instead

Preferable on a systemd host: it gives you `systemctl status`, journal
integration, and `Persistent=true`, which runs a firing that was missed because
the machine was down — worth having when a missed run is unrecoverable data.

```ini
# /etc/systemd/system/wahpi-collect.service
[Unit]
Description=WhataHotel rate collection
After=network-online.target

[Service]
Type=oneshot
User=wahpi
WorkingDirectory=/srv/wahpi
EnvironmentFile=/etc/wahpi.env
ExecStart=/usr/bin/npm run collect -- --limit 800 --concurrency 6
```

```ini
# /etc/systemd/system/wahpi-collect.timer
[Unit]
Description=WhataHotel rate collection, every 6 hours

[Timer]
# Matches the scheduler's shortest tier interval; see Cadence above.
OnCalendar=*-*-* 00/6:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now wahpi-collect.timer
systemctl list-timers wahpi-collect.timer
```

---

## Setting up the API key

The key is a credential. It lives in the environment and nowhere else — never in
a file that git tracks, never on a command line in a shared shell (it lands in
`~/.bash_history` and in `ps` output for every user on the box), never in an
issue, a screenshot, or a log. `redact()` strips it from every URL this project
logs, which is the last line of defence, not the first.

### Local development

```bash
cp .env.example .env
${EDITOR:-nano} .env          # set WAH_API_KEY and DATABASE_URL
```

`.env` is gitignored. The npm scripts that need credentials pass
`--env-file-if-exists=.env`, so this is picked up with no further step:

```bash
npm run collect -- --dry-run  # reads .env; no exported variables needed
```

Two behaviours worth knowing, both verified:

- **An exported variable beats `.env`.** This is what makes the arrangement safe
  in CI — a stray `.env` can never shadow a real secret — and it also gives you
  a one-off override: `WAH_API_KEY=other-key npm run collect -- --dry-run`.
- **A missing `.env` is not an error.** Node prints `.env not found. Continuing
without it.` and carries on, which is why CI (where the file never exists) is
  unaffected. Expect that line in CI logs; it is not a failure.

`npm test` and any direct `node`/`psql` call read the ambient environment rather
than `.env`. For those:

```bash
set -a; . ./.env; set +a
```

### GitHub Actions

Repository secrets, set by someone with admin on the repo:

```bash
gh secret set WAH_API_KEY  --repo <owner>/<repo>
gh secret set DATABASE_URL --repo <owner>/<repo>
```

`gh secret set` prompts for the value on stdin rather than taking it as an
argument — use that, so the key never enters shell history. The UI equivalent is
_Settings → Secrets and variables → Actions → New repository secret_.

Never `echo "$KEY" | gh secret set ...` in an interactive shell, and never put
the value in a workflow file, a `env:` default, or a PR description. Secrets are
write-only once set: GitHub will not show you the value again, which is a
feature.

### On a server

See Option B above — `/etc/wahpi.env`, mode `0600`, owned by the service user,
loaded via `EnvironmentFile=` or `set -a; . /etc/wahpi.env; set +a`. The point is
the same: readable by exactly one account, never on a command line.

### If a key is exposed

Rotate it. A key that has appeared in a chat log, a terminal transcript, a CI
log, or a shared screen should be treated as compromised even if nothing
obviously bad happened — rotation is cheap and certainty is not. Once rotated,
update the three places it can live: `.env` locally, the repository secret, and
the server's env file.

---

## First run on a new database

> Provisioning, credentials and partition maintenance are in
> [`database.md`](./database.md). Do that first — this section assumes the
> database exists and the `DATABASE_URL` secret is set.

```bash
node scripts/migrate.mjs --reset                 # schema + reference seeds
npm run collect -- --catalog miami               # hotels and their perks
npm run collect                                  # grid + first capture
```

`--catalog` is separate on purpose: it costs API calls and the hotel set changes
rarely. Re-run it when you add a destination, not on a schedule.

---

## Reading the output

```
• Plan: 158 stay(s) — 158 new, 0 due (HOT=60 WARM=98)
• Fetching 158 stay(s) … 1119 rate(s) in 15.5s
  4 stay(s) sold out — no rates exist for those dates
  ! 10 response(s) were invalid JSON and had to be repaired
• Ingest: 1119 inserted, 0 duplicate, 0 rejected, 51 new room type(s)
• Baselines: 1637 row(s) (L0=550 L1=364 L2=315 L3=159 L4=249)
```

| Line                      | Normal                  | Investigate when                                                      |
| ------------------------- | ----------------------- | --------------------------------------------------------------------- |
| `sold out`                | a few per run           | most of a run — check the dates are still in the future               |
| `invalid JSON … repaired` | ~10 per 40 stays        | zero _and_ rates dropped, i.e. the repair stopped matching the defect |
| `rejected`                | 0                       | anything above 0 — check `ingest_reject.reason_code`                  |
| `new room type(s)`        | high on run 1, ~0 after | steadily rising: the matcher is fragmenting, see rule 11 in CLAUDE.md |
| `plan truncated`          | never                   | always — stays went uncollected and that data is gone                 |

---

## When it fails

**Everything returns zero rates.** Check the key first. The API answers HTTP 200
even for auth failures, so a bad key looks like an empty result to anything that
trusts the HTTP status — the client checks `wahData.status.code` instead, and
raises. Look for `401` in the log.

**`plan truncated`.** More stays were due than `--limit` allowed. Raise the limit
or shorten the interval. Do not ignore it: with no history in the source, the
skipped stays are gone. The limit went 500 → 800 on 2026-08-20 after two days
live measured steady-state demand at ~680 per run (~500 due + ~180 re-proposals
of stays that yield nothing) — 500 was truncating ~180 stays on every firing,
and the uncollected dues carried forward as a permanent backlog.

**Nothing due and no gaps.** Expected if a run happened within the tier
interval. If it persists for a day, confirm hotels exist and are active:

```sql
SELECT count(*) FROM hotel WHERE is_active AND collection_tier <> 'OFF';
```

**Everything rejected as `UNMATCHED_ROOM_TYPE`.** Room-type discovery is off.
The collector sets `WHATAHOTEL_INGEST_TUNING` for this; a caller that passes its
own ingest options must include it.

**Scores still say `INSUFFICIENT_DATA` after a week.** Expected. Baselines accrue
forward from the first capture and need roughly two weeks of history. Confirm
progress rather than guessing:

```sql
SELECT count(DISTINCT observed_date) AS days_of_history FROM rate_observation;
```

---

## Cost and limits

Roughly 2.2–2.6 seconds per `rates` call; concurrency is what sets throughput,
not per-call speed. 15 hotels × 14 stays ≈ 210 calls ≈ 1–2 minutes at
`--concurrency 6`.

**U15 is still open** — no documented rate limit or per-call cost. The client
retries only what is retryable (500/503, never 400/401) so a bad request cannot
burn the budget in a loop, but nobody has told us what the budget is. Confirm
before scaling much past the current hotel set.
