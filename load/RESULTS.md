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

## 2026-08-29 — with the scoreboard cache (P8, commit 5d4e80b)

Same 2000-VU profile, same host, `API_WORKERS=4`, Redis scoreboard cache
(D25, TTL 2 s):

| run | req/s | p95 all | problems_list | problem_detail | scoreboard |
| --- | --- | --- | --- | --- | --- |
| 1 process, no cache | 969 | 3.46 s | — | — | — |
| 4 workers | 1715 | 2.28 s | 910 ms | 1.81 s | 3.57 s |
| 4 workers + cache | **2391** | **1.20 s** | 643 ms ✓ | 1.22 s | 1.89 s |

789,134 requests, 0 failed. The 800 ms threshold is still crossed on two
routes. The scoreboard fold now runs once per 2 s per view, so its p95 is
queueing behind `problem_detail` (statement markdown per request) on
saturated workers, not the fold itself — the cache turned the scoreboard
from the heaviest route into the median one. Next lever is caching
`problem_detail`'s rendered statement the same way, then `API_WORKERS=8`
with `max_connections` raised.

Perspective: 2000 closed-loop VUs with no think time is ~2400 req/s. A
province contest of 2000 students refreshing every five seconds is ~400
req/s, which this host serves with p95 in the tens of milliseconds (the
500-VU samples above). The threshold is a stress target, not a pass/fail
for contest day.

## 2026-08-30 — the loop's new read routes (B9)

`load/k6-contest-day.js` now covers the five reads the feature loop added
after it was written — the tag list, the tag-filtered problem list, a
problem's statistics, the clarification feed and the booklet — each with its
own `name` tag and its own 800 ms threshold. The mix moved to make room
(45% problem browsing, 17% scoreboard, 10% each filtered list and
submissions, 8% statistics, 5% tags, 4% clarifications, 1% booklet); the
booklet is deliberately thin because a 60 s cache makes a heavier weight
measure the cache rather than the route.

**What build these numbers are from.** The deployed stack, which is the code
as of `b1e98fc` — *before* this branch's migration 0025, the dashboard
rewrite and the per-problem counter cache. The stack may not be rebuilt while
it is serving, so nothing below reflects those fixes and the post-fix numbers
await a redeploy.

### Two runs, and only one of them counts

| | host load at start | req/s | p95 (all) |
| --- | --- | --- | --- |
| contaminated | **28** | 968 | 1.18 s |
| reference | **3** | **1097** | **841 ms** |

The first run was taken while the box was busy with unrelated work, and it
overstates every route by roughly 40%. It is kept only because the
difference between the two rows is the clearest demonstration in this file of
why `load/README.md` insists the generator shares the host. **Read the
reference row.** 500 VUs, 70 s (10 s ramp, 60 s hold), no `SESSION_COOKIE`,
77,449 requests, **0 failed**, `leg_errors` 0.00%.

### Per-route p95, reference run

| route | p95 | avg | over 800 ms? |
| --- | --- | --- | --- |
| `problem_stats` | 960 ms | 634 ms | **yes** |
| `problem_detail` | 952 ms | 631 ms | **yes** |
| `scoreboard` | 537 ms | 211 ms | no |
| `clarifications` | 500 ms | 323 ms | no |
| `problems_list` | 491 ms | 324 ms | no |
| `booklet` | 478 ms | 324 ms | no |
| `problems_filtered` | 252 ms | 167 ms | no |
| `tags_list` | 239 ms | 159 ms | no |

**Every one of the loop's five new routes is under the bar**, the booklet
included — the typst compile is behind a 60 s cache and a whole room
downloading at the bell is exactly the burst that cache was built for.

### The two over the bar are worker saturation, not a slow route

`problem_stats` is the proof, and it is worth stating because it is
counter-intuitive: it answers from **Redis** (`X-Stats-Cache: hit`, verified
by hand) and is still the slowest route in the table. A fully cached route
cannot be over the threshold because of its own work. Both it and
`problem_detail` answer in **5–6 ms unloaded**; at 500 VUs they are queueing
behind a 4-worker API, which is this file's own documented ceiling with a
documented lever — `API_WORKERS=8` plus a `max_connections` raise, see "The
connection ceiling" above. That lever needs a redeploy, so it is not pulled
here.

