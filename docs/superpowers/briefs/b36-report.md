# B-36 report — `live` keyed by job id, and the packets that landed in the wrong attempt

**Status: DONE**, after two rounds of adversarial-review fixes. The defect is
fixed and pinned by nine specs, every one of them watched red before it was
watched green. `@duckoj/judged` is 19/19 files and **159/159** tests green; the
measured baseline on unmodified code is 150/150, so the delta is exactly the
nine specs added here.

Round 0 is the body of this report, and both later rounds found that the
previous one had stopped short of the real defect. **Round 1**: the routing
guard was not enough, because `finish` still deleted from `live` by job id, so
a superseded attempt's queued terminal packet evicted its successor's live
entry. **Round 2**: the assignment outlives the entry, so a terminal packet
arriving after the successor had already finished stranded its connection
forever — and round 1's own `UNKNOWN_ATTEMPT` had no exit at all once that
happened. Read
"Fix round 1" and "Fix round 2" below before the "Found and did not fix" list;
each supersedes what the section above it claimed.

Branch: `b36-dmoj-driver`, off `a7ac08e` (the brief commit).

## What was wrong

DMOJ's `submission-id` carries our grading **job** id, not our submission id,
and a retry reuses that id with a higher `attempt`. `DmojDriver.live` is a
`Map<number, LiveJob>` keyed by that id alone, so it holds at most one entry
per job — attempt N+1's — while attempt N is still speaking from the connection
it was terminated on.

`handle()` routed every reply packet by `live.get(packet['submission-id'])`,
and the guard that looked like it covered this did not:

```ts
const held = this.assignments.get(connection.id);
if (!held || held.submissionId === submissionId) {
  this.assignments.set(connection.id, { submissionId, sent: true });
  entry.connection = connection.id;
}
```

`held.submissionId === submissionId` is true of the connection running attempt
N *and* of the one running attempt N+1, because they are running the same job
id. So a stale packet reassigned `entry.connection` back to the old socket and
was queued onto the successor's translation chain.

## What changed

`apps/judged/src/drivers/dmoj/dmoj-driver.ts`:

1. **`Assignment` gains `attempt: number`**, recorded on every path that
   creates one: `acquireConnection`, the wire-confirmation branch in
   `handle()`, and the `current-submission-id` adoption path.
2. **`handle()` discards a packet whose connection is running a different
   attempt than the live entry**, logging it once as
   `{ msg: 'packet from a superseded attempt discarded', jobId, packetAttempt,
   liveAttempt, connection }`, and does **not** reassign `entry.connection` —
   the live attempt is somewhere else.
3. **A discarded TERMINAL packet still releases the connection.** This is an
   addition beyond the brief's literal recipe, and without it the fix trades a
   wrong verdict for a silent hang: the packet `cancel` waits for is the
   judge's `submission-terminated`, whose whole job is to hand the socket back.
   Swallowing it as "not attempt N+1's" leaves that judge marked busy forever,
   and on the one-judge fleet this repo ships the retry — already parked in
   `acquireConnection` — is never woken at all. Run 3 below is that hang,
   measured. The set is `grading-end`, `submission-terminated`,
   `compile-error`, `internal-error` — exactly the names for which `translate`
   calls `finish` — hoisted into a `TERMINAL_PACKETS` constant next to it so
   the two cannot drift apart silently.
