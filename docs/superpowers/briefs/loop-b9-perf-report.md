# B9 — performance regressions and the B-8 leftovers

Twelve commits on `worktree-agent-acfe1681736c0d630`; seven findings, each shown red before the fix and
mutation-checked after. Amendments to **D47** and **D49**, new **D64**; **D65 unspent** (it revises D49).

**1. The admin dashboard was linear in the whole grading history** (B-8 leftover, `2b0b83e`). At 200k
jobs/200k submissions: `queue()` seq-scanned (22.9 ms), `workers()` hash-joined both tables whole
(88.3 ms), `recentFailures()` walked **151,501 clean submissions** to find twenty — *slower the longer
judging stayed healthy* — every 15 s. **Migration 0025** adds D47's two named partial indexes (16 kB /
32 kB, sized by work in flight and by breakage, not history) plus two full ones: a time window bounds
rows *returned*, only an index bounds rows *scanned*. `grading_jobs(submission_id)` is also the missing
FK index under ON DELETE CASCADE. The plan spec **drops the indexes in its own rolled-back transaction**.

**2. Nine reads rendered a failure as an empty answer** (B-8 leftover, `08269ca`). `openapi-fetch`
resolves on HTTP errors, so `{ data } = await api.GET()` plus `?? []` told readers "you have no
notifications", "this school runs no contests", "you have not joined". `read()` throws an `ApiError`
keeping the status, except statuses a call site names as answers (401 on `/auth/me`, 404 on
`/contests/{key}/me`) — the distinction the swallow could not express. Four screens gained error
branches, including the contest page's Join button, offered by a failed read to somebody already
competing. Reverting it reds 9 of 17.

**3. The real regression, invisible to the load test** (`4e8c3a0`). `attemptedCount`/`solvedCount` were an
**uncached aggregate over every submission a problem ever had** — 200,000 index rows, **126 ms per
request** on the two most public routes, and a floor (no contests there, so D49's `NOT EXISTS` collapsed).
It survived four bug hunts by being correct at every scale and slow at one. Fixed by keying per problem,
answering D49's own objection — it rejected a per-page-*set* key, correctly. The first draft was itself an
N+1 (`479214c`), caught by `problem-me-verdict.spec.ts`; `throughMany` computes only the misses, together.

**4. `BOOKLET_TZ` → the reader's account zone** (D64, `b87f552`). D57 gave every account a timezone; the
booklet ignored it — not the organiser's, since contests carry no such column. The sharper bug: `(GMT+7)`
was a **literal** beside the formatter, a confidently wrong hour once the zone varied. Derived now, at
the contest's start, so a DST zone gives the offset the room sits under.

**5–7.** `route-fuzz.spec.ts` held raw NUL bytes (`9c7475d`) — git called it binary, so no review could see
a line; escaped, with `source-is-text.spec.ts` guarding the tree. `refetchInterval` is **not** a defect
(`49058bb`): 2000 seats is 67 req/s of Q&A feed + 33 of bell, and TanStack v5 already declines to poll a
hidden tab — but that is a *default* (flipping it turns 1 request into 11 over ten minutes hidden), so the
spec pins what the network sees. `219b05d` warms the lazy Redis socket the counter spec asserted against.

## Load — 500 VUs / 60 s, host load 3: 1097 req/s, 0 failed (`a136bd3`)

| `problem_stats` | `problem_detail` | `scoreboard` | `clarifications` | `problems_list` | `booklet` | `problems_filtered` | `tags_list` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **960 ms** | **952 ms** | 537 ms | 500 ms | 491 ms | 478 ms | 252 ms | 239 ms |

k6 drives all five new routes (booklet at 1%), each with its own threshold; setup resolves a real tag
rather than a slug that would answer 200 with an empty page. **All five are under the bar.** The two over
it are worker saturation, not slow routes — `problem_stats` answers from **Redis** and is still slowest,
and both are 5–6 ms unloaded; the lever is RESULTS.md's `API_WORKERS=8` + `max_connections`, needing a
redeploy. This also **corrects** that file's guess that the next lever is caching `problem_detail`'s
statement — it is 499 bytes of raw markdown, rendered nowhere.

## Concerns

- **The live stack runs the pre-fix build** (`b1e98fc`); migration 0025 is deliberately **not applied to
  production**, so every p95 above is pre-fix. Either deploy order is safe — the new code is correct
  against an un-migrated database, merely unindexed.
- **The ritual is green** — `apps/api` 764/764, `apps/web` 365/365, every package, contracts/SDK regen with
  no diff, `vite build` clean. It took six attempts: under contention it reds a *different* random 4–7
  specs each run, always container-start timeouts on specs this branch never touched, while another
  agent's testcontainer suite shares the box (load average peaked at **61** on 16 cores). Green only once
  load fell under ~18. My three new api specs add to that pressure; the 100k-row plan spec is ~19 s.
