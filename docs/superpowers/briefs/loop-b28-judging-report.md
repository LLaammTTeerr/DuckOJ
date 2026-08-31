# B28 — bug hunt: judging pipeline (2026-08-31)

Re-hunt since B-3: D100 counters, lease/fence, rejudge (D21), revoke (D81),
concurrency (D29), teams (D117). Read the conventions, B-3 report, 08-24 sweep
ledger, DECISIONS D21/29/40/68/80/81/94/100/105/117, apps/judged/src/**,
contest-stats.ts, the access services, judge-server reference. One real bug (two
symptoms) fixed with a testDbUrl regression + mutation; soak + matrix cleared
the rest.

## Fixed (repro → fix → mutation), commit 8cdb25d

1. **`recomputeContestProblemStats` never joined D100's own lock hierarchy —
   silent counter DRIFT (HIGH).** It rebuilt counters with an absolute
   `SET = excluded` upsert but read `submissions` on a plain snapshot and locked
   none of those rows, skipping the `submissions` step every incremental writer
   takes. A `judged` `writeTerminal` committing a verdict (and its own delta)
   between the snapshot and the upsert is discarded: `accepted`/`solvers` drift
   DOWN and cached `solvers` stops matching its set. Proven over two connections
   (final `1/1/1` vs truth `2/2/0`). Live doors: `?recompute=1` mid-contest and
   `rejudgeSubmission` recomputing a problem while another of its submissions is
   mid-grade. Fix: `SELECT … FOR UPDATE OF s` over the affected submissions
   first — a racing terminal write lands before the snapshot or waits and applies
   its delta on the recomputed base. Mutation: drop the lock → drift returns.
2. **Same call, second symptom — concurrent recompute 500s (MED).** The solvers
   INSERT had no `ON CONFLICT`, so two recomputes on one problem (organiser's
   `?recompute=1` during a whole-problem rejudge, or two organisers) raced to a
   PK violation on `contest_problem_solvers` — the repair button crashes exactly
   when needed. The FOR-UPDATE lock serialises them; `on conflict do nothing`
   added to match the incremental writer. Test: `apps/judged/test/
   contest-stats-races.spec.ts` (red: drift + PK violation; green after).

## Cleared, with evidence

- **Live verdict matrix** (throwaway `bh28-*`, contest `thu-nghiem-1`): AC · WA ·
  TLE · RTE · CE all exact; **MLE→RTE** and **OLE→WA** as B-3 documented
  (over-limit dies first; checker rejects oversized output before OLE). Bitmask
  precedence in `verdict.ts` matches judge-server `result.py` bit-for-bit.
- **Counter consistency: zero drift** pre- and post-soak — `contest_problem_
  stats` vs ground-truth aggregate = **0 drifted rows / 98**; watched `38/26/17/0`.
- **D80 rate limit fires live** — burst 1/10s: 2nd/3rd rapid submits → 429.
- **Disconnect/revoke mid-grade (D81/D29)** → `retire`→`abandon`→`release`,
  prompt requeue (no 60s stall); fence makes a lease-lapse re-grade net-zero on
  counters. **Teams (D117)** count once; **post-window/DQ** submits 403 before
  any counter write; DQ'd activity counted by ruling ("a monitor, not a board").

## Soak numbers

5 `bh28-*` registrations (≤6). 51 submit attempts (3 burst + 48 round-robin, 4
users, ~2.4s gap): **25 created, 26 rate-limited (429)** by D80. Verdicts
AC13/WA4/TLE3/CE3/RTE2, all drained terminal; latency created→judged avg
**1.46s**, max **6.10s**. No container stopped/rebuilt.

## Concerns

- My FOR-UPDATE widens the lock scope of the rare `noteContestVerdict`
  `acceptedDelta<0` branch (non-deterministic AC→WA re-grade): two on one problem
  at once can deadlock — Postgres aborts one, the lease re-grades, no corruption.
  Lock order `submissions→solvers→stats` preserved.
- Full `-r test`/web skipped (contract-neutral SQL edit + one judged spec): ran
  typecheck -r, lint(db+judged), db49/judged130/api-rejudge+monitor31 green.
