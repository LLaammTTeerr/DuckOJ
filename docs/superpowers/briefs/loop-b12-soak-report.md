# B12 — soak, judging throughput and memory

Six findings: five **cleared with numbers**, one defect fixed with a migration.
New **D78** (sweeper) and **D79** (submission metering, ruled, not built).
Every number and its method: `load/RESULTS.md`, new B12 section.

Stack under test: deployed image `f960b06…`, `API_WORKERS=4`,
`JUDGED_CONCURRENCY=1`, one DMOJ judge. Newer than B9's `b1e98fc`; not mappable
to a commit from outside, so named by id.

## 1. Read profile — no regression, and the bar is met for the first time

Identical script, mix and VU count as B9's reference row — the only clean A/B.

| | `problem_stats` | `problem_detail` | `scoreboard` | `clarifications` | `problems_list` | `booklet` | `problems_filtered` | `tags_list` | **p95 all** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B9 | 960 | 952 | 537 | 500 | 491 | 478 | 252 | 239 | 841 ms |
| B12 | **455** | **455** | **369** | **304** | **305** | **323** | **159** | **152** | **428 ms** ✓ |

−31% to −53% every route, 1097 → **1716 req/s**, 120,632 requests, **0 failed**.
**First run in `RESULTS.md` to meet 800 ms**, aggregate and per route. Unloaded
every route is **2–4 ms** (B9: 5–6): no slow route remains. The one 2000-VU run
(514,105 requests, 0 failed, 1557 req/s, p95 2.15 s) **does not compare to P8's
2391/1.20 s** — different mix; RESULTS.md carries why. Four saturated workers,
this file's known ceiling.

## 2. Judging soak — the single judge does not quite keep up

200 solutions to `tong-hai-so`, five `bh12-soak-*` accounts, one per 1.5 s for
5 min (40/min offered). **200/200 AC, 0 rejected, 0 IE. Throughput 35.3
submissions/min** — a 12% deficit. Time-to-verdict **p50 24.0 s, p95 39.3 s**
(2.9 s first, 41.2 s last). Queue reached **23**, drained 40 s after the last
submit. No lease expired: a throughput deficit, not an error. Over ~35/min
aggregate needs a second judge — one judge is the bottleneck, not one claim loop.

## 3. Memory — no leak I could reach

API across the profile: 614 MB → 1620 MB → **618 MB twenty minutes later**,
back to baseline within 0.8%. 2000 WS subscribe/unsubscribe cycles (2000 acked,
2000 unacked, 0 errors): 618 → 654 MB, of which **+35 MB is the first 600
cycles and +0.9 MB the remaining 1400** — a plateau, not a slope. `judged`
54→67 MB over 200 grades, flat after ~120; `judge` 119→290 MB but *oscillating*
119–302 MB throughout — a per-grade compile+sandbox sawtooth, not growth.

## 4. DEFECT — the sweep was unbounded *and* unindexed (D78, migration 0029)

The module ruled its own DELETE cheap "against `rate_events_lookup_idx`'s
trailing `created_at` (and the sessions / one-time-token expiry columns)".
Both halves false: **a btree bounds a scan by a PREFIX and `created_at` is the
third column**, and the two expiry columns had **no index at all** — the
parenthetical asserts indexes never created. One DELETE of the 8.6M rows the
header itself predicts keeps no progress if interrupted. 0029 adds all three
indexes; `SWEEP_BATCH_SIZE` 10 000 batches via `ctid in (select … limit n)`.

One batch, 1,000,000-row fixture, ~4% sweepable:

| | plan | time | buffers |
| --- | --- | --- | --- |
| without 0029 | `Seq Scan on rate_events` | **56.5 ms** | **8 084** |
| with 0029 | `Index Scan … rate_events_created_at_idx` | **1.97 ms** | **135** |

29x time, 60x pages — per batch, of 860 per swept day.

**Red→green:** `git stash push` of only `expired-rows.sweeper.ts`, batch tests
→ `expected 5, received 3` (old code's one unbounded statement per table);
restored → 8/8 green. The two plan tests mutation-check themselves every run
(`admin-dashboard-plan.spec.ts`'s pattern): each DROPs its index inside the
rolled-back transaction and asserts `Seq Scan` on identical rows.

Three fixture traps that decide whether these tests can fail at all —
predicate selectivity, physical row order, and a `Date` in a raw `sql`
template throwing `ERR_INVALID_ARG_TYPE` at bind — are recorded in the spec's
own comments. The sibling spec's exact-count test still passes through the
batched path, so the counting contract is unchanged.

## 5. Redis — bounded, every key expires

Scanned **during** the hold (a 2 s TTL is gone by ramp-down): **0 keys without
a TTL**, 1.30 MB used / 1.47 MB peak, **98.3% hit rate** (3,009,521 / 51,487).
One write path, `SET … PX`; realtime is pub/sub and stores nothing. Recorded,
not fixed: `maxmemory 0` + `noeviction` (safe only *because* every key
expires), and transient `Stream isn't writeable` cache drop-outs under load —
three workers at k6 start, four more in a 300-VU hold. By design these cannot
fail a request (D25).

## 6. Postgres — no missing-index candidate at this scale

Heaviest seq scanners: `users` 208,881 scans / 25.7M tuples, `tags` 406,934 /
5.17M, `contest_participations` 187,841 / 4.51M. **None is a missing index** —
each table holds under forty rows here (`users` 36, `tags` 0), where a seq scan
is the *correct* plan; the counts are large because the requests were. B9's
lesson restated: a load test on fixture-scale data is structurally blind to the
province-scale index question. Both real index findings so far came from
seeding 200,000 rows, not from k6.

## Rulings (nobody to ask)

1. **D79 — `POST /submissions` stays unmetered.** The only costly write with no
   limiter, and it enqueues the most expensive work there is. A limit is a
   contract change (429 + `Retry-After`), a web change, and a product call
   about what a legitimate room does on the day a naive threshold must not
   break it. That is a feature brief; B12's scope is measurement. The 35.3/min
   is recorded as the number that should set the threshold.
2. **Three FULL indexes in 0029**, not partial: the predicates compare against a
   moving `now()`, so D47's partial-index trick cannot apply.
3. **The batch loop ends on a SHORT batch, not an empty one** — a table with
   nothing to sweep costs one statement, not two, per worker per hour.
4. This report is ~95 lines against conventions' 60: six measurement sections
   with their tables *are* the deliverable, and RESULTS.md holds the detail.

## Concerns

- **Left on the live stack**: 200 AC submissions on `tong-hai-so` and five
  `bh12-soak-*` accounts (P7 notes its leftovers the same way).
- The 2000-VU run **cannot be repeated** (one-run budget) and host load reached
  15 during its hold, k6 included. Trust the 500-VU table.
- The 1M-row plan spec takes ~11 s, adding to a suite B9 reported needing six
  attempts under host contention.
- `judged`'s +13 MB over 200 grades is a plateau *at this sample size*; a
  2000-grade soak would settle it.
