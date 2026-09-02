# B-36 report — `live` keyed by job id, and the packets that landed in the wrong attempt

**Status: DONE.** The defect is fixed and pinned by four specs, every one of
them watched red before it was watched green. `@duckoj/judged` is 19/19 files
and 154/154 tests green; the measured baseline on unmodified code is 150/150,
so the delta is exactly the four specs added here.

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

`multi-judge.spec.ts` needs no database, so none of the runs below were
affected by the container-runtime outage that was in progress while they were
taken. Every failure quoted is an assertion or a timeout, not an
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

- **No `graphify update .` was run.** `graphify-out/` does not exist in this
  worktree, so there was no graph to keep current.

## Commits

```
8cb85e4 fix(judged): route reply packets on (connection, attempt), not job id alone
57aeaf2 docs(decisions): D205 closes D29's "Left open" — routing on (connection, attempt)
abde8bc docs(b36): the report — red twice, green, and the suite this sandbox cannot run
5aba7e5 test(judged): pin the one-judge park/wake, and correct D205's D100 reference
```
