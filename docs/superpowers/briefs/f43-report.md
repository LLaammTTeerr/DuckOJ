# F-43 report — two people, one screen, and neither of them loses

**Status: complete.** Both halves done, each with a test demonstrated red
against the unfixed code and the failure output recorded here and in its
commit. **D161** rules the concurrent edit, **D162** rules the monitor's
invalidation; **D163 is unused**. Five commits on `main` in this clone.
**Not pushed, not deployed.**

`podman-compose`, `scripts/compose-up.sh` and `scripts/deploy.sh` were never
run. **`apps/web/dist` was never written and no `vite build` ran.** Nothing in
`.secrets/` was read, printed or committed. **No live rows were created**, so
there is nothing to close under D153 — see "Why there is no browser walk".

---

## Commits

| | |
| --- | --- |
| `05eaacc` | `docs(D161,D162)` — who wins when two people edit one thing, and what busts the monitor |
| `ca164df` | `fix(monitor)` — answering a question takes it off the panel the teacher is watching |
| `cf09e1c` | `feat(api)` — a save says what state it believes it is replacing, and a stale one is refused |
| `43bb606` | `feat(web)` — the edit forms carry the version they were seeded with, and say when a save cannot land |
| *(HEAD)* | `docs(f43)` — this report |

HEAD before this slot was `c68fcf1`, which is **the commit the live stack is
deployed at**. So nothing in this slot is on the edge, and neither is B-31's.

---

## The runs, verbatim

**Whole `@duckoj/api` package, `--no-file-parallelism`, `nice -n 19`:**

```
 Test Files  1 failed | 142 passed (143)
      Tests  2 failed | 1236 passed (1238)
   Duration  780.69s
```

**The two failures are inherited and are not this slot's.** They are
`test/dockerfile-manifest.spec.ts`:

```
 × apps/api/Dockerfile COPYs every package.json its build actually needs
   → apps/api/Dockerfile is missing COPY <dir>/package.json for:
     expected [ 'packages/language-limits' ] to deeply equal []
 × apps/judged/Dockerfile COPYs every package.json its build actually needs
   → apps/judged/Dockerfile is missing COPY <dir>/package.json for:
     expected [ 'packages/language-limits' ] to deeply equal []
```

**Verified pre-existing**, not assumed: the whole working tree was stashed
(`--include-untracked`) and that one spec re-run against `c68fcf1`, where it
fails identically — `Tests 2 failed | 2 passed (4)`. `packages/language-limits`
is F-41's package (D159), nothing in this slot touches a Dockerfile, and the
diff for this slot contains no `Dockerfile` or `language-limits` path. **It is
a real defect and it is out of this slot's scope** — see "What I could not
finish".

**Whole `@duckoj/web` package, same flags:**

```
 Test Files  71 passed (71)
      Tests  762 passed (762)
   Duration  125.06s
```

758 before this slot, 762 after: the four new cases in
`edit-form-conflict.spec.tsx`. The six new API cases are in
`edit-version-conflict.spec.ts` and the two new monitor cases were added to
`contest-monitor-stats.spec.ts`.

**`@duckoj/contracts`: `Test Files 9 passed (9)`, `Tests 39 passed (39)`.**
**`@duckoj/sdk`: `Test Files 1 passed (1)`, `Tests 2 passed (2)`.** Both were
re-run because both packages changed.

`tsc -b` and `tsc --noEmit -p tsconfig.test.json` clean on `@duckoj/api`;
`tsc --noEmit` clean on `@duckoj/web`. `eslint` clean on `@duckoj/api`,
`@duckoj/web` and `@duckoj/contracts` — and lint caught one thing typecheck did
not (an unused `RS` constant in `edit-version.ts`, since the record separator
has to be produced by Postgres as `chr(30)` and cannot be a TypeScript
constant at all).

`openapi.json` and `packages/sdk/src/generated.ts` were regenerated with the
repository's own two commands and are committed in `cf09e1c`.

---

## Two claims in the brief, checked rather than inherited

**1. The brief's path for the monitor is wrong.** It says
`apps/api/src/contests/contest.monitor.ts:113-118`. There is no such file. The
service is **`apps/api/src/authz/contest.monitor.ts`**, and it is in `authz/`
for a stated reason: it reads six guarded tables, which the runbook's "Reading
a guarded table" confines to that directory. The comment in question was at
lines 110–125.