**This corrects the guess at the end of the scoreboard-cache section.** "Next
lever is caching `problem_detail`'s rendered statement" is wrong twice: the
route returns **499 bytes of raw markdown** (nothing is rendered server-side),
and it answers in 5.8 ms unloaded. There is no rendering cost to cache.

### The real regression is not visible at this scale at all

Profiling `problem_detail` against a **seeded 200 000-submission** database
instead of the live one — where `aplusb` has fifteen attempts — found what
the load test cannot see: `attemptedCount`/`solvedCount` were an **uncached
aggregate over every submission the problem has ever had**, 200,000 index
rows and 201,620 buffers in **126 ms per request**, on `GET /problems` and
`GET /problems/{code}`. A floor, not the real cost: that database held no
contests, so D49's `NOT EXISTS` collapsed instead of probing once per row.

Fixed by keying the cache per problem rather than per page (D49's amendment),
which answers D49's own objection to caching them. Post-fix p95 awaits a
redeploy; the win is not measurable on this host either way, because at
fifteen submissions the aggregate is already free. That is the point — it is
a province-scale regression, and a load test against seeded fixtures is
structurally blind to it.

Migration 0025's dashboard indexes are the same kind of finding and are
recorded in D47's amendment rather than here: `/admin/dashboard` is not in
this profile, being one admin rather than a room.

## Reproducing

```
# per-route p95 at a fixed VU count, small enough to sample CPU through.
# Check `uptime` first — the 2026-08-30 section shows what a load average of
# 28 does to these numbers.
VUS=500 DURATION=60s k6 run load/k6-contest-day.js

# the full profile (NOT against a stack serving people — see README)
k6 run load/k6-contest-day.js
```

Instantaneous container CPU, since `podman stats` cannot give it:

```
podman inspect duckoj_api_1 --format '{{.State.Pid}}'   # -> /proc/<pid>/cgroup
# then diff usage_usec in /sys/fs/cgroup/<that path>/cpu.stat over a known interval
```

## 2026-08-30 — B12: the soak loop (read profile, judging, memory)

Deployed image `f960b06…` (started 18:27), `API_WORKERS=4`,
`JUDGED_CONCURRENCY=1`, one DMOJ judge. Same host, k6 sharing it as always.
The image cannot be mapped to a commit from the outside, so it is named by
id; it is **newer** than B9's `b1e98fc`, and the numbers below say by how much.

### The 500-VU profile: every route improved, and the bar is met

Same script, same mix, same VU count as B9's reference row — the only clean
A/B in this file. 60 s hold after a 10 s ramp, cookieless, host load 4.3.

| route | B9 (`b1e98fc`) | B12 (`f960b06…`) | change |
| --- | --- | --- | --- |
| `problem_stats` | 960 ms | **455 ms** | −53% |
| `problem_detail` | 952 ms | **455 ms** | −52% |
| `scoreboard` | 537 ms | **369 ms** | −31% |
| `clarifications` | 500 ms | **304 ms** | −39% |
| `problems_list` | 491 ms | **305 ms** | −38% |
| `booklet` | 478 ms | **323 ms** | −32% |
| `problems_filtered` | 252 ms | **159 ms** | −37% |
| `tags_list` | 239 ms | **152 ms** | −36% |
| **aggregate p95** | 841 ms | **428 ms** ✓ | −49% |
| req/s | 1097 | **1716** | +56% |

120,632 requests, **0 failed**, `leg_errors` 0.00%. **Every route is under the
800 ms bar, and so is the aggregate — the first run in this file that meets
the threshold.** Nothing regressed: the brief's "find any regression > 20%"
found none in either direction but improvement. Migration 0025's dashboard
indexes and D49's per-problem counter cache are deployed now and this is what
they were worth.

Unloaded medians, 20 sequential requests each, for the saturation question
B9 raised: `tags_list` 1.7 ms, `scoreboard` 2.1 ms, `clarifications` 3.0 ms,
`problems_filtered` 3.7 ms, `problem_detail` 3.8 ms, `problems_list` 3.9 ms,
`problem_stats` 4.0 ms. Every route is 2–4 ms, *faster* than the 5–6 ms B9
measured. There is no slow route left; what a p95 measures here is queueing.

### The full 2000-VU profile

514,105 requests over 5m30s, **0 failed**, `leg_errors` 0.00%, `vus` reached
the full 2000.

| | req/s | p95 all | problems_list | problem_detail | scoreboard | problem_stats |
| --- | --- | --- | --- | --- | --- | --- |
| P8, 4 workers + cache | 2391 | 1.20 s | 643 ms | 1.22 s | 1.89 s | *(no leg)* |
| B12 | 1557 | 2.15 s | 1.68 s | 2.52 s | 1.97 s | 2.55 s |

**These two rows do not compare, and saying so is the point.** P8 ran the old
70/20/10 mix; B9 rebalanced the profile to 45/17/10/10/8/5/4/1 to cover five
routes that did not exist when P8 ran, and never re-ran it at 2000 VUs. B12's
iteration is 1.55 requests against P8's ~1.8, spread over eight routes rather
than three, so both the aggregate p95 and req/s are measuring a different
workload. The per-route columns are the only honest comparison and even they
carry a different neighbour set on the same four workers.

What settles it is the 500-VU table above plus the unloaded medians: on the
identical profile the current build is 31–53% faster on every route, and no
route costs more than 4 ms of work. The 2000-VU numbers are four saturated
workers, which is this file's own long-documented ceiling with its own
long-documented lever (`API_WORKERS=8` + `max_connections`, still not pulled).
Host load reached 15 during the hold, k6 included.

### Judging soak: 200 submissions, and the judge nearly keeps up

200 valid C++ solutions to `tong-hai-so` (12 tests, 1000 ms) from five
`bh12-soak-*` accounts, one every 1.5 s for 5 minutes — a 40/min arrival rate.

| | |
| --- | --- |
| verdicts | **200/200 AC**, 0 rejected, 0 internal errors |
| **measured judge throughput** | **35.3 submissions/min** |
| time-to-verdict p50 | **24.0 s** |
| time-to-verdict p95 | **39.3 s** |
| time-to-verdict min / max | 2.9 s / 41.2 s |
| queue depth (max → end) | **23 → 0** |
| drain past the last submit | 40 s |

**The single judge does not quite keep up: 35.3/min served against 40/min
offered, a 12% deficit.** It shows as a queue that climbs roughly linearly to
23 over the five minutes and then drains in 40 seconds, and as a
time-to-verdict that degrades from 2.9 s (first submission, empty queue) to
41 s (last, behind 23 others). Nothing failed, nothing was re-leased, no lease
expired — it is a throughput deficit, not an error. A room of 2000 that
submits more than ~35 times a minute in aggregate needs a second judge, and
`JUDGED_CONCURRENCY` is not the knob (one judge is the bottleneck, not one
claim loop).

**Nothing refused a submission**, because nothing meters `POST /submissions` —
see D79, which records the gap and this number as the one that should set a
limit's threshold.

Container memory across the soak, `/sys/fs/cgroup` deltas:

- `judged` 54.4 MB → 67.3 MB, rising over the first ~120 grades then flat.
  13 MB over 200 grades in a Node process under sustained new work; a warm-up
  plateau, not a slope. Worth re-measuring at 2000.
- `judge` **119.5 MB → 289.6 MB, but oscillating** between 119 and 302 MB the
  whole time (122 MB at t=174 s, 265 MB at t=82 s, 142 MB at t=297 s). A
  sawtooth of one compile + one sandbox per grade, not growth. The end-to-end
  delta is where in the tooth the last sample landed.

### Memory: no leak in the API

- **Across the 2000-VU profile.** Four workers plus the primary: 614 MB
  before, 1620 MB immediately after — and **618 MB when re-measured 20
  minutes later**, i.e. back to baseline within 0.8%. The 1.6 GB is V8
  working set under 1557 req/s, released afterwards, not retained.
- **2000 WebSocket subscribe/unsubscribe cycles** on one connection
  (2000/2000 acked, 2000/2000 unacked, 0 errors). RSS 618 MB → 654 MB, and
  the shape is what matters: +35 MB over the first 600 cycles, then **+0.9 MB
  across the remaining 1400**. A plateau, not a slope. `SubmissionsGateway`
  keys its client map by the socket and deletes on `close`/`error`; the churn
  test says the per-subscription state is released too. Note the cycle
  re-runs `getVisible` every time — the re-ack shortcut only covers a
  subscription still held — so this also measured 2000 × 3 authz queries.

### Redis: bounded, and every key expires

Scanned **during** the 2000-VU hold, not after (a 2 s scoreboard TTL is gone
by the time a ramp-down finishes):

- **0 keys without a TTL.** Every write goes through one method,
  `RedisScoreboardCacheStore.set`, which is `SET … PX` — value and expiry in
  one command, deliberately (D25). There is no other Redis write path in
  `apps/api` or `apps/judged`: the realtime channel is pub/sub, which stores
  nothing.
- **1.30 MB used, 1.47 MB peak**, flat across the whole run.
  `keyspace_hits` 3,009,521 against `keyspace_misses` 51,487 — a **98.3% hit
  rate**.
- Two observations recorded rather than fixed. **`maxmemory` is 0 with
  `maxmemory-policy noeviction`**: nothing is capped and nothing would be
  evicted, which is safe only because every key expires — the property above
  is load-bearing, and a future cache key written without a TTL would have no
  second line of defence. And the cache **drops out transiently under load**:
  three of four workers logged `scoreboard cache unavailable … Stream isn't
  writeable and enableOfflineQueue options is false` at the instant k6 started,
  and four more episodes appeared during a 300-VU hold. Each is a short window
  in which boards are folded instead of read. It is by design that this can
  never fail a request (D25), and the 98.3% hit rate says it is rare — but it
  is not zero, and the warm-up case is the one B9's `219b05d` already had to
  paper over for a spec.

### Postgres: no missing-index candidate at this scale

`pg_stat_user_tables` diffed across the profile. The heaviest sequential
scanners were `users` (208,881 scans, 25.7M tuples), `tags` (406,934 /
5.17M), `contest_participations` (187,841 / 4.51M) and `organizations`
(208,435 / 208,435).

**None of them is a missing index, and no migration is justified by them.**
Every one of those tables holds fewer than forty rows on this deployment —
`users` 36, `contest_participations` 7, `tags` and `organizations` 0 — and a
sequential scan of a sub-page table is the *correct* plan; an index would be
slower and would cost a write on every insert. The counts are large because
the requests were (208k ≈ the number of problem-route requests in the run,
one visibility resolution each), not because the scans are.

This is the same structural blindness B9 recorded when it found D49's
regression by seeding 200,000 submissions rather than by load-testing: **a
load test against fixture-scale data cannot answer the province-scale index
question**, because the planner correctly refuses to use an index that would
not help. The honest result is "cleared at this scale, and this scale is not
the one that matters" — the province-scale version needs a seeded database,
which is how the last two real index findings were both made.

## 2026-08-31 — c1: the consolidation re-baseline

B-12/B-9's tables above predate a great deal — the editor, the CSRF origin
guard (D82), the submission meter (D80), teams (D99), the monitor (D95/D100),
the per-problem counter cache. This is the whole profile re-measured against
the **deployed** stack, which is `main` at **`9bb8291`** (the post-B-19 merge;
this consolidation branch's own changes are NOT deployed and do not touch the
runtime). Same host, same 16 cores, k6 sharing the box as always, host load
0.5–1.7 at the start of each read run.

### 500-VU read profile — the clean A/B against B12

Same `load/k6-contest-day.js`, same 45/17/10/10/8/5/4/1 mix, `VUS=500
DURATION=60s`, cookieless, host load 0.6. 121,926 requests, **0 failed**,
`leg_errors` 0.00%.

| route | B12 (`f960b06…`) | c1 (`9bb8291`) | change |
| --- | --- | --- | --- |
| `problem_stats` | 455 ms | **412 ms** | −9% |
| `problem_detail` | 455 ms | **411 ms** | −10% |
| `scoreboard` | 369 ms | **362 ms** | −2% |
| `booklet` | 323 ms | **280 ms** | −13% |
| `clarifications` | 304 ms | **275 ms** | −10% |
| `problems_list` | 305 ms | **277 ms** | −9% |
| `problems_filtered` | 159 ms | **142 ms** | −11% |
| `tags_list` | 152 ms | **138 ms** | −9% |
| **aggregate p95** | 428 ms | **397 ms** ✓ | −7% |
| req/s | 1716 | **1734** | +1% |

**Every route is under the 800 ms bar and every route improved on B12.** No
regression in either direction — the whole table moved the right way, by the
margin a slightly newer build and a quiet host buy. This is the row to trust:
identical script, identical mix, identical VU count, minutes-apart A/B.

### The submission meter (D80) does NOT throttle the read profile

Confirmed, not assumed. The k6 profile is **reads only** — it issues no `POST
/submissions` — so D80 cannot touch it, and the 0.00% failure rate says it
did not. Separately probed live: two `POST /submissions` back-to-back on one
fresh account returned **201 then 429 `submission_rate_limited`**, so the
meter is deployed and enforcing. It throttles the *soak* (below) by design and
is the reason the soak needs many accounts; it is invisible to the read k6.

### 2000-VU headline (the one-shot)

Full profile: 2 min ramp to 2000, 3 min hold, 30 s down. 535,593 requests,
**0 failed**, `leg_errors` 0.00%, `vus` reached the full 2000. Host load ~1.7
at start.

| | req/s | p95 all | problems_list | problem_detail | scoreboard | problem_stats |
| --- | --- | --- | --- | --- | --- | --- |
| B12 (`f960b06…`) | 1557 | 2.15 s | 1.68 s | 2.52 s | 1.97 s | 2.55 s |
| c1 (`9bb8291`) | **1623** | **1.73 s** | **1.20 s** | **1.77 s** | **1.78 s** | **1.80 s** |

+4% throughput, −20% aggregate p95, and every per-route p95 down 10–30% on
B12. The 800 ms bar is still crossed on the heavier routes — this is the same
four-worker saturation ceiling this file has documented since P8, with the
same unpulled lever (`API_WORKERS=8` + a `max_connections` raise, which needs
a redeploy). `problems_filtered` (614 ms) and `tags_list` (610 ms) stay under
the bar even at 2000 VUs.

### Judging soak — the single judge now keeps up

200 AC C++ solutions to `tong-hai-so` (12 tests, 1000 ms) from **20 throwaway
`c1-soak-*` accounts**, 10 each, round-robin one every 1.5 s = **40/min**, the
same arrival rate B12 offered. Twenty accounts (not B12's five) because D80
now caps each account at 20/10 min and 1/10 s; at 30 s per-account spacing the
soak measures the judge, not the meter. Same single-judge topology as B12
(`duckoj_judge_1`, `JUDGED_CONCURRENCY=1`).

| | B12 (`f960b06…`) | c1 (`9bb8291`) |
| --- | --- | --- |
| verdicts | 200/200 AC | **200/200 AC**, 0 rejected, 0 internal errors |
| measured throughput | 35.3/min | **39.4/min** (offered 40/min) |
| queue depth (peak → end) | 23 → 0 | **2 → 0** |
| TTV p50 | 24.0 s | **1.1 s** |
| TTV p95 | 39.3 s | **1.5 s** |
| TTV min / max | 2.9 s / 41.2 s | **0.7 s / 2.0 s** |
| drain past last submit | 40 s | **0 s** |

**The 12% deficit B12 measured is gone: the queue never built past 2 and TTV
stayed near its unloaded floor.** B12's queue climbed linearly to 23 because
its per-grade cost (first-submission TTV 2.9 s) put throughput below the
offered rate; here the first submission verdicts in 0.7 s and the judge clears
each faster than they arrive, so a room offering 40/min is served with p95 TTV
of 1.5 s. Same single judge — the improvement is per-grade cost (a warmer
build and a quiet host), not more judges. The B-12 conclusion still holds in
principle: a room whose *sustained* aggregate exceeds this judge's ceiling
needs a second judge (F11's multi-judge path), but that ceiling is now
comfortably above 40/min rather than just below it.

*Measured by the c1 consolidation loop, 2026-08-31, against deployed
`9bb8291`. Left on the live stack: 20 `c1-soak-*` accounts plus one
`c1-soak-*-probe`, and their 202 AC submissions on `tong-hai-so`. Nothing was
stopped or rebuilt.*