4. **`releaseConnection` takes the attempt and fences on it**, for the same
   reason it was already submission-fenced: with a retry reusing the id, "still
   holds submission S" is true of both connections. The `entry.connection =
   undefined` line inside it is fenced too, or releasing the superseded
   attempt's socket would unpin the *live* attempt from its own and tell
   `cancel` there is nothing to terminate.
5. **`onJudgeGone` is fenced the same way.** A judge that dies holding a
   superseded attempt of job S must not retire and abandon the successor
   running on a different machine.
6. **`cancel` requires the connection to hold this attempt**, not merely this
   job id, before it fires an id-less `terminate-submission` at it.
7. **`current-submission-id` keeps its orphan behaviour** — terminate when no
   live entry exists — and now adopts a connection only when the driver has no
   better claim on it (the live entry is not already placed elsewhere, and this
   connection is not already recorded against a grade). A comment states why an
   attempt cannot be recovered there: the packet is `{ name, submission-id }`
   and nothing else, because judge-server has no notion of our attempt counter.
   When it does adopt, it also pins `entry.connection`, so a `cancel` arriving
   straight after an adoption reaches the right socket instead of retiring the
   job locally and leaving the judge grading forever.
8. **The block comment above `dispatch`** no longer claims the structural fix
   is outstanding; it now records that D205 closed it, and why the map keeps
   its key.

`apps/judged/test/multi-judge.spec.ts`: `makeJob` takes an optional `attempt`,
and a nested `describe('a retry that reuses the job id')` adds four specs on
the existing harness. Three use two judges, because two connections are what
makes the race expressible at all — attempt N on judge-1, attempt N+1 on
judge-2, and a packet arriving on the wrong one. The fourth deliberately uses a
fleet of **one**, which is the topology this repository ships and the only one
in which item 3 is load bearing rather than tidy.

`docs/DECISIONS.md`: **D205**, plus an edit to D29's "Left open" paragraph
naming D205 as what closed it.

The rejected alternative — keying `live` by `${jobId}:${attempt}` — is recorded
in D205: `cancel` and the `current-submission-id` orphan check both look a job
up by bare id with no attempt in hand, so a composite key forces both to scan
or to invent an attempt they do not have.

## Red first

The red runs below were taken before the host's rootless podman socket came
back up, but `multi-judge.spec.ts` needs no database and so was never touched
by that: every failure quoted here is an assertion or a timeout, not an
infrastructure error.

### Run 1 — the two-judge specs against the unmodified driver

`nice -n 19 corepack pnpm --filter @duckoj/judged exec vitest run --no-file-parallelism test/multi-judge.spec.ts`

```
   × a fleet of two judges > a retry that reuses the job id > drops attempt 1's grading-end instead of finalising attempt 2 with it 524ms
     → expected [ 'dispatched', 'finished' ] to deeply equal [ 'dispatched' ]
   × a fleet of two judges > a retry that reuses the job id > drops attempt 1's test-case-status instead of moving attempt 2's counters 517ms
     → expected [ { type: 'caseResult', …(10) } ] to have a length of +0 but got 1
   × a fleet of two judges > a retry that reuses the job id > frees the connection a dropped TERMINAL packet arrived on 513ms
     → expected [ 'dispatched', 'terminated' ] to deeply equal [ 'dispatched' ]

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > drops attempt 1's grading-end instead of finalising attempt 2 with it
AssertionError: expected [ 'dispatched', 'finished' ] to deeply equal [ 'dispatched' ]

- Expected
+ Received

  Array [
    "dispatched",
+   "finished",
  ]

 ❯ test/multi-judge.spec.ts:352:45
    350|       // Attempt 2 is still compiling. A verdict here would be compute…
    351|       // the PREVIOUS run's cases and written to the submission as fin…
    352|       expect(attemptTwo.map((e) => e.type)).toEqual(['dispatched']);
       |                                             ^
    353|     }, 30_000);
    354| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > drops attempt 1's test-case-status instead of moving attempt 2's counters
AssertionError: expected [ { type: 'caseResult', …(10) } ] to have a length of +0 but got 1

- Expected
+ Received

- 0
+ 1

 ❯ test/multi-judge.spec.ts:381:65
    379|       });
    380|       await settle();
    381|       expect(attemptTwo.filter((e) => e.type === 'caseResult')).toHave…
       |                                                                 ^
    382| 
    383|       // Attempt 2's own, only, case: one point out of one.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > frees the connection a dropped TERMINAL packet arrived on
AssertionError: expected [ 'dispatched', 'terminated' ] to deeply equal [ 'dispatched' ]

- Expected
+ Received

  Array [
    "dispatched",
+   "terminated",
  ]

 ❯ test/multi-judge.spec.ts:429:45
    427|       first.send({ name: 'submission-terminated', 'submission-id': 7 }…
    428|       await settle();
    429|       expect(attemptTwo.map((e) => e.type)).toEqual(['dispatched']);
       |                                             ^
    430| 
    431|       // Attempt 2 runs to its own end, freeing judge-2 as well.

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯

 Test Files  1 failed (1)
      Tests  3 failed | 8 passed (11)
```

The first two are the brief's two required reds, verbatim: attempt 1's
`grading-end` finalised attempt 2 while it was still compiling, and attempt 1's
`test-case-status` moved attempt 2's counters.

### Run 2 — the one-judge spec against the unmodified driver

```
 FAIL  test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > wakes the parked retry when the superseded attempt frees the only judge
AssertionError: expected [ 'terminated', 'dispatched' ] to deeply equal [ 'dispatched' ]

- Expected
+ Received

  Array [
+   "terminated",
    "dispatched",
  ]

 ❯ test/multi-judge.spec.ts:476:45
    474|       // Exactly one event, and it is the retry's own start — not a
    475|       // `terminated` for a run that had not started when it was writt…
    476|       expect(attemptTwo.map((e) => e.type)).toEqual(['dispatched']);
       |                                             ^
    477|     }, 30_000);
    478|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/4]⎯

 Test Files  1 failed (1)
      Tests  4 failed | 8 passed (12)