**2. B-31's "both clarification writes" is three writers, of which two move the
panel.** `ContestClarificationsService` writes `contest_clarifications` in
`ask`, `announce` and `answer`. The panel's predicate is `answer is null`
(`clarifications()` in the monitor), so:

| writer | what it inserts / sets | moves the panel? |
| --- | --- | --- |
| `ask` | a row with `question` and no `answer` | **yes** — a new unanswered question |
| `answer` | fills `answer` on an existing row | **yes** — takes it off the list |
| `announce` | a row whose text lives IN `answer` (D31), `answer` set from birth | **no**, today |

**B-31's conclusion is right and its arithmetic is loose.** The comment it
attacked was factually false, and the check confirms it: `ask` and `answer` are
neither a submission nor a verdict, both are handled by this process, and
neither invalidated anything. `announce` invalidates anyway — D162 says why.

---

## Part 1 — two teachers editing one problem

### The ruling, and what it rejects

**D161.** The full argument is in `docs/DECISIONS.md`; the shape of it is:

**Reseeding an undirty form is not a guarantee and cannot be made into one.**
"Undirty" is exactly "this teacher has typed nothing", and the teacher who loses
work is the one who *has*. A dirty form must never be reseeded — that is the
same data loss with the victims swapped — so the moment teacher A has changed
the name, A is back to holding a stale statement with nothing on screen. It also
depends on a refetch happening at all, which a form that stays mounted with the
window focused may never do.

**So the ruling is an optimistic-concurrency check at the API**, and the
reseed is adopted *as well* — not as an alternative, but as the thing that keeps
the refusal rare enough that nobody learns to click through it. Without it,
every second teacher to open a form after anybody else's save is refused on
their first attempt.

### The token is a content hash, not a version column

Three shapes were available and two were rejected.

**A `version` column** (bumped in the two PATCH paths) is the textbook answer.
Rejected on two counts: it needs a migration on a production stack at 0043 that
this defect does not justify touching, and its correctness is a **discipline**
rather than a constraint — right only for as long as every future writer of
`problems` remembers whether to bump it. The revision-publish path writes
`problems.current_revision_id`; the admin rate toggle writes `contests`;
neither is an edit-form save, and each would manufacture a conflict for a
teacher who changed nothing, or fail to raise one, depending on which way the
next author guessed.

**A hash of the detail DTO** is the shape that looks cheapest and is wrong for a
reason worth recording: **that response is viewer-dependent.** Checked in the
code, not assumed:

- `ProblemAccessService.loadVisible` blanks `tags` and `difficulty` under D35
  for a viewer sitting a running contest that uses the problem;
- `loadMembersAndOrgs(id, actor, isEditor)` withholds `orgSlugs` from a
  non-editor;
- `ContestAccessService.getVisible` returns `problems: []` before the start for
  everyone who does not run the contest — so a token over it would **populate
  at the start instant with no edit at all** and refuse saves nobody could
  explain.

