# Phase 4d — Contest participation and submission routing: ledger

**Spec:** `docs/superpowers/specs/2026-08-21-phase-4d-contest-participation-design.md`

**Result:** 684 tests green (was 671). A contest can now be joined and submitted
into. Migration `0010`.

---

## R1 — the submit model is explicit, by user ruling

`POST /submissions` carries an optional `contestKey`. DMOJ's stateful
`Profile.current_contest` — join once, and every later submission silently
attaches — was put to the user and rejected.

The reasoning that decided it: this API is meant to be driven by agents holding
tokens, and hidden session state is how an agent puts a practice submission
into a live contest. The same call must mean the same thing every time.

**The cost is real and is now a test, not a hope.** A participant who submits
without the key is practising, and `writes a contest_submissions row with
contestKey, and none without it` asserts exactly that. The web app owes the key
from its contest screen.

## R2 — `contest_submissions.points` was dropped rather than filled in

4c denormalised it. Nothing reads it: verified by grep, and `contest.access.ts`
rebuilds every score from `submission_cases` on each read because that is what
the formats consume.

It was `NOT NULL` with no default, so this phase — the first code that ever
inserts such a row for real — had to write *something*. The choices were a
literal `0` that stays wrong forever, or a second scoring write-path in
`judged` duplicating arithmetic the scoreboard already performs.

**Both are worse than not having the column.** Migration `0010` drops it.

The consequence worth stating: **`judged` needed no change in this phase.** A
contest submission is scored by grading writing `submission_cases`, exactly as
a practice submission is. That is the payoff for the column being dead.

## R3 — one window, reused

Submit-time enforcement calls `participationEndMs`/`participationStartMs` from
`@duckoj/contest-formats` — the same functions DIV-1 filters the scoreboard
with. Their signatures were relaxed from the fixture types to structural
minimums (`WindowParticipant`, `WindowContest`) so the API can pass row-derived
objects without inventing a `name` or a `points_precision`.

A second derivation would have failed in the worst possible way: a submission
accepted at the door and then silently dropped from the ranking.

## R4 — joining grants access to the contest's problems

A contest whose problems are already public is a contest whose problems leaked
before it started, so `canViewProblem` gained a clause and
`visibleProblemsWhere` gained a matching uncorrelated subquery.

**Not gated on the window still being open.** After a contest ends you may
re-read what you competed on, and anyone may join virtually anyway — the same
access by a longer route. Gating it would put contest-window arithmetic inside
a SQL visibility predicate to buy nothing.

**Accepted consequence:** such a problem also appears in that caller's ordinary
`GET /problems` list. Suppressing it there needs a second, contest-aware notion
of "visible", which is the thing this ruling declined to build.

## R5 — a vacuous test I wrote, caught by mutation

My first "accepts a submission at exactly the deadline" test set the contest to
end two seconds out and submitted over HTTP. **It passed against an exclusive
`<` comparison**, because a request arriving "before the end" never touches the
boundary at all.

Found by mutating `<=` to `<` and seeing all ten tests stay green. Rewritten to
drive `resolveContestTarget` with an explicit instant — `endMs` accepted,
`endMs + 1` refused — which is the only way a one-millisecond boundary is
testable.

This is the second time in two days that a test of mine asserted less than its
name claimed, and both times mutation testing was what said so.

## R6 — an equivalent mutant, reported as such

Removing `join`'s early return did **not** redden anything, because the insert
falls through to `onConflictDoNothing()` and the loser then reads the winner's
row. The mutation was equivalent, not survived: idempotency is guaranteed twice
over, in sequence by the early return and under concurrency by the conflict.

Replaced with a real break — every join computing a fresh `virtual` — which
reddens two tests. **The first result was not banked as evidence.**

## R7 — a unit-test hole TypeScript could not see

`problem-visibility.spec.ts`'s `ctx()` helper builds its object with
`{ ...defaults, ...over }` where `over` is a `Partial`. That spread makes
TypeScript accept a literal missing a required field, so adding
`inJoinedContest` to `ProblemViewContext` arrived there as `undefined` instead
of failing to compile.

Harmless by luck — `undefined` is falsy, which was the intended default. Spelled
out explicitly now, so the next fact added to that context is a compile error.

## R8 — mutation evidence

| Mutation | Result |
|---|---|
| M1 contest clause removed from the row form | 3 fail |
| M2 contest clause removed from the SQL form | 1 fail (the list half of the paired test) |
| M3 window end exclusive | 1 fail — **after R5's rewrite; green before it** |
| M4 `contest_submissions` row never written | 2 fail |
| M5 join's early return removed | **equivalent mutant, see R6** |
| M5′ every join creates a new participation | 2 fail |
| M6 wrong status for a non-participant | 1 fail |

M2 is the one worth noting: only the SQL form was broken, and only the list
half of `hides a private contest problem … in both the read and the list`
caught it. Asserting both halves is what makes a one-sided widening visible.

## Deferred

**Spectating (`virtual = -1`)** is unreachable through `join` and stays that
way; it exists in the schema for import fidelity and needs its own rules about
who may.

**A virtual join is deliberately not idempotent** — each one is a fresh
attempt, which is what `virtual = n` means. A client that blindly retries gets a
second attempt, and that is the correct reading of a request made twice.

**Contest UI.** The API is complete; no contest screens exist. Until they do,
the `contestKey` obligation from R1 is unmet in the browser.