```

`['terminated', 'dispatched']` is the defect at its ugliest: the retry was told
its predecessor's run had ended **before it had started**, and the ordering
guarantee that `dispatched` comes first is broken along with the verdict.

### Run 3 — the two release-dependent specs against the fix *without* the release

The attempt fence alone is not the whole fix, and this run is why. Item 3
above was removed (`TERMINAL_PACKETS.has(packet.name)` forced false) with
everything else in place. The two two-judge translation specs pass; the two
that are about the connection do not.

```
 ❯ test/multi-judge.spec.ts (12 tests | 2 failed) 44213ms
   ✓ a fleet of two judges > a retry that reuses the job id > drops attempt 1's grading-end instead of finalising attempt 2 with it 512ms
   ✓ a fleet of two judges > a retry that reuses the job id > drops attempt 1's test-case-status instead of moving attempt 2's counters 558ms
   × a fleet of two judges > a retry that reuses the job id > frees the connection a dropped TERMINAL packet arrived on 10568ms
     → expected [ Array(1) ] to have a length of 2 but got 1
   × a fleet of two judges > a retry that reuses the job id > wakes the parked retry when the superseded attempt frees the only judge 30056ms
     → Test timed out in 30000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > frees the connection a dropped TERMINAL packet arrived on
AssertionError: expected [ Array(1) ] to have a length of 2 but got 1

- Expected
+ Received

- 2
+ 1

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > wakes the parked retry when the superseded attempt frees the only judge
Error: Test timed out in 30000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed | 10 passed (12)
```

Two judges: judge-1 stayed marked busy with the grade it had already been told
to terminate, so the next job went to judge-2 instead. **One judge: the retry
never returns at all** — `await retry` hits the 30-second test timeout, and in
production that is a dispatch parked in `acquireConnection` with nothing left
that can ever wake it. That is a strictly worse failure than the wrong verdict
it replaced, which is why the release branch is not optional.

## Green

The three commands the brief requires, run on the finished branch.

### `corepack pnpm --filter @duckoj/judged typecheck` — exit 0

```
> @duckoj/judged@0.0.0 typecheck /home/lamter/Projects/duckoj/.claude/worktrees/agent-af3f311f83f2668d6/apps/judged
> tsc -b && tsc --noEmit -p tsconfig.test.json
```

### `corepack pnpm --filter @duckoj/judged lint` — exit 0

```
> @duckoj/judged@0.0.0 lint /home/lamter/Projects/duckoj/.claude/worktrees/agent-af3f311f83f2668d6/apps/judged
> eslint src test
```

### `nice -n 19 corepack pnpm --filter @duckoj/judged exec vitest run --no-file-parallelism` — exit 0

```
 ✓ test/dmoj-driver.spec.ts (21 tests) 2947ms
 ✓ test/event-writer.spec.ts (17 tests) 4463ms
 ✓ test/worker.spec.ts (9 tests) 10448ms
 ✓ test/bridge-auth.spec.ts (15 tests) 2406ms
 ✓ test/multi-judge.spec.ts (12 tests) 4393ms
 ✓ test/job-language-routing.spec.ts (16 tests) 4588ms
 ✓ test/contest-problem-stats.spec.ts (5 tests) 4143ms
 ✓ test/contest-stats-races.spec.ts (2 tests) 4828ms
 ✓ test/language-mapping.spec.ts (6 tests) 339ms
 ✓ test/judge-disconnect.spec.ts (2 tests) 4600ms
 ✓ test/judge-affinity.spec.ts (7 tests) 2613ms
 ✓ test/worker-language.spec.ts (8 tests) 9549ms
 ✓ test/batch-points.spec.ts (5 tests) 790ms
 ✓ test/job-store.spec.ts (11 tests) 4131ms
 ✓ test/worker-pool.spec.ts (3 tests) 1044ms
 ✓ test/pipeline-robustness.spec.ts (4 tests) 4027ms
 ✓ test/job-store.concurrency.spec.ts (2 tests) 3636ms
 ✓ test/agent-client.spec.ts (3 tests) 29ms
 ✓ test/config.spec.ts (6 tests) 9ms

 Test Files  19 passed (19)
      Tests  154 passed (154)
   Start at  17:34:29
   Duration  83.76s (transform 389ms, setup 0ms, collect 9.08s, tests 68.98s, environment 5ms, prepare 1.17s)
