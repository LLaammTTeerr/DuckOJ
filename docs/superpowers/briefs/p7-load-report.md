# P7 — load: the API was one process on a sixteen-core box

**DONE_WITH_CONCERNS.** p95 3.46s → 2.28s at 2000 VUs (969 → 1715 req/s, 0%
errors), but the 800ms target is **not** met. Per the brief I stopped and
named the next bottleneck rather than tuning further. Numbers, method and
reproduction: `load/RESULTS.md`; the operator's view: runbook "API workers".

## Shipped

- `54186e9` — k6 tags every request with k6's `name` beside this script's
  `leg`, one `p(95)<800` threshold per route, plus a `VUS`/`DURATION` hold
  profile (k6 rejects `--vus/--duration` while `options.stages` is set).
- `bbc5063` — `apps/api/src/cluster.ts` + `main.ts`: `API_WORKERS` forks
  workers, re-forks on exit with 1s→30s backoff (reset after 30s uptime),
  handles SIGTERM/SIGINT in the primary. `1` = the old single-process path.
  Compose pins 4; `.env.example` + runbook say why not 16.
- `e2df601`, `d16e875`, *(this commit)* — RESULTS.md, README, this report.

## Measured before guessing

500-VU hold, cgroup `cpu.stat` deltas (100% = one core of sixteen): `api`
**~120%**, `postgres` ~111%, `caddy` ~31% — thirteen cores idle. ~120% is a
saturated single Node thread plus libuv/GC, with nothing queued on a slow
query. So: cluster, not migration 0017. **`podman stats --no-stream` is
useless here** — it averages over the container's lifetime and moved 65%→68%
across a 60s spike.

| 2000 VUs, cookieless | req/s | p95 | problems_list | problem_detail | scoreboard |
| --- | --- | --- | --- | --- | --- |
| before, 1 process | 969 | 3.46s | *(untagged)* | *(untagged)* | *(untagged)* |
| `API_WORKERS=4` (shipped) | 1715 | 2.28s | 910ms | 1.81s | 3.57s |
| `API_WORKERS=8` (probe) | 2074 | 1.97s | 673ms ✓ | 1.31s | 2.59s |

**Next bottleneck: the scoreboard.** `getScoreboard` loads every
participation *and every submission in the contest* and folds the board in
JavaScript per request, uncached — 520 bytes of response, ~13ms unloaded, so
not I/O and not a missing index. Cache per contest (freeze `now` is already a
parameter, so live vs frozen is two keys) or push the fold into SQL.

## Rulings (nobody to ask)

1. **Default 4 workers, not the faster 8.** Each opens its own pool of 10;
   `pg_stat_activity` measured 49 at four and **89 of 100** at eight. More
   workers means raising `max_connections` in the same change.
2. **Explicit `API_WORKERS` is honoured, not clamped** to the cap-of-8 that
   governs only the default; an unparseable value **throws at boot** rather
   than silently serving on one worker.
3. Staged explicit paths, never `git add -A` — the task brief overrides
   `conventions.md` there. This report is 79 lines against that file's 60:
   the per-route table and the rulings are the deliverable, and the detail
   they compress lives in `load/RESULTS.md`. Submissions #49–#51 left on
   `tong-hai-so`.

## Verification

- `resolveWorkerCount`: 13 tests red (module absent) → green; mutation-check
  (drop the cap, drop the integer guard) → **5 failed** → restored, 13 green.
- Ritual green, including `-r test` (**1101 tests, 0 failures**), regen
  no-diff and `vite build`.
- **Re-fork exercised, not merely documented**: killed a live worker → logged
  `worker 22 exited (code=null signal=SIGTERM) after 168s — re-forking in
  1000ms` → four workers again, healthy, `/problems` still 200.
- **Realtime across workers**: 8 `/ws` clients, 8/8 acked and 8/8 notified,
  spread over all four workers (fd counts 28/28/28/28 → 30/30/30/31 while
  open); all four pids appear in the request log.
- Real grade per image: `hocsinh1` → `tong-hai-so/solution.cpp` **AC 100/100**.

## Concerns

- **800ms is not met** at any worker count tried; the scoreboard owns the
  remaining tail, not the process model.
- Another agent ran unrelated container work throughout (loadavg 5→40) and k6
  shares the box. The three 2000-VU runs are minutes apart and comparable to
  each other; the 500-VU before/after pair is **not**, and RESULTS.md says so
  rather than averaging it away.
- P6 merged into main mid-measurement, so the measured image predates it.
  `api` was then rebuilt and recreated at merged main — four workers, healthy,
  smoke green on every per-route threshold — so the running API matches the
  web bundle Caddy serves.
