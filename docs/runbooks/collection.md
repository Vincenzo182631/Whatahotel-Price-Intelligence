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
   each target lead time (7, 14, 21, 30, 45, 60, 90 days) for 1- and 3-night
   stays. Those offsets are relative to _today_, so the grid rolls forward as
   time passes. This step is idempotent — after the first run it only adds the
   dates that have newly come into range.
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

**A daily cron caps every tier at 24 hours.** HOT stays — the ones a customer is
about to book — are then refreshed a quarter as often as designed, and factor
F3 (trend) gets fewer points inside its 7-day window, which lowers confidence
and makes the WAIT gate harder to reach.

Running the cron every 6 hours does **not** multiply API calls by four:
`planCollection` still only returns stays that are actually due, so WARM and
COLD stays are skipped on the intermediate firings. The extra cost is roughly
the HOT set, which is what the tiering was designed to spend on.

Daily is the configured default because it is what was asked for. To honour the
tiers, switch the schedule to `0 */6 * * *` — one line in
`.github/workflows/collect.yml`, or in the crontab below.

---

## Option A — GitHub Actions (configured)

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
# /etc/cron.d/wahpi-collect     (daily at 06:00 local; use 0 */6 for the tiers)
0 6 * * *  wahpi  set -a; . /etc/wahpi.env; set +a; \
  cd /srv/wahpi && /usr/bin/npm run collect -- --limit 500 --concurrency 6 \
  >> /var/log/wahpi/collect.log 2>&1
```

`flock` if runs could ever overlap:

```cron
0 6 * * *  wahpi  /usr/bin/flock -n /var/lock/wahpi-collect.lock -c '...'
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
ExecStart=/usr/bin/npm run collect -- --limit 500 --concurrency 6
```

```ini
# /etc/systemd/system/wahpi-collect.timer
[Unit]
Description=Daily WhataHotel rate collection

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now wahpi-collect.timer
systemctl list-timers wahpi-collect.timer
```

---

## First run on a new database

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
skipped stays are gone.

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