```

Nine of those files need a Postgres testcontainer through `test/db.harness.ts`,
so the suite was run with the rootless podman socket the controller started:

```
DOCKER_HOST="unix:///run/user/1000/podman/podman.sock" TESTCONTAINERS_RYUK_DISABLED=true
```

`judge-disconnect.spec.ts` is in that set and is the only container-gated file
covering code this change touched (`onJudgeGone`, now attempt-fenced). It
passes.

### The baseline was measured, not assumed

With `dmoj-driver.ts` and `multi-judge.spec.ts` checked out at `a7ac08e` and
the same command and environment:

```
 Test Files  19 passed (19)
      Tests  150 passed (150)
```

150 → 154, the delta being exactly the four specs added here, and no
pre-existing test changed state.

## Fix round 1 — five findings from adversarial review

All five are addressed. Three were behaviour changes and each got a spec,
red against `81b1245` (the end of round 0) before the fix. `@duckoj/judged` is
now 19/19 files and **157/157** tests green.

### F1 (blocking) — `finish` deleted from `live` by job id, evicting the successor

**Real, and worse than the routing defect round 0 fixed.** Confirmed against
`apps/judged/src/worker.ts`: `heartbeatOnce` cancels only *after* an awaited
`jobs.heartbeat` tells it the lease was already claimed away, so the successor
is dispatched **before** the predecessor is cancelled. In that window attempt
1's packets are the live entry's own — they pass every guard legitimately —
and are queued onto its `queue` behind an `emit` per test case. When the queue
drained, `live[7]` was attempt 2's entry and `finish(E1)` deleted it by id.
Everything after that hit `if (!entry) return`: attempt 2 never received a
terminal event and its judge was never handed back.

Fixed with `retire(entry, submissionId)` — `if (this.live.get(id) === entry)
this.live.delete(id)`. Applied to `finish` and, on the advisor's prompt, to
**both `dispatch` catch paths**, which had the same bug for a different
reason: a dispatch parked long enough to be superseded (woken into
`NoCapableJudgeError`, or failing its `sendTo`) deleted by id on the way out.
`onJudgeGone` goes through `retire` too — identity is trivially true there,
but every removal from `live` in the file now reads the same way and none can
drift back.

`releaseConnection`'s `live.get` was checked and deliberately **not** changed:
it matches on attempt *and* connection together, and two entry objects for one
`(job, attempt)` cannot coexist — `JobStore.claim` bumps the attempt on every
claim, and the one path that builds an entry it then discards retires its own
before rethrowing. That argument is now in the code comment.

### F5 — an unassigned connection could take over an entry placed elsewhere

**Reachable, and the reviewer was right to flag it.** The round-0 guard asked
"does this connection's assignment name a different attempt", which says
nothing when the connection has no assignment — and the release-on-terminal
branch *creates* that state. So the second stale packet on a just-released
connection fell through to the wire-authority branch and repointed the live
entry at the wrong socket. A judge that answers our terminate after it had
already finished sends exactly that pair (`grading-end`, then
`submission-terminated`).

The rule is now one sentence, written as an unconditional disjunction rather
than a branch on "assigned?" — the branching form would let a connection whose
attempt happens to match steal an entry already placed elsewhere:

```ts
const foreign =
  (held !== undefined && held.attempt !== entry.job.attempt) ||
  (entry.connection !== undefined && entry.connection !== connection.id);