**What shipped: a SHA-256 over the stored editable columns**, one query per
record, taking no actor — `apps/api/src/authz/edit-version.ts`. The column list
is exactly `UpdateProblemRequest` / `UpdateContestRequest` and nothing else.
Determinism is load-bearing (the value is computed on a read in one worker and
compared on a write in another), so: no wall clock, an explicit `ORDER BY` on
every aggregate, timestamps reduced to epoch milliseconds rather than cast to
`text` (whose rendering follows the session's `TimeZone`), `jsonb::text` for
`format_config` because that is Postgres's own normalised form, ASCII 31/30 as
separators, and `null` digested to a marker rather than to `''` so
`editorial: null` and `editorial: ''` cannot collide.

Being a **content** hash buys two things a counter cannot, and both are pinned
by tests: a no-op re-save does not conflict, and a write outside the form's
field list — a published revision, above all — does not lock a co-author out of
the statement.

### Where the check runs

Inside the update transaction, **first**, after `select … for update` on the
parent row. Read outside the lock this would be a check against a state that may
not hold by the time the UPDATE lands — two teachers pressing Lưu in the same
second would each see their own version confirmed and one would still be
overwritten, which is the whole defect with a narrower window. Both PATCHes take
the same lock, so the second waits, reads the state the first one left, and is
refused. `ContestClarificationsService.answer` and `OrgAccessService.decideRequest`
lock for the same reason and say so.

A throw there rolls the transaction back with nothing written, which is the
promise the 409 makes and which the test asserts on the stored row rather than
on the response.

On the contest route the check runs **after** the `contest_started` guards,
deliberately: "this contest has started, its format can no longer change" is a
fact a reload cannot repair, and telling an organiser to load a newer version
first would send them round a loop ending in the same refusal.

### The wire

`ProblemDetail.version` / `ContestDetail.version`, `string | null` —
**`null` for a caller who may not edit**, on `ContestDetail.canEdit`'s
precedent, so no pupil reading a statement pays the extra query.
`expectedVersion` is optional on both update requests; **absent means
unchecked**, which is the honest weak point of the ruling and is pinned by a
case of its own. The API is a documented surface with personal access tokens
behind it and an import script that never had this problem; refusing every
PATCH that had not first read a detail would break automation to fix a defect it
does not have. What the rule actually says is *a client that tells me what it
believes it is overwriting will not be allowed to overwrite something else*,
and both forms tell it on every save.

### The form

`problem-edit.tsx` and `contest-edit.tsx`, matching the conventions rather than
replacing them:

- **D110/D146** — the 409 is handled ahead of the field mapper on the contest
  form, because it carries no field attribution and never will: the token is a
  hash of the whole editable object, so there is no one box to focus. It goes
  to the `CodeAlert` banner with the server's code verbatim.
- **D147** — the reseed and the leave guard read **one** `dirty`. On
  `contest-edit.tsx` that comparison was moved above the seeding effect so the
  two cannot drift; "there is unsaved work here" has to mean one thing to both
  or one of them is wrong.
- **D148** — the reload button is live unless busy and says what it is doing.
- **D18** — four strings, vi and en.

Two behaviours worth stating out loud:

**The reseed is announced.** A line says the record was changed elsewhere and
the form now shows the newer version. Nothing was lost, and saying so is what
stops a teacher who looked away for a minute from concluding the site ate their
draft.

**The reload is a button, never automatic.** A conflict is by definition a form
holding work; a page that silently replaced it with somebody else's copy would
be the loss this feature exists to forbid. Until the teacher presses it,
everything they typed is on screen and copyable. The handler awaits the refetch
*before* reopening the seed guard, so the effect cannot seed synchronously from
the stale cache entry — B-31's mechanism, avoided rather than relied on.

### Red first

**API — `edit-version-conflict.spec.ts`, six cases over HTTP** (both request
schemas are `.strict()`, so a field the contract has not learned is a 422 that
a service-level test cannot see). Against `cf09e1c`'s parent:

```
 × refuses the second save, writes nothing, and leaves the first teacher's statement standing
   → expected 'undefined' to be 'string'
 × hands back a token the same form can save with again, so a second save is not a conflict with itself
   → expected undefined to deeply equal Any<String>
 × does not move on a save that changed nothing, and does not move on a write the form does not own
   → expected 'undefined' to be 'string'
 × leaves a PATCH that sends no token unchecked, and serves no token to a reader who may not edit
   → expected undefined to be null
 × refuses the second save and leaves the problem list the first one wrote
   → expected 'undefined' to be 'string'
 × serves no token to a spectator, and accepts a save that carries the current one
   → expected undefined to be null
 Tests  5 failed | 1 passed (6)
```

**One honest footnote.** On the first red run the third case *passed*, because
every `toBe(version)` in it was `undefined === undefined`. The
`expect(typeof version).toBe('string')` at the top of that case is what makes it
red, and it was added for exactly that reason — the output above is the run
after it.

**Web — `edit-form-conflict.spec.tsx`, four cases, one `QueryClient` across the
walk** (B-31's shape; every other spec for these pages builds a fresh client per
render and has a cold cache, which is why the class survived 758 tests). Red
with only the two route files reverted, so the strings stayed put and the
failure is about behaviour:

```
 × takes the newer statement when nothing has been typed, and says that it did
   → expect(element).toHaveValue(Cong hai so nguyen, in ra tong.)
     Received: "Cong hai so."
 × sends the version it was seeded with, and offers the newer one when the save is refused
   → expected undefined to be 'v1'
 × refuses to send the stale problem list back, and keeps it on screen until the organiser chooses
   → expected undefined to be 'v1'
 Tests  3 failed | 1 passed (4)
```

**The fourth case passes against the old code too** — that code never reseeded
at all — and it is labelled in the spec as what it is: a regression guard on the
dangerous half of clause A, the half that would turn this feature back into data
loss if somebody later "simplified" the condition to "reseed whenever the
version moved".

---

## Part 2 — the monitor's clarifications panel

### The comment was wrong, and the check confirms it

`monitorCacheKey`'s doc comment justified having no invalidation at all:

> No invalidation, deliberately. Every write that would change this snapshot is
> a submission or a verdict, and the API does not handle the verdict at all.

The snapshot carries a clarifications panel — the questions nobody has answered,
counted and listed — and every write to `contest_clarifications` is handled by
this process. So during a contest a teacher answered a question and the monitor,
the screen they had open *because* the round was running, kept the answered
question in its "waiting" list until a five-second TTL nobody could see expired.
A question just asked did not appear at all.

### The fix, and the rule it now holds (D162)

`ContestClarificationsService` deletes `duckoj:monitor:v1:<id>` after all three
of its writes, **after the transaction commits**, never inside it — a delete
issued inside the transaction is one a concurrent reader can race, re-folding
the pre-commit state into the key it just emptied and pinning the stale answer
there for a whole TTL. `RejudgeService`'s scoreboard invalidation is the
precedent.

**Unconditionally, `announce` included**, whose row the panel's `answer is null`
predicate excludes today. That predicate lives in a different file, and the
whole defect being closed here was a comment in this pair of files reasoning
across that gap and getting it wrong. One `DEL` per announcement is not a price
worth reasoning about.

**The comment was rewritten, not deleted**, and it now names its exceptions,
because the defect was a comment that did not.

### The audit of the rest of the snapshot

Every panel, what can move it, and whether something busts the key.

| Panel | What moves it | Busts the key? |
| --- | --- | --- |
| `clarifications` | `ask`, `answer` (and `announce`, which does not move it today) | **yes, now** — D162 |
| `problems` (per-problem counters) | a graded verdict; a submission being created; a rejudge; a mid-round contest edit changing a label | **no** — see below |
| `queue` (depth, oldest) | `grading_jobs` written by `judged`; a rejudge queueing work | **no** |
| `feed` | a submission, and its verdict | **no** |
| `judges` | `judge_nodes.last_seen`, written by the bridge | **no** |
| `participantsOnline` | the presence set, its own store, its own five-minute window | **no** |
| `submitRefusalsLast10Min` | `rate_events` written by the D80 meter on a refused submit | **no** |

**Four of those are not this process's to bust and have no call site to add**:
a graded verdict (D25 records the same asymmetry for the scoreboard in as many
words — `judged` is a separate process that never calls in), a judge heartbeat,
the presence set, and a rate-limiter refusal. Their staleness is the TTL and
nothing else could make it shorter.

**Two are API-handled and were deliberately left**, per the brief's instruction
not to churn B-31's enumerated gaps — and, unlike the clarifications comment,
their stated reason is not false, it was merely *absent*. D162 now names both:

- a **rejudge** queues work, so at response time nothing has been regraded and
  the snapshot it would refresh is not yet the one the organiser wants. The
  panel it does move immediately is the queue depth, a number whose whole
  meaning is "how far behind the judge is" and which is five seconds behind by
  construction. `?recompute=1` (D100) is the organiser's repair;
- a **mid-round contest edit** (D28 keeps editing diff-safe after the gun, and
  the started-contest guards refuse everything structural) moves the panel's
  problem labels, one poll tick late.

**No other panel's stated reason was found to be false.** That is a reported
absence, not an unexamined all-clear: the only justification-shaped comment on
this cache was the one on `monitorCacheKey`, and it is the one that was wrong.

### Red first

Two cases added to `contest-monitor-stats.spec.ts`, both through the **real**
Map-backed read-through cache that file already uses for `?recompute=1`, and
both sharing **one** `ScoreboardCache` between the writer and the monitor — two
caches would be two independent stores and the assertion would pass against the
unfixed code as readily as against the fixed one. Red with the invalidation
neutered:

```
 × shows a question asked a moment ago, rather than the panel cached before it
   → expected 0 to be 1
 × takes an answered question off the panel, in the round it was answered in
   → expected 1 to be +0
 Tests  2 failed | 5 skipped (7)
```

Green, with `contest-monitor`, `contest-clarifications` and
`clarification-races` beside it: `Test Files 4 passed (4)`, `Tests 40 passed
(40)`.

---

## Why there is no browser walk

The brief allows one and asks for it *if it is the honest proof*. Here it is
not, and B-31's reasoning applies verbatim.

**The live edge is at `c68fcf1`**, so a walk could only ever show these red; it
could not show a fix green, because every fix in this slot is a local commit the
edge does not carry. And a red walk would prove nothing the specs do not already
prove **at the layer the defect lives in**:

- part 2's cases drive the real `ContestMonitorService` against a real Postgres
  and a real read-through cache with real staleness — a browser would only add
  an HTTP hop in front of the same fold;
- part 1's API cases go over HTTP through the real contract, the real validation
  pipe and the real transaction, and assert on the **stored row** that nothing
  was written; its web cases drive the real `QueryClient` with the real keys
  across a real refetch, which is the one thing a mocked unit test structurally
  cannot do and the reason this class survived 758 tests.

The cost of a walk is not zero: it means creating a contest, a participant and a
question on a **production** list, then cleaning them up. Paying that to see a
red we can already produce deterministically would be theatre.

**No live rows were created. Nothing is open under D153.**

---

## What I could not finish

* **Nothing is deployed.** All five commits are local on `main`, and the live
  stack is at `c68fcf1`. Until the controller ships both `api` and `web`: two
  teachers editing one problem still race and the second save still wins
  silently, and a teacher who answers a clarification during a live round still
  watches it sit in the monitor's unanswered list for five seconds. The API half
  and the web half must ship **together or API-first** — an old web bundle sends
  no `expectedVersion` and is simply unchecked, which is the pre-slot behaviour;
  a new bundle against an old API would 422 on every save, because both request
  schemas are `.strict()`. **What that window looks like on screen**, since the
  controller will want to know what a violation costs on contest day: nothing
  crashes and nothing is lost. `problem-edit` shows its usual `CodeAlert` with
  `validation_failed` beside it; `contest-edit` routes the 422 through D146's
  field mapper, which has no entry for `expectedVersion`, so it lands in the
  banner rather than on a box. D148 leaves the button live. A teacher simply
  cannot save, with a message that does not explain why, until the two halves
  converge.

* **`test/dockerfile-manifest.spec.ts` is red and this slot did not fix it.**
  `apps/api/Dockerfile` and `apps/judged/Dockerfile` do not `COPY
  packages/language-limits/package.json`, so a clean image build of either is
  broken. **Verified pre-existing at `c68fcf1`** by stashing the whole tree and
  re-running that one spec. It is F-41's package (D159) and a one-line fix in
  each Dockerfile, but it is a build-and-deploy change in a slot whose brief
  says not to start anything else and forbids running the deploy scripts —
  **worth its own slot, and it blocks the deploy of everything above**.

* **The conflict is coarse and there is no merge.** D161 says so and prices it:
  a teacher who changed only the name is refused because somebody else changed
  the statement, and the remedy is to load the newer version and retype the
  name. The refusal also cannot say *what* changed — the token is a hash, and
  the pre-image these two tables would need is history they do not keep.
  Field-level three-way merging is a much larger feature; refusing a write is a
  recoverable outcome where losing one is not.

* **`expectedVersion` is optional, so a client that omits it is exactly as
  exposed as before.** Deliberate, argued in D161, pinned by a test — but it
  means the guarantee is a guarantee for *these two forms*, not for the route.

* **The other seed-once forms were not touched.** `settings.tsx`,
  `problem-language-limits.tsx` and `contest-new.tsx`'s clone are the other
  three B-31 enumerated. All three refresh their own source (or read a
  read-only one), so none has the *stale-own-value* defect — but none has a
  concurrency token either, so two people editing one user's settings or one
  problem's language limits still race. Out of this slot's scope, and now that
  D161 exists the pattern is cheap to extend.

* **D163 is unused.** B-31's precedent: a decision is spent when a stated
  behaviour changes. D161 changes one (a save can now be refused) and D162
  changes one (a cache that documented itself as never invalidating now does).
  Nothing else in this slot does, so nothing else spends a number.
