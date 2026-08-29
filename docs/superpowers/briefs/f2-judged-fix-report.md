# F2 — B2: a cancel must not terminate another student's grade
**Status: DONE.**

## Shipped
1. **The connection is the unit of grading.** `DmojDriver` keeps a `connection id -> {submissionId,
   sent}` map, maintained from both ends: what we wrote, and what every reply packet's `submission-id`
   confirms. `BridgeServer` gains `sendTo(id, packet)` (false when that judge is gone) and
   `connectionIds()`; `onPacket`'s connection argument, previously dropped, is now the whole point.
2. **`cancel` is addressed, never broadcast.** `terminate-submission` goes to the one connection
   provably running that submission, and only once the request was actually written (`sent`). Anything
   else — a job parked behind a busy judge, a job whose judge vanished, a job already finished
   — sends nothing, logs `cancel for a submission no judge is running`, and emits **no** `terminated`
   event (that writes a permanent `errored`/`IE`; a submission no judge touched must not get one). The
   orphan path (`current-submission-id`) is targeted too: it used to broadcast, killing every *other*
   judge's live grade to clean up one.
3. **One submission per connection, enforced twice.** `dispatch` parks until a connection is idle
   rather than sending a second `submission-request` to a busy judge, and *rejects* if cancelled while
   parked (resolving quietly would hang `Worker`'s wrapper promise forever). Above it, `Worker` reserves
   a judge slot via the new optional `JudgeDriver.tryAcquireSlot()` **before** it claims, releasing in a
   `finally` — so a claimed job is always immediately runnable and never sits
   leased-but-unrunnable until its watchdog fires. `DmojDriver` also exposes `idleCapacity()`. A judge
   redialling under the same `judge_nodes` name clears its stale assignment at handshake, or the fresh
   connection reads busy forever — with one judge, a permanent deadlock.
4. **`JUDGED_CONCURRENCY` ships 1** (`config.ts`, `docker-compose.yml`, `.env.example`; ruling 1). **D28**
   records it; runbook "Judging throughput" rewritten with the two operator-visible consequences and a
   grep for the new log line.

**Files:** `apps/judged/src/drivers/dmoj/{dmoj-driver,bridge-server}.ts`, `apps/judged/src/{worker,config}.ts`,
`packages/judge-protocol/src/contract.ts`, `apps/judged/test/{judge-affinity,worker-pool,dmoj-driver,config}.spec.ts`,
`docker-compose.yml`, `.env.example`, `docs/DECISIONS.md`, `docs/runbook.md`.

## Tests — red first, then four mutation checks
New `test/judge-affinity.spec.ts` (7 tests) over the real wire protocol in the `batch-points.spec.ts`
shape — real `BridgeServer`, real sockets, real packets — plus a pool test in `worker-pool.spec.ts`.
**Red first: 7 failed / 3 passed** against the broken code; now 79/79 in judged (was 71). Mutations, each
applied then restored: `cancel` back to `broadcast` → 2 red (B2 + two-judge targeting); dispatch takes
`connectionIds()[0]`, ignoring busyness → 4 red; `Worker` skips `tryAcquireSlot` → 1 red; orphan terminate
back to `broadcast` → 1 red. The B2 test is the scenario verbatim: B takes the one connection, A queues
behind it, A's watchdog cancels — the judge receives **zero** terminates, A's dispatch rejects, A emits no
`terminated`, B grades on to its own verdict.
**Gate:** `pnpm -r typecheck`, `typecheck:scripts`, `pnpm -r lint`, `lint:scripts`, `pnpm -r test` (1142
tests, 0 failures — api 546, web 203, judged 79), contracts + SDK regen with **no diff**, `vite build`.

## Rulings (nobody to ask)
1. **Ship 1, not 2.** The fix makes 2 provably safe — and provably *inert*: with one judge the second
   loop never wins a slot, so it polls every 500 ms and claims nothing. No honest "why" for 2 — one loop
   per judge, rising with the fleet, as the runbook already prescribed and the repo had not.
2. **One-submission-per-connection is a ruling, not a confirmed fact** — argued in D28 from the protocol
   (a single `current-submission-id`, an id-less terminate). **`tryAcquireSlot` is optional**, so `FakeDriver`
   and every test double are untouched; `capabilities().concurrency` is now `bridge.judgeCount()`.
3. **Fast-forwarded the worktree branch to `main`** (2 commits, clean ff) — `final-review.md` was not in the
   branch. Committed on the worktree branch per the dispatch. **D28 skips D26–D27** (DECISIONS.md ends at D25).

## Concerns
- **`live` is still keyed by job id, not `(job, attempt)`.** Terminating attempt N on its own connection
  and withholding it until the judge answers narrows the window hard, but remains an argument from timing.
- **With no judge connected, nothing is claimed at all** — submissions stay `queued` instead of being
  claimed and timing out into IE. Better, but operator-visible; the runbook says what to check.
- **Nothing ran against a real judge-server.** Every test uses a fake judge on the real wire format; the
  one-per-connection ruling is unobserved under load. The live stack was untouched throughout.