```

The reconnect path still adopts, because a redial's `retire`/handshake clears
both the assignment and `entry.connection`.

### F2 — the early return left a genuinely busy judge in the free pool

Accepted in full: round 0 was right about the attempt and wrong about
everything else. The judge had just said it was grading, and an unassigned
connection is one the next dispatch writes a second `submission-request` to —
the hazard D29 exists to prevent, reintroduced by a fix for D29's residual.

It is now recorded busy either way, and only the attempt differs:
`claimed.job.attempt` when nothing contradicts the announcement (the
reconnect-recovery path), and `UNKNOWN_ATTEMPT = -1` when the live entry is
placed on another connection. Negative on purpose — attempts start at 1 and
only rise — so the connection is out of the free pool, every packet on it is
discarded as unattributable, and a terminal packet still releases it because
the sentinel equals itself. The log reports `packetAttempt: null` for it
rather than `-1`: "genuinely unknown" is not the claim "attempt minus one".

D205 names both costs: a judge that announces and then falls silent holds its
slot until the socket dies, and the redial ordering (`retire` frees the
assignment *before* the announcement arrives, so a dispatch parked at that
instant can take the connection in between) is D29's window and is **not**
closed here.

### F3 — releasing on all four terminal names

**Kept all four, with the argument written into the code and D205.** Three
parts. First, it is not new behaviour: before the discard guard existed all
four of these names reached `translate` and called `finish`, which released the
connection — so the hazard is D29's residual and has been reachable since B2
with *no retry involved at all*, a cancel's terminate crossing the `grading-end`
of a job that is simply finishing. Narrowing the set would not remove that; it
would add a second failure whose shape is a connection marked busy with a grade
nobody is listening for, which on the shipped one-judge fleet stops the queue.
Second, the ordering does not admit the race: the terminate and the successor's
`submission-request` go to the **same socket**, and judge-server reads one
stream in order, so the terminate is processed first. Third, what is genuinely
unverifiable is named rather than guessed at — judge-server's behaviour when a
terminate arrives while it is idle. Nothing is vendored to check it against; a
latching implementation would already bite the no-retry path, so it is recorded
as an open protocol question, not a cost of this decision.

### F4 — "D205 closed it" overclaimed

Corrected in the comment above `dispatch` and in D29's paragraph. The bounded
claim: closed for every connection whose assignment the driver built from its
own dispatch, which is every connection in the normal flow; **inferred, and
stated as an inference**, for a judge that redials, because
`current-submission-id` names a job id and no attempt.

### Red, then green

Three new specs, red against `81b1245`:

```
   × ... > does not let attempt 1's queued finish evict attempt 2's live entry 10271ms
   × ... > does not let an unassigned connection take over an entry placed elsewhere 815ms
   × ... > keeps a redialling judge busy when its announcement cannot be attributed 870ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/multi-judge.spec.ts > ... > does not let attempt 1's queued finish evict attempt 2's live entry
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ test/multi-judge.spec.ts:575:69
    573|       second.send({ name: 'grading-end', 'submission-id': 7 });
    574|       await vi.waitFor(
    575|         () => expect(attemptTwo.some((e) => e.type === 'finished')).to…
       |                                                                     ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/3]⎯

 FAIL  test/multi-judge.spec.ts > ... > does not let an unassigned connection take over an entry placed elsewhere
AssertionError: expected [ 'dispatched', 'terminated' ] to deeply equal [ 'dispatched' ]

- Expected
+ Received

  Array [
    "dispatched",
+   "terminated",
  ]

 ❯ test/multi-judge.spec.ts:609:45

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/3]⎯

 FAIL  test/multi-judge.spec.ts > ... > keeps a redialling judge busy when its announcement cannot be attributed
AssertionError: expected [ Array(1) ] to have a length of +0 but got 1

- Expected
+ Received

- 0
+ 1

 ❯ test/multi-judge.spec.ts:656:36
    654|       await settle();
    655| 
    656|       expect(redialled.requests()).toHaveLength(0);
       |                                    ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/3]⎯

 Test Files  1 failed (1)
      Tests  3 failed | 12 passed (15)
