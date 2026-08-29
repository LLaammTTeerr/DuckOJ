# Load-test results

Every number here was produced by `load/k6-contest-day.js` against the live
podman-compose stack at `http://localhost:8080` on **2026-08-29**, on a
16-core / 15.6 GB host running k6 and the stack together.

**The load generator shares the host with the stack.** k6 at 2000 VUs is
itself worth a couple of cores, so these are "what this one box does",
not "what the API does given a dedicated client". Treat them as a
before/after of the *same* setup, which is what they are, and not as an
absolute capacity figure.

## Headline: the full 2000-VU contest-day profile

Read-only mix, no `SESSION_COOKIE` (so the 10% `GET /submissions` leg is
skipped and folded into problem browsing — the same shape in every row, so
the rows compare).

| Config | commit | req/s | p95 (all) | problems_list | problem_detail | scoreboard |
| --- | --- | --- | --- | --- | --- | --- |
| single process (before) | `704a4ff` | 969 | **3.46 s** | *(untagged)* | *(untagged)* | *(untagged)* |
| `API_WORKERS=4` (shipped) | `bbc5063` | 1715 | **2.28 s** | 910 ms | 1.81 s | 3.57 s |
| `API_WORKERS=8` (probe) | `bbc5063` | 2074 | **1.97 s** | 673 ms ✓ | 1.31 s | 2.59 s |

Errors were **0.00%** in all three runs (`http_req_failed` and `leg_errors`),
and `vus` reached the full 2000 every time.

**The 800 ms threshold is still crossed.** Clustering bought 1.8x the
throughput and cut p95 by 34% (43% at eight workers), and it moved
`problems_list` under the bar, but the aggregate p95 is dominated by the
scoreboard leg — see "The next bottleneck".

The before row has no per-route columns because the per-route tags did not
exist yet; that is what commit `54186e9` added. Every later run has them.

## Why: measured, not guessed

Container CPU during a 500-VU hold, read as cgroup `cpu.stat` deltas
(**`podman stats --no-stream` reports CPU averaged over the container's whole
lifetime** — it moved from 65% to 68% across a 60-second load spike and told
us nothing; do not use it for this). 100% below is one full core of sixteen.

| | `api` | `postgres` | `caddy` |
| --- | --- | --- | --- |
| before (1 process) | **~120%** | ~111% | ~31% |
| after (`API_WORKERS=4`) | ~460% | ~330% | ~83% |
| after (`API_WORKERS=8`) | ~700% | ~450% | ~100% |

~120% is the signature of a saturated single-threaded process: Node runs
JavaScript on one thread, so 100% of that plus libuv and GC on the side is
the ceiling — with **thirteen of sixteen cores idle**. Postgres was never the
constraint; nothing was queued behind a slow query. There was one of the
thing doing the work. Hence `node:cluster`, not an index.

## Per-route, at 500 VUs (70 s: 10 s ramp, 60 s hold)

Two before rows, because the authenticated path is a different workload: with
a cookie every request additionally resolves the session (one indexed lookup
on `sessions.token_hash`), and the 10% `submissions` leg runs.

| Run | req/s | p95 (all) | problems_list | problem_detail | scoreboard | submissions |
| --- | --- | --- | --- | --- | --- | --- |
| before, no cookie | 812 | 1.26 s | 377 ms | 732 ms | 1.44 s | *(skipped)* |
| before, cookie (`hocsinh1`) | 491 | 1.86 s | 681 ms | 1.33 s | 1.98 s | 681 ms |
| after (4 workers), no cookie | 1174 | 1.08 s | 576 ms | 1.07 s | 2.05 s | *(skipped)* |

The authenticated path costs about 40% of throughput at the same VU count.
That is one extra round trip per request, not a slow query, and it is the
reason `load/README.md` insists a cookieless run "says nothing about the
authenticated path".

**The two "after" 500-VU numbers are not a clean A/B**: the host was quiet
(load ~5) for the before rows and busy with unrelated work (load ~22) during
the after row, which is why its p95 improves less than its throughput. The
2000-VU table above is the comparison to trust — those three runs are the
same profile against the same stack minutes apart.

## The next bottleneck: the scoreboard endpoint

At every load level and every worker count, `scoreboard` is 2.5–4x the
latency of `problems_list` and is what holds the aggregate p95 over 800 ms.
It is not I/O volume and not a missing index: the test contest's scoreboard
response is **520 bytes**, and unloaded the endpoint answers in ~13–23 ms
against ~8–12 ms for the other two.

It is per-request recomputation. `ContestAccessService.getScoreboard`
(`apps/api/src/authz/contest.access.ts`) resolves the contest, then loads the
problem rows, every participation row joined to `users`, and **every
submission in the contest**, then folds the whole board in JavaScript through
`computeContestScoreboard` — on every single request, with no cache and no
memoisation. That is the correct thing to do once; it is the wrong thing to
do 190 times a second, and its cost grows with the contest, which the seeded
`probe-cup` barely exercises.

Two directions, neither attempted here (the brief scoped this task to
clustering):

1. **Cache the computed board per contest**, invalidated on submission
   verdict changes, with a short TTL as a floor. The freeze window
   (`now`) is already a parameter, so a live board and a frozen board are two
   cache keys, not two code paths.
2. **Push the fold into SQL** — the per-participant aggregate is a
   `GROUP BY`, not a JavaScript reduce over every submission row.

Anything before that is premature: doubling workers again is blocked on
Postgres connections (below), and the API is no longer the thing that is
pegged.

## The connection ceiling behind `API_WORKERS=4`

Each worker opens its own Postgres pool of 10 (`packages/db/src/client.ts`,
`max: 10`), and the `postgres` service is stock `postgres:16` with
`max_connections=100`. Measured during the runs above:

- `API_WORKERS=4` → `pg_stat_activity` settled at **49** connections.
- `API_WORKERS=8` → **89**. Eleven spare, with `judged`, a `migrate` run and
  any `psql` session competing for them.

So 8 workers is faster and is *not* shipped as the default: it leaves the
stack one `psql` session away from `too many clients already`, which surfaces
as `api` failing its healthcheck and reads like a database outage. Raising
`API_WORKERS` past 4 means raising `max_connections` (or lowering the
per-worker pool) in the same change. See docs/runbook.md, "API workers".

## Reproducing

```
# per-route p95 at a fixed VU count, small enough to sample CPU through
VUS=500 DURATION=60s k6 run load/k6-contest-day.js

# the full profile (NOT against a stack serving people — see README)
k6 run load/k6-contest-day.js
```

Instantaneous container CPU, since `podman stats` cannot give it:

```
podman inspect duckoj_api_1 --format '{{.State.Pid}}'   # -> /proc/<pid>/cgroup
# then diff usage_usec in /sys/fs/cgroup/<that path>/cpu.stat over a known interval
```
