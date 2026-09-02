# B-36 — `live` keyed by job id lets a superseded attempt's packets land in its successor's verdict

**Status when this brief was written:** open, recorded as the "Left open" paragraph
of **D29** and repeated in the block comment above `DmojDriver.dispatch`
(`apps/judged/src/drivers/dmoj/dmoj-driver.ts`, the note beginning "A retry reuses
the same job id with a higher attempt").

## The defect

DMOJ's `submission-id` field carries our **grading job id**, not our submission id,
and a retry **reuses the same job id with a higher `attempt`**. `DmojDriver.live` is
a `Map<number, LiveJob>` keyed by that job id alone, so it holds at most one entry
per job — attempt N+1's.

`handle()` routes every reply packet by `live.get(packet['submission-id'])`. When
attempt N has been terminated on connection C1 and attempt N+1 has been dispatched
to connection C2, a packet that was already in flight from C1 still finds attempt
N+1's entry and is translated into **attempt N+1's** event stream.

The guard that exists does not close it:

```ts
const held = this.assignments.get(connection.id);
if (!held || held.submissionId === submissionId) {
  this.assignments.set(connection.id, { submissionId, sent: true });
  entry.connection = connection.id;
}
```

C1's assignment still reads `{ submissionId: S, sent: true }` until the judge
answers, so `held.submissionId === submissionId` is **true**, `entry.connection` is
reassigned back to C1, and the stale packet is queued onto attempt N+1's `entry.queue`.

D29 narrowed the window by terminating attempt N on its own connection and not
handing that connection out again until the judge answers — but that is an argument
from timing, not a proof, and D29 says so in as many words.

## What a wrong outcome looks like

- A `grading-end` from attempt N finalises attempt N+1 while it is still compiling,
  writing a verdict computed from the **previous** run's cases.
- A `test-case-status` from attempt N inflates attempt N+1's case counters, so the
  subtask summary is built from two runs mixed together.
- Monitor counts and queue depth disagree honestly, which is D100's symptom.

## The fix

Make attempt part of the identity the driver routes on. `Assignment` already exists
per connection; give it the attempt, and require it to match:

1. Add `attempt: number` to `interface Assignment`.
2. Record it everywhere an assignment is created — the dispatch path, the
   `current-submission-id` path, and the wire-confirmation branch in `handle()`.
3. In `handle()`, before touching `entry.queue`: if the connection's held
   assignment names a **different attempt** than `entry.job.attempt`, discard the
   packet, log it once with `{ msg, jobId, packetAttempt, liveAttempt, connection }`,
   and return. Do **not** reassign `entry.connection`.
4. `releaseConnection` must stay attempt-aware for the same reason it is already
   submission-aware: a blind delete hands away a connection that has since been
   given to somebody else's grade.
5. The `current-submission-id` orphan path has no attempt on the wire. Keep its
   current behaviour — terminate when no live entry exists — but when a live entry
   does exist, only adopt the connection if the driver has no better claim on it.
   Say in a comment why an attempt cannot be recovered there.

Keying the map itself by a composite `${jobId}:${attempt}` string is the other shape
this could take. **Do not take it** without first checking every `live.get`,
`live.has`, `live.set` and `live.delete` call site — `cancel` and the
`current-submission-id` orphan check both look up by bare job id and have no attempt
to hand. The `Assignment` route is smaller and touches none of them.

## Testing — demonstrate red first

The driver has existing specs under `apps/judged/test/`. Find the ones that build a
`DmojDriver` against a fake bridge and extend that harness. The test that must go
red before the fix and green after:

> dispatch job `S` attempt 1 to connection C1; cancel it; dispatch job `S` attempt 2
> to connection C2; deliver a `grading-end` **on C1**; assert attempt 2 receives no
> terminal event and the stale packet is dropped.

Add a second: a `test-case-status` on C1 must not move attempt 2's counters.

Both must be shown failing against the unmodified driver, with the failure output
quoted in the report.

## Constraints — these are absolute

- Work in the worktree you are given. **Never** touch the running compose stack: no
  `podman`, no `podman-compose`, no `scripts/deploy.sh`, no `scripts/compose-up.sh`.
- The live database is read-only to you and you should not need it at all here.
- Never edit `.env`, and never print a credential.
- Bare `pnpm` is not on PATH — always `corepack pnpm`. `gh` is not installed.
- Thermal discipline: prefix long runs with `nice -n 19`, and run vitest with
  `--no-file-parallelism`.
- Before you report DONE, run the **full** judged suite, not just your new file:
  `nice -n 19 corepack pnpm --filter @duckoj/judged exec vitest run --no-file-parallelism`
  plus `corepack pnpm --filter @duckoj/judged typecheck` and `... lint`.

## Deliverables

- The fix and its tests, committed on your branch in small commits.
- A `docs/DECISIONS.md` entry as **D205** closing D29's "Left open" paragraph, and an
  edit to that paragraph in D29 saying which decision closed it.
- Update the block comment above `dispatch` — the sentence claiming the structural
  fix "is still outstanding" becomes false the moment you land this.
- A report at `docs/superpowers/briefs/b36-report.md`: what you changed, the red
  output quoted verbatim, the green output quoted verbatim, and anything you found
  and did not fix.