```

Each failure is the predicted one: attempt 2 never finished (its entry was
evicted), attempt 2 was handed a spurious `terminated` (the unassigned
connection stole it), and the redialled judge was written a second
`submission-request` while grading.

The F1 spec needed a new `sendBatch` on the two-judge `fakeJudge` — the
`test-case-status` and `grading-end` must be decoded in **one** synchronous
`handle` pass, or the second arrives after the entry under that job id has
already been replaced and the discard guard sees it, which is the *other*
ordering the round-0 specs already cover.

Green, after the fix — typecheck exit 0, lint exit 0, and:

```
 ✓ test/dmoj-driver.spec.ts (21 tests) 3002ms
 ✓ test/multi-judge.spec.ts (15 tests) 6540ms
 ✓ test/event-writer.spec.ts (17 tests) 3996ms
 ✓ test/worker.spec.ts (9 tests) 9752ms
 ✓ test/bridge-auth.spec.ts (15 tests) 2535ms
 ✓ test/job-language-routing.spec.ts (16 tests) 4346ms
 ✓ test/contest-problem-stats.spec.ts (5 tests) 3713ms
 ✓ test/contest-stats-races.spec.ts (2 tests) 4588ms
 ✓ test/language-mapping.spec.ts (6 tests) 343ms
 ✓ test/judge-disconnect.spec.ts (2 tests) 5181ms
 ✓ test/judge-affinity.spec.ts (7 tests) 2642ms
 ✓ test/worker-language.spec.ts (8 tests) 9564ms
 ✓ test/batch-points.spec.ts (5 tests) 807ms
 ✓ test/job-store.spec.ts (11 tests) 4214ms
 ✓ test/worker-pool.spec.ts (3 tests) 1045ms
 ✓ test/pipeline-robustness.spec.ts (4 tests) 4023ms
 ✓ test/job-store.concurrency.spec.ts (2 tests) 3639ms
 ✓ test/agent-client.spec.ts (3 tests) 29ms
 ✓ test/config.spec.ts (6 tests) 9ms

 Test Files  19 passed (19)
      Tests  157 passed (157)
   Start at  17:57:31
   Duration  83.27s (transform 347ms, setup 0ms, collect 8.20s, tests 69.97s, environment 4ms, prepare 1.03s)
```

Only `apps/judged/src` and `apps/judged/test` were touched — no `scripts/`, no
`Dockerfile`, no workspace `package.json`, and no new workspace dependency — so
the repo-wide guards in `apps/api/test` are outside this diff's blast radius.

## Fix round 2 — the assignment outlives the entry

Re-review confirmed F1, F3, F4 and F5 as addressed and found one more leak.
Both items are fixed. `@duckoj/judged` is now 19/19 files and **159/159** green.

### R2-1 — a terminal packet for an already-retired job stranded its connection

**Real, both orderings.** `handle` read `live.get(submissionId)` and returned
on a miss *before* it ever looked at the assignment, so nothing handed the
connection back.

What hid it is that both orderings need a fleet of **two**, and need the
successor to finish **first**: its `grading-end` retires `live[jobId]`, and only
then does the superseded attempt's judge answer. A single judge cannot produce
that, because it is the one running both — so every spec written for this
decision so far, all of them built around a superseded attempt still
outstanding, walked straight past it.

- **(a), pre-existing.** judge-1 is still owed a `submission-terminated`,
  judge-2 finishes the retry, judge-1 answers. judge-1's assignment stays for
  the life of the process. This predates attempts entirely.
- **(b), introduced by round 1.** Once the entry is gone an
  `UNKNOWN_ATTEMPT` assignment has **no exit left at all**: `finish` cannot
  release it, because the connection holding it is not any live entry's
  `connection`, and the discard branch — its only other exit, and the one that
  covers the case where the entry still exists — never runs. Round 1's "never
  leave a busy judge idle" had bought itself a judge that was never idle
  again.

The cost is this decision's own hang class from a third direction: a leaked
assignment is invisible to `bridge.judgeCount()`, so `capabilities()` and
`tryAcquireSlot` keep counting and handing out slots for a judge
`acquireConnection` will never choose, and a worker takes one, claims a job and
parks holding the lease.

**Took the reviewer's fix shape** rather than beating it — hoist the assignment
lookup above the miss, and release when the packet is terminal and the held
assignment names that job:

```ts
const held = this.assignments.get(connection.id);
const entry = this.live.get(submissionId);

