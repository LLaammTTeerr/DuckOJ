# Phase 4c — Contest persistence and scoreboards: design

**Status:** approved for implementation.
**Predecessors:** `2026-08-21-phase-4b-contest-formats-design.md` and its ledger.

---

## 1. What this phase is

4b made the formats pure and proved them against 23 goldens. They currently
have no data source. This phase gives them one: contest tables, and a mapping
from rows into the input shape the formats already consume.

**The mapping is the entire risk of this phase, and it has a free test.**

## 2. The test that makes this phase verifiable

Every golden's `contest.json` is a complete description of a contest: problems,
participants, submissions with per-case batches and timings. So:

> **Seed a golden's `contest.json` into the real database, compute its
> scoreboard through the real service, and compare against the same golden's
> `scoreboard.json`.**

That reuses 23 fixtures to test something they were never built for. 4b's
tests prove the formats are right given correct input; these prove the
*mapping produces correct input*. A failure isolates cleanly: if 4b is green
and 4c is red, the bug is in the mapping, every time.

This is the acceptance criterion for the phase. Not "the tables exist" —
"a golden replayed through Postgres produces the golden."

## 3. Schema

```sql
contests(id, key UNIQUE(lower), name, start_time, end_time, format,
         format_config jsonb, points_precision int NOT NULL DEFAULT 3,
         frozen_last_minutes int NOT NULL DEFAULT 0,
         time_limit_seconds int NULL, visibility, created_by, created_at)

contest_problems(id, contest_id, problem_id, label, points,
                 partial bool, order int, UNIQUE(contest_id, problem_id))

contest_participations(id, contest_id, user_id, start_time, virtual int
                       NOT NULL DEFAULT 0, UNIQUE(contest_id, user_id, virtual))

contest_submissions(id, participation_id, contest_problem_id, submission_id,
                    points double, UNIQUE(submission_id))
```

Four decisions worth stating, because each is load-bearing:

**`virtual` is an integer, not a boolean.** DMOJ uses `0` for live and a
positive integer per virtual attempt, and `default` excludes `virtual != 0`
from first-solve. A boolean cannot represent a second virtual attempt and the
deferred import would lose it.

**`points` is denormalised onto `contest_submissions`.** It is the
contest-scaled score, which is not `submissions.points` — `ContestProblem`
carries its own `points`, so the same submission scores differently in two
contests. Deriving it at read time means the scoreboard depends on a scaling
factor that may since have changed; storing it pins what was scored.

**`format` is a plain text column, not an enum.** Formats are pluggable by
design (foundation spec) and an enum makes adding one a migration. The registry
in `packages/contest-formats` is the authority on valid values; an unknown
format is a 400 at write time.

**`frozen_last_minutes` defaults to 0**, matching every golden. Non-zero freeze
is unimplemented and must be **rejected at write time** rather than silently
ignored — 4b's formats throw on it, and a contest that accepts a freeze window
it does not honour is worse than one that refuses it.

## 4. Endpoints

```
POST  /contests                    @RequireScope('contests:write')  setter/admin
GET   /contests                    @Public() @RequireScope('contests:read')
GET   /contests/:key               @Public() @RequireScope('contests:read')
GET   /contests/:key/scoreboard    @Public() @RequireScope('contests:read')
```

`contests:read` and `contests:write` are new scopes; update the vocabulary pin
**by hand**.

Participation and routing submissions into a contest are **out of scope** —
this phase seeds participations directly, exactly as the golden replay does.
A contest nobody can join is useless in production and entirely sufficient to
prove the mapping, which is what this phase is for.

## 5. Visibility

A contest is `private`, `org` or `public`, mirroring problems. **Reuse the
existing shape rather than inventing a second one**: the scoreboard of a
private contest must 404, not 403, and the list must show only what the caller
may see.

Do **not** write a new predicate. If `problem.visibility.ts`'s shape fits, take
that shape; if it does not, say why rather than quietly diverging. This project
has one visibility bug per phase where a second implementation disagreed with
the first.

## 6. Testing

1. **The golden replay of §2**, over the whole fixture directory, enumerated
   not hard-coded.
2. **Prove the replay can fail.** Perturb the mapping — drop the `virtual`
   flag, or scale points by the problem's own value instead of the contest
   problem's — and confirm the specific goldens redden. A replay that passes
   against a broken mapping tests nothing.
3. **A non-zero `frozen_last_minutes` is refused at write time**, with a
   distinct error code.
4. **An unknown format string is refused at write time.**
5. Every new test demonstrated to fail against unfixed code.

## 7. Risks

**The mapping is where contest-scaled points get confused with problem
points.** `contest_problems.points` scales the submission's score; using
`problems`' own value passes any scenario where they happen to be equal — and
in most goldens they are. Fixture `ioi16/10-points-scaling-factor` is the one
that separates them, and it is the fixture most worth watching.

**Timezone and precision drift.** The goldens store ISO-8601 UTC and round to
nine decimal places. Postgres `timestamptz` round-trips fine, but a mapping
that converts through a local timezone will pass in one environment and fail in
another. Compare against the golden's normalisation, not a re-derived one.
