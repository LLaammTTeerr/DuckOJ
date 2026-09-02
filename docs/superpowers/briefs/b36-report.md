# B-36 report — `live` keyed by job id, and the packets that landed in the wrong attempt

**Status: DONE_WITH_CONCERNS.** The defect is fixed and pinned by three specs,
all of which were watched red first. The concern is environmental, not about
the change: nine of `@duckoj/judged`'s nineteen spec files need a Postgres
testcontainer and this slot has no container runtime it is permitted to start,
so those 64 tests error identically before and after the change. Details in
"The full suite" below.

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
   and on the one-judge fleet this repo ships every later dispatch then parks
   in `acquireConnection` with no way out. The set is `grading-end`,
   `submission-terminated`, `compile-error`, `internal-error` — exactly the
   names for which `translate` calls `finish` — hoisted into a
   `TERMINAL_PACKETS` constant next to it so the two cannot drift apart
   silently.
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
and a nested `describe('a retry that reuses the job id')` adds three specs on
the existing two-judge harness. Two connections are what makes the race
expressible at all — attempt N on judge-1, attempt N+1 on judge-2, and a packet
arriving on the wrong one.

`docs/DECISIONS.md`: **D205**, plus an edit to D29's "Left open" paragraph
naming D205 as what closed it.

The rejected alternative — keying `live` by `${jobId}:${attempt}` — is recorded
in D205: `cancel` and the `current-submission-id` orphan check both look a job
up by bare id with no attempt in hand, so a composite key forces both to scan
or to invent an attempt they do not have.

## Red first

### Run 1 — the three new specs against the unmodified driver

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

### Run 2 — the third spec against the fix *without* the connection release

The third spec's distinctive assertion is about connection bookkeeping, so it
had to be watched red against the state it actually guards: the attempt fence
in place, item 3 above removed (`TERMINAL_PACKETS.has(packet.name)` forced
false). The first two specs pass here; the third does not.

```
stderr | test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > frees the connection a dropped TERMINAL packet arrived on
{"msg":"packet from a superseded attempt discarded","jobId":"7","packetAttempt":1,"liveAttempt":2,"connection":"judge-1"}

 ❯ test/multi-judge.spec.ts (11 tests | 1 failed) 14189ms
   ✓ a fleet of two judges > a retry that reuses the job id > drops attempt 1's grading-end instead of finalising attempt 2 with it 513ms
   ✓ a fleet of two judges > a retry that reuses the job id > drops attempt 1's test-case-status instead of moving attempt 2's counters 564ms
   × a fleet of two judges > a retry that reuses the job id > frees the connection a dropped TERMINAL packet arrived on 10577ms
     → expected [ Array(1) ] to have a length of 2 but got 1

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > frees the connection a dropped TERMINAL packet arrived on
AssertionError: expected [ Array(1) ] to have a length of 2 but got 1

- Expected
+ Received

- 2
+ 1

 ❯ test/multi-judge.spec.ts:442:55
    440|       // assignment was actually released.
    441|       await driver.dispatch(makeJob('99'), async () => {});
    442|       await vi.waitFor(() => expect(first.requests()).toHaveLength(2),…
       |                                                       ^
    443|       expect(first.requests().map((r) => r['submission-id'])).toContai…
    444|     }, 30_000);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 10 passed (11)
```

judge-1 was still marked busy with the grade it had already been told to
terminate, so job 99 went to judge-2 instead. With a fleet of one there is no
judge-2 and that dispatch never returns at all. The release branch was then
restored and the spec goes green.

## Green

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

### `nice -n 19 corepack pnpm --filter @duckoj/judged exec vitest run --no-file-parallelism`

The three new specs, and the two driver suites that exercise the code paths
this change touched:

```
stderr | test/multi-judge.spec.ts > a fleet of two judges > a retry that reuses the job id > drops attempt 1's grading-end instead of finalising attempt 2 with it
{"msg":"packet from a superseded attempt discarded","jobId":"7","packetAttempt":1,"liveAttempt":2,"connection":"judge-1"}

 ✓ test/multi-judge.spec.ts (11 tests) 4227ms
   ✓ a fleet of two judges > a retry that reuses the job id > drops attempt 1's grading-end instead of finalising attempt 2 with it 513ms
   ✓ a fleet of two judges > a retry that reuses the job id > drops attempt 1's test-case-status instead of moving attempt 2's counters 564ms
   ✓ a fleet of two judges > a retry that reuses the job id > frees the connection a dropped TERMINAL packet arrived on 613ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

The full suite, verbatim:

```
 ✓ test/dmoj-driver.spec.ts (21 tests) 2992ms
 ❯ test/event-writer.spec.ts (17 tests | 17 failed) 18ms
 ❯ test/worker.spec.ts (9 tests | 8 failed) 1025ms
 ✓ test/bridge-auth.spec.ts (15 tests) 2536ms
 ✓ test/multi-judge.spec.ts (11 tests) 4232ms
 ❯ test/job-language-routing.spec.ts (16 tests | 16 failed) 17ms
 ❯ test/contest-problem-stats.spec.ts (5 tests | 5 failed) 11ms
 ❯ test/contest-stats-races.spec.ts (2 tests | 2 failed) 9ms
 ✓ test/language-mapping.spec.ts (6 tests) 346ms
 ❯ test/judge-disconnect.spec.ts (2 tests | 1 failed) 235ms
 ✓ test/judge-affinity.spec.ts (7 tests) 2638ms
 ✓ test/worker-language.spec.ts (8 tests) 9566ms
 ✓ test/batch-points.spec.ts (5 tests) 804ms
 ❯ test/job-store.spec.ts (11 tests | 11 failed) 17ms
 ✓ test/worker-pool.spec.ts (3 tests) 1046ms
 ❯ test/pipeline-robustness.spec.ts (4 tests | 2 failed) 527ms
 ❯ test/job-store.concurrency.spec.ts (2 tests | 2 failed) 9ms
 ✓ test/agent-client.spec.ts (3 tests) 29ms
 ✓ test/config.spec.ts (6 tests) 8ms

 Test Files  9 failed | 10 passed (19)
      Tests  64 failed | 89 passed (153)
   Start at  17:23:06
   Duration  39.35s (transform 342ms, setup 0ms, collect 8.19s, tests 26.06s, environment 4ms, prepare 1.03s)
```

## The full suite is not green, and this change is not why

Every one of the 64 failures is the same error, and it is the only distinct
error in the output:

```
Error: Could not find a working container runtime strategy
 ❯ getContainerRuntimeClient ../../node_modules/.pnpm/testcontainers@12.1.0/node_modules/testcontainers/build/container-runtime/clients/client.js:67:11
 ❯ PostgreSqlContainer.start ../../node_modules/.pnpm/testcontainers@12.1.0/node_modules/testcontainers/build/generic-container/generic-container.js:62:24
 ❯ ensureContainer test/db.harness.ts:23:15
```

The nine failing files are exactly the nine that import `test/db.harness.ts`
(`grep -l "db.harness" apps/judged/test/*.spec.ts` returns that list and no
other). `db.harness.ts` starts a `postgres:16-alpine` container through
Testcontainers, pointed at the rootless Podman socket. This slot is forbidden
from running `podman`, so the socket is not there and no container can be
started.

**The baseline was measured rather than assumed.** With the driver and spec
changes stashed, the same command on the same worktree gives:

```
 Test Files  9 failed | 10 passed (19)
      Tests  64 failed | 86 passed (150)
```

Same nine files, same 64 errors, same single cause. The delta is exactly the
three specs this change adds: 86 → 89 passing. Every suite that can run in this
sandbox passes, including `dmoj-driver.spec.ts` (21), `judge-affinity.spec.ts`
(7) and `bridge-auth.spec.ts` (15), which are the ones that exercise the driver
and bridge paths the change touches.

**What that leaves unverified.** `judge-disconnect.spec.ts` is the only
container-gated file that covers code this change touched — `onJudgeGone`,
which is now attempt-fenced. It cannot run here. The fence only narrows: it
adds `entry.job.attempt !== assignment.attempt` to an early return whose other
condition (`!entry`) is unchanged, and in every single-attempt flow — which is
all that spec constructs, since `makeJob` there is attempt 1 throughout — the
two attempts are equal and the behaviour is identical. Someone with a container
runtime should still run it before this merges.

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

## Commits

```
8cb85e4 fix(judged): route reply packets on (connection, attempt), not job id alone
57aeaf2 docs(decisions): D205 closes D29's "Left open" — routing on (connection, attempt)
```
