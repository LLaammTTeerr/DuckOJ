# P7 — load: the API was one process on a sixteen-core box

**DONE_WITH_CONCERNS.** p95 improved 3.46s → 2.28s at 2000 VUs (throughput
969 → 1715 req/s, 0% errors) but the 800ms target is **not** met. Per the
brief, I stopped and named the next bottleneck rather than tuning on.

## What shipped

- `54186e9` — k6: every request now carries k6's `name` tag beside the
  existing `leg` tag, with a per-route `p(95)<800` threshold each, so a run
  reports which endpoint spent the time. Adds a `VUS`/`DURATION` hold profile
  (k6 rejects `--vus/--duration` while `options.stages` is set, so a
  fixed-VU run has to be selectable from inside the script).
- `bbc5063` — `apps/api/src/cluster.ts` + `main.ts`: `API_WORKERS` forks
  workers, re-forks on exit with 1s→30s backoff (reset after 30s uptime), and
  handles SIGTERM/SIGINT in the primary. `1` = old single-process path.
  Compose pins 4; `.env.example` and docs/runbook.md "API workers" explain
  why not 16.
- *(this commit)* — `load/RESULTS.md` (all numbers, with commits and dates),
  `load/README.md` updated, this report.

## Measured before guessing

500-VU hold, cgroup `cpu.stat` deltas, 100% = one core of sixteen:
`api` **~120%**, `postgres` ~111%, `caddy` ~31% — thirteen cores idle. That
~120% is a saturated single Node thread plus libuv/GC. Postgres was never
queued; no index was missing. So: cluster, not migration 0017.

**`podman stats --no-stream` is useless for this** — it averages CPU over the
container's whole lifetime and moved 65%→68% across a 60s load spike. I
switched to `/sys/fs/cgroup/.../cpu.stat` deltas; the method is in RESULTS.md.

## Numbers (2000 VUs, cookieless, same profile each time)

| Config | req/s | p95 | problems_list | problem_detail | scoreboard |
| --- | --- | --- | --- | --- | --- |
| before, 1 process | 969 | 3.46s | *(untagged)* | *(untagged)* | *(untagged)* |
| `API_WORKERS=4` | 1715 | 2.28s | 910ms | 1.81s | 3.57s |
| `API_WORKERS=8` | 2074 | 1.97s | 673ms ✓ | 1.31s | 2.59s |

**Next bottleneck: the scoreboard endpoint.** `getScoreboard` loads every
participation *and every submission in the contest* and folds the board in
JavaScript on every request, uncached. Not I/O — the response is 520 bytes
and answers in ~13ms unloaded. Cache per contest (the freeze `now` is already
a parameter, so live vs frozen is two keys) or push the fold into SQL.

## Rulings (nobody to ask)

1. **Shipped default is 4 workers, not 8**, though 8 is measurably faster.
   Each worker opens its own pool of 10; `pg_stat_activity` measured 49 at 4
   workers and **89 of 100** at 8. Raising it requires raising
   `max_connections` in the same change. Recorded in the runbook.
2. **Explicit `API_WORKERS` is honoured, not clamped** to the cap-of-8 that
   applies to the default; an unparseable value **throws at boot** rather
   than silently serving on one worker.
3. Staged explicit paths, never `git add -A` — the task brief overrides
   `conventions.md` here.
4. Left `content/problems/tong-hai-so` submissions #49/#50 in the database
   (a read-only profile plus one real graded submission, as briefed).

## Verification

- `resolveWorkerCount` TDD: 13 tests written red (module absent), then green;
  mutation-check (drop the cap, drop the integer guard) → **5 failed**,
  restored → 13 passed.
- Full ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`,
  `lint:scripts`, `-r test` (**1101 tests, 0 failures**), contracts/SDK regen
  no-diff, `vite build`.
- Real grade after the change: `hocsinh1` submitted `tong-hai-so/solution.cpp`
  → **AC, 100/100**, 12 cases, judged in 1.8s.
- **Realtime across workers**: 8 concurrent `/ws` clients, all 8 acked
  `subscribed` and all 8 received the `submission` notify. They were spread
  across all four workers — per-worker fd counts went 28/28/28/28 → 30/30/30/31
  while the sockets were open — and API logs show all four worker pids
  serving. The Redis fan-out is what `RedisSubmissionPublisher` promised.

## Concerns

- **800ms is not met**, at any worker count tried. Owner of the next step is
  the scoreboard, not the process model.
- Another agent ran unrelated container work on this host throughout;
  loadavg swung 5→40. The three 2000-VU runs are minutes apart and comparable
  to each other, but the 500-VU before/after pair is not — flagged in
  RESULTS.md rather than quietly averaged away.
- k6 and the stack share one 16-core box, so these are box numbers, not
  API-given-a-dedicated-client numbers.
- Recreating the *old* api container needed SIGKILL after a 10s SIGTERM
  timeout; the new primary handles SIGTERM, and later recreates were clean.
- The image under load was built from `bbc5063`. P6 (`77b777b`, `3232846`)
  landed on main from another worktree while these runs were in flight; it is
  in the tree but not in the measured container, and the ritual above was
  re-run green over the merged tree.
