# Phase 4d — Contest participation and submission routing: design

**Status:** approved for implementation.
**Predecessors:** 4c (persistence, `contest.access.ts`, `contest.mapping.ts`) and
`2026-08-21-contest-divergences-design.md` (DIV-1, whose real fix lands here).

---

## 1. What this phase is

4a froze the scoreboards, 4b implemented the formats, 4c gave them a database.
**Nobody can enter a contest.** Participations exist only where a test seeded
them, and `POST /submissions` has never heard of a contest — nothing in the
product has ever written a `contest_submissions` row.

This phase closes that: join a contest, submit into it, and be refused when the
window has shut.

## 2. How a submission learns it is in a contest

**User ruling: an explicit `contestKey` on the submit request.**

```jsonc
POST /submissions
{ "problemCode": "aplusb", "languageKey": "cpp17", "source": "…",
  "contestKey": "div2-round-1" }   // optional
```

Omitted, it is an ordinary practice submission. Present, the caller must hold a
participation whose window is open, on a contest that contains that problem.

DMOJ instead keeps `Profile.current_contest` — you join, and every later
submission silently attaches until you leave. **That was rejected.** The same
call must mean the same thing every time it is made: hidden session state is
how an agent holding a token puts a practice submission into a live contest,
and this API exists to be driven by agents.

The cost is honest: a user solving a contest problem from the ordinary problem
page during a contest does *not* score for it. The web app must pass the key
from the contest screen. That is a UI obligation, recorded here.

## 3. Joining

```
POST /contests/:key/join     → 201 with the participation
GET  /contests/:key/me       → 200 with it, or 404 if you have none
```

**Idempotent.** Joining twice returns the existing live participation with 200
rather than creating a second or erroring. A retrying client must not be able
to fork its own participation, and `UNIQUE (contest_id, user_id, virtual)`
would turn the second attempt into a 500 otherwise.

**Live before the end, virtual after it.**

| Contest state | Result |
|---|---|
| not started | `409 contest_not_started` |
| running | live participation, `virtual = 0` |
| ended | virtual participation, `virtual = max(existing) + 1` |

`start_time` on the row is DMOJ's `real_start` — the instant of joining. The
*effective* start is derived, not stored: a live participation in a contest
with no time limit starts when the contest does, so joining late costs nothing.

**Spectating (`virtual = -1`) is out of scope** and must not be reachable
through this endpoint. It exists in the schema for import fidelity; a route
that creates one needs its own rules about who may.

## 4. The window, enforced at the door

DIV-1 filters out-of-window submissions when the scoreboard is computed. That
is a backstop. **The fix is refusing them at submit time**, with a distinct
error, so a competitor learns immediately rather than discovering at ranking
that their last three submissions were void.

**Reuse `participationEndMs` / `participationStartMs` from
`@duckoj/contest-formats`.** They are already exported and already the single
source of the rule; a second window derivation in the API is exactly the
divergence this project keeps finding. They take structural shapes, so the API
passes row-derived objects without a translation layer.

A submission outside the window is `403 contest_window_closed`, not a 404: the
caller demonstrably knows the contest exists — they joined it.

## 5. Contest problems must be visible to participants

A contest whose problems are already public is a contest whose problems leaked
before it started. So a problem's visibility gains one clause:

> **A problem is visible to an actor who holds a participation in a contest
> containing it.**

Deliberately *not* gated on the window still being open. After a contest ends
you may re-read the problems you competed on, and anyone may join virtually,
which is the same access by a longer route. Gating it would add contest-window
arithmetic to a SQL visibility predicate to buy nothing.

Nor is it gated on the contest being visible: joining already required that,
and a contest turned private after the fact should not blind its own entrants.

**Consequence, accepted:** such a problem also appears in the caller's ordinary
`GET /problems` list. It is a problem they legitimately have access to, and
suppressing it there means a second, contest-aware notion of "visible" — the
thing §4 just refused to do for windows.

**Reuse, do not restate.** This is one more fact in `ProblemViewContext` and
one more uncorrelated subquery in `visibleProblemsWhere`, exactly like the
`source_access` composition. The list/read agreement test is what proves the
two forms widened identically.

## 6. `contest_submissions.points` is dropped

4c denormalised it. **Nothing reads it** — verified: no query in the repository
selects the column. `contest.access.ts` rebuilds every score from
`submission_cases` on each read, because that is what the formats consume and
`ioi16` ignores a submission's total outright.

It is `NOT NULL` with no default, so this phase — the first code that ever
inserts such a row for real — would have to write something. The options were a
literal `0` that stays wrong forever, or a second scoring write-path in
`judged` duplicating arithmetic the scoreboard already performs.

**Both are worse than not having the column.** A migration drops it. 4c's own
schema comment already conceded nothing reads it, and its ledger already
recorded that the denormalisation rationale contradicted itself.

The consequence worth stating: `judged` needs **no change in this phase**. A
contest submission is scored by grading writing `submission_cases`, exactly as
a practice submission is.

## 7. Endpoints

```
POST /contests/:key/join   @RequireScope('contests:write')  any authenticated actor
GET  /contests/:key/me     @RequireScope('contests:read')
POST /submissions          + optional contestKey
```

`join` takes `contests:write` rather than a new scope: it writes contest state,
and a token that may create contests may certainly enter one. A narrower
`contests:participate` can be split out later without breaking a caller,
because widening a token's accepted scopes is backwards compatible and
narrowing is not.

## 8. Testing

1. **Join is idempotent** — twice in a row yields one participation, and the
   second returns the same id.
2. **Before the start it is refused**, after the end it creates `virtual = 1`,
   and a second post-end join creates `virtual = 2`.
3. **A submission with `contestKey` writes a `contest_submissions` row** and
   appears on the scoreboard once graded.
4. **A submission without `contestKey` writes none**, even from a participant
   during the contest. This is §2's cost, asserted rather than assumed.
5. **Out-of-window is refused at the door** with `contest_window_closed`,
   and — separately — a submission at exactly the deadline is accepted.
6. **A problem not in the contest is refused** even for a participant.
7. **A non-participant is refused** on a contest they never joined.
8. **A private contest problem is invisible before joining and visible after**,
   through both `GET /problems/:code` and `GET /problems`. The pair is the
   test; either alone passes against a predicate that widened only one form.
9. **The list/read agreement corpus gains a contest-only problem**, so the two
   visibility forms are proved to agree on the new clause.
10. **End-to-end**: join, submit with `contestKey`, let a real judge grade it,
    and read the score off the scoreboard. Nothing else proves the phase
    works, because every layer below it is already green in isolation.
11. Every new test demonstrated to fail against unfixed code.

## 9. Risks

**The visibility clause is the dangerous change.** Every previous phase found
one bug where a second implementation of a visibility rule disagreed with the
first, and this adds a clause to the most-consumed predicate in the system. The
agreement property is the only thing that catches a one-sided widening.

**A submission is routed once, at creation.** There is no path that moves an
existing submission into or out of a contest, and `UNIQUE (submission_id)`
enforces it. A regrade rewrites cases under the same row, which is why 4c's
latest-attempt filter matters here and is already tested.

**`GET /contests/:key/me` returning 404 for "not joined"** is a deliberate
reuse of the not-found shape for an empty result. It is not a leak — the caller
already passed the contest's own visibility check to reach it.