if (!entry) {
  if (held?.submissionId === submissionId && TERMINAL_PACKETS.has(packet.name)) {
    /* log */
    this.releaseConnection(connection.id, submissionId, held.attempt);
  }
  return;
}
```

`held.attempt` is passed through, so `releaseConnection`'s `(submissionId,
attempt)` match is exact by construction. It is logged under its own message
rather than folded into the discard log, because a connection that outlived its
job's live entry is an anomaly worth seeing even when it is handled. And the
release is safe for exactly the reason the reviewer gave: with no live entry
there is nothing to attribute the packet to, so there is nothing to
misattribute it to.

**Two specs, not the suggested extension of the F2 spec — and here is why.** In
the F2 spec the un-awaited `dispatch(99)` is still parked when judge-2's
`grading-end` runs `finish → releaseConnection → wake()`, so it takes judge-2
the instant it frees. Asserting "99 lands on judge-1" would then fail *green*.
Separate specs sidestep the parked promise entirely, and (a) and (b) exercise
different assignment shapes — a real attempt and the sentinel — which is worth
two tests anyway.

Both assert on a count that does not depend on `connectionIds()` iteration
order: with the fix, two free judges take two dispatched jobs one each, in
whichever order they are handed out; with the leak, only one judge is free and
the second dispatch parks.

### R2-2 — D205 asserted a safety property the code did not have

Correct, and the honest reading is that it was false in all three places until
R2-1 landed. Fixed **after** the code, so each now describes what is there: the
`UNKNOWN_ATTEMPT` doc comment, the `current-submission-id` branch comment, and
D205 itself all name the two branches of `handle` that release the sentinel —
the discard branch while a live entry for the job id survives, and the `!entry`
branch once the successor has retired it — and the doc comment says plainly
that neither may be removed without stranding it.

D205 also gained the safety argument it had been missing beside its cost
paragraph: a connection carrying the sentinel has exactly two exits and no way
to be misread — every non-terminal packet on it is foreign by construction,
every terminal packet releases it — so **its failure mode is latency, never
misattribution**, which is the right way round because a stalled slot shows up
in the queue depth and a corrupted grade does not.

### Red, then green

Two new specs, red against `c1f3c8d`:

```
   × ... > frees a connection whose terminal packet arrives after the job is already retired 877ms
   × ... > releases the redialling judge's unattributable assignment when its run finally ends 1219ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/multi-judge.spec.ts > ... > frees a connection whose terminal packet arrives after the job is already retired
AssertionError: expected [ Array(1) ] to have a length of 2 but got 1

- Expected
+ Received

- 2
+ 1

 ❯ test/multi-judge.spec.ts:700:32
    698|       await settle();
    699| 
    700|       expect(first.requests()).toHaveLength(2);
       |                                ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  test/multi-judge.spec.ts > ... > releases the redialling judge's unattributable assignment when its run finally ends
AssertionError: expected [] to have a length of 1 but got +0

- Expected
+ Received

- 1
+ 0

 ❯ test/multi-judge.spec.ts:747:36
    745|       await settle();
    746| 
    747|       expect(redialled.requests()).toHaveLength(1);
       |                                    ^

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed | 15 passed (17)
```

Each is the leak: the second dispatch never reached the judge whose assignment
was stranded. Green after the fix — typecheck exit 0, lint exit 0, and:

```
 ✓ test/multi-judge.spec.ts (17 tests) 8626ms
 ✓ test/dmoj-driver.spec.ts (21 tests) 3003ms
 ✓ test/event-writer.spec.ts (17 tests) 4737ms
 ✓ test/worker.spec.ts (9 tests) 9858ms
 ✓ test/bridge-auth.spec.ts (15 tests) 2487ms
 ✓ test/job-language-routing.spec.ts (16 tests) 4027ms
 ✓ test/contest-problem-stats.spec.ts (5 tests) 3968ms
 ✓ test/contest-stats-races.spec.ts (2 tests) 4582ms
 ✓ test/language-mapping.spec.ts (6 tests) 342ms
 ✓ test/judge-disconnect.spec.ts (2 tests) 5019ms
 ✓ test/judge-affinity.spec.ts (7 tests) 2644ms
 ✓ test/worker-language.spec.ts (8 tests) 9565ms
 ✓ test/batch-points.spec.ts (5 tests) 802ms
 ✓ test/job-store.spec.ts (11 tests) 4263ms
 ✓ test/worker-pool.spec.ts (3 tests) 1043ms
 ✓ test/pipeline-robustness.spec.ts (4 tests) 3920ms
 ✓ test/job-store.concurrency.spec.ts (2 tests) 3373ms
 ✓ test/agent-client.spec.ts (3 tests) 28ms
 ✓ test/config.spec.ts (6 tests) 8ms

 Test Files  19 passed (19)
      Tests  159 passed (159)
   Start at  18:15:01
   Duration  85.41s (transform 347ms, setup 0ms, collect 8.06s, tests 72.29s, environment 4ms, prepare 1.03s)
