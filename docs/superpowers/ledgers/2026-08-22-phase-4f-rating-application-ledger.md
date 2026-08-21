# Phase 4f — Rating application: ledger

**Spec:** `docs/superpowers/specs/2026-08-22-phase-4f-rating-application-design.md`

**Result:** 731 tests green (was 721). Migration `0011`. Ratings are computed,
stored, replayable, and visible on a profile.

---

## R1 — the contradiction in foundation §9, resolved before any code

§9 requires the history to be "recomputable from scratch, **deterministically**"
*and* requires "correcting a broken scoreboard" to replay forward. Those cannot
both mean a frozen past.

**Ruling: determinism means the replay is a pure function of the current
database state.** Same contests, participations, submissions and
disqualifications in, same ratings out — not "the numbers never change".

So rankings are recomputed during a replay, never snapshotted, and
`rating_event` is a materialized result rather than an input. The consequence
belongs in a release note: **regrading a problem changes rating history.** That
is what §9's correction sentence asks for, and the alternative — folding over
frozen snapshots — makes a correction impossible to propagate, which is the
failure mode §9's own last line warns about.

## R2 — filter, then count

§9's exclusions (virtual, disqualified, zero-submission) apply *before* the
eight-participant threshold. A contest with thirty registrants of whom five
submitted has a five-person field, and rating it would be rating noise.

Tested with exactly that shape — twelve participants, five submitters — because
nothing else in the suite separates the two orderings.

## R3 — the full fold instead of replay-forward

Spec §5 describes `replayFrom(contest)`. The implementation is `replayAll()`,
which is the same function applied from the earliest contest.

Forward replay needs a per-user "rating as of this instant" query, and at a
season's worth of contests the full fold costs less than the opportunity to get
that query subtly wrong. It is also trivially the definition of the thing §2
requires to be reproducible. Flagged as a deviation; revisit when a season's
replay is measurably slow, not before.

## R4 — `(end_time, id)`, never `end_time` alone

Two contests ending in the same second must fold in a defined order or the
result depends on Postgres' row order, and the whole determinism claim collapses
on a tie nobody would think to test.

## R5 — a mutation that survived because no test covered the case

Removing the wholesale `users.rating = null` reset did **not** redden anything.
Correctly: every user in the fixture still had events afterwards, so the
per-user rewrite corrected them regardless.

The reset only matters for a user who ends with **no** events — someone whose
only rated contest was unrated. The per-user loop never visits them, so without
the reset they keep a rating from a contest that no longer counts.

Added that assertion to the HTTP test: after unrating the only contest, `rating`
and `max_rating` are `null` again. The mutation now reddens.

**The mutation was right and my test corpus was thin** — the same shape as
yesterday's self-referential threshold test. Both times the tell was that the
surviving mutant pointed at a state no fixture reached.

## R6 — two of the repo's own architectural tests caught this work

Neither was a test I wrote for this phase:

- **`route marker coverage`** — `AdminContestsController` carried both
  `@SessionOnly()` and `@NoScopeRequired()`. The rule allows exactly one marker
  per route, and `AdminUsersController` shows the convention: `@SessionOnly()`
  class-wide and no scope decorator at all.
- **`Dockerfile deps-stage manifests`** — `apps/api/Dockerfile` must `COPY`
  every workspace `package.json` its build needs, and `packages/glicko2` was
  new. Without it the image would fail to build, which no unit test would ever
  have shown.

Both are the kind of defect that reaches production and nothing else catches.
They are worth more than the review that would have missed them, and this is the
second phase running where a repo-level rule beat my own attention.

## R7 — `scoreboardForSystem`, and why it is named that

The replay folds over every rated contest regardless of who may see it, so it
needs a scoreboard without a visibility check. `getScoreboard` was split: the
computation moved to a private method, `getScoreboard(actor, key)` keeps the
check, and `scoreboardForSystem(contestId)` skips it.

It takes an **id, not a key**, so it cannot be reached with user input by
mistake, and it is named so that calling it from a request path looks wrong.
The 24 golden-replay tests passed unchanged across the split, which is what
says the refactor was behaviour-preserving.

## R8 — mutation evidence

| Mutation | Result |
|---|---|
| M1 non-submitters counted toward the field | 2 fail |
| M2 virtual entrants rated | 1 fail |
| M3 user cache not reset before rewrite | **survived; see R5**, then 1 fail |
| M4 admin check removed | 1 fail |

## R9 — a fixture that could not express the thing under test

`seedGoldenContest` names users after the contest, so two seeded contests had
disjoint participants — and a rating carried from one contest into the next is
the entire point of the fold. Both multi-contest tests failed at first for that
reason, not because the code was wrong.

The seeder now reuses an existing username instead of inserting a duplicate.
Every golden has distinct names within itself, so this changes nothing there,
and the 24 replay tests confirm it.

## Deferred, and needing the user's decision

**Inactivity decay.** `applyInactivity` is implemented and pure, but nothing in
the data says how much time passed between contests. Whether RD grows per
elapsed month, per missed rated contest, or not at all changes every rating
trajectory — retroactively, given the replay. **This phase applies none**, the
only reversible option. This is the second time it has been written down; it
needs an answer rather than another deferral.

**Rating is not automatic on contest end**, by design: "the contest ended" and
"the results are final" are different claims, and the gap between them is where
broken test data gets found. If that proves annoying in practice, a scheduled
job is a small addition.

**Rank titles and colour bands** remain what foundation §9 called them — a
product decision, still open.