```

## Found and did not fix

- **The discard guard is `held.attempt !== entry.job.attempt`, without also
  requiring `held.submissionId === submissionId`.** This is what the brief
  specifies and it is the right shape for the defect, but it means a packet for
  job A arriving on a connection the driver believes is running job B at a
  different attempt number is dropped rather than translated. That state is
  unreachable in normal flow — a judge redialling clears its own assignment at
  handshake, which is the only path that legitimately delivers a packet for a
  job the connection is not recorded against, and it leaves `held` undefined so
  the guard does not fire. Left as the brief wrote it rather than coded around;
  narrowing it later is a one-line change.

- **`current-submission-id` still cannot be made attempt-correct.** The
  adoption rule added here ("only when nothing better claims it") is a
  tie-break, not a proof. If `judged` restarts while a judge is mid-grade, the
  announcement is the only evidence there is, and it names a job id. The
  attempt written into the adopted assignment is taken from whatever live entry
  that id resolves to, which after a restart is whatever was re-claimed from
  the database — usually right, not provably right. Closing this needs an
  attempt on the wire, which means a judge-server change, which is out of reach
  from here.

- **`live` remains keyed by bare job id.** D205 records why (composite keys
  break `cancel` and the orphan check, which have no attempt to hand), but it
  does mean the map can still only hold one attempt of a job at a time. Nothing
  in the current flow needs two, because a retry is only dispatched after the
  previous attempt has been cancelled; if that ever changes, this is where it
  breaks.

- **A `dispatch` that supersedes a PARKED earlier attempt never tells it to
  give up.** Found while tracing F1, adjacent to it, and deliberately not
  fixed here. `dispatch` overwrites `live[jobId]` with the new attempt's
  entry; the earlier attempt's entry is still parked in `acquireConnection`
  holding `cancelled === false`. When `cancel(jobId, N)` arrives it looks up
  `live[jobId]`, finds attempt N+1, fences on the attempt and returns — so
  nothing ever sets `E(N).cancelled`, and when a connection frees up, attempt
  N wakes and puts its `submission-request` on the wire for a job that has
  already moved on. `prior.cancelled = true` in `dispatch` before `live.set`
  would close it, but that is a behaviour change needing its own spec and its
  own red run, and back-pressure (`tryAcquireSlot`) means dispatch does not
  actually park on the shipped topology, so the likelihood is low. Worth a
  follow-up brief rather than a silent edit here.

- **No `graphify update .` was run.** `graphify-out/` does not exist in this
  worktree, so there was no graph to keep current.

## Commits

```
8cb85e4 fix(judged): route reply packets on (connection, attempt), not job id alone
57aeaf2 docs(decisions): D205 closes D29's "Left open" — routing on (connection, attempt)
abde8bc docs(b36): the report — red twice, green, and the suite this sandbox cannot run
5aba7e5 test(judged): pin the one-judge park/wake, and correct D205's D100 reference
22ea951 docs(b36): the report's commit list names the sha it was missing
81b1245 docs(b36): the report reads as written once, not revised in place
0a13325 fix(judged): retire the live entry by identity, and never leave a busy judge idle
9fef2a7 docs(decisions): D205 gains a fix-round-1 amendment, and stops overclaiming
9f0f665 docs(b36): the report carries fix round 1 — five findings, three specs
c1f3c8d docs(decisions): D205's closer moves last, and states the cost round 1 taught
7959e7d fix(judged): a terminal packet frees its connection even after the job retired
4bd90a1 docs(decisions): D205 gains fix round 2, and the sentinel's safety argument
```

`0a13325` onward are fix round 1, `7959e7d` onward fix round 2. `81b1245` is
the end of round 0 and the baseline the round-1 specs were shown red against;
`c1f3c8d` is the end of round 1 and the baseline for round 2's.

`abde8bc` is the draft written while the host had no container runtime, and
its title describes a report that no longer exists: it claimed
DONE_WITH_CONCERNS over 64 tests that could not start a Postgres container.
`5aba7e5` and everything after it supersede it — the suite was re-run against
a live socket, the concern evaporated, and the fourth spec was added.
