# Phase 4f — Rating application: design

**Status:** approved for implementation.
**Predecessors:** 4e (`packages/glicko2`, verified against Glickman), 4d
(contests are playable), foundation §9 (the rules).

---

## 1. What this phase is

4e made the algorithm correct and proved it. It has no inputs: nothing marks a
contest rated, nothing feeds it a ranking, and `users.rating` has never been
written by anything.

This phase connects it: a contest can be rated, ratings are stored with an
auditable history, and the whole history can be replayed.

## 2. The contradiction in §9, and how it is resolved

Foundation §9 says two things that do not obviously agree:

> the entire history must be recomputable from scratch, **deterministically**

> Unrating a contest, disqualifying someone a week late, or **correcting a
> broken scoreboard** all require replaying forward from that contest.

If a correction to a scoreboard must change the ratings that followed, then the
replay cannot be reproducing a frozen past. Both sentences are satisfiable, but
only under one reading, and it must be stated rather than assumed:

> **Determinism means the replay is a pure function of the current database
> state** — same contests, participations, submissions and disqualifications in,
> same ratings out, every time. It does *not* mean the numbers never change.

So rankings are **recomputed during replay**, not snapshotted. The consequence
is deliberate and worth stating to a user: **regrading a problem changes rating
history.** That is the behaviour §9's "correcting a broken scoreboard" asks
for, and the alternative — folding over frozen snapshots — makes a correction
impossible to propagate, which is the failure mode §9's last sentence warns
about ("systems that cannot do this accumulate permanently wrong ratings").

`rating_event` is therefore a **materialized result and an audit trail, not an
input.** Dropping every row and replaying must reproduce them exactly. A test
asserts precisely that.

## 3. Who is rated

Foundation §9's rules, in the order they apply — and the order is the design:

1. Take the contest's computed scoreboard.
2. **Exclude** `virtual != 0` (virtual and spectator), `is_disqualified`, and
   any row with `submission_count == 0`.
3. **Then** require at least `MIN_RATED_PARTICIPANTS` (8) rows remaining.

**Filter first, then count.** A contest with 30 registrants of whom 5 actually
submitted has a five-person field, and rating it would be rating noise. Testing
the threshold before filtering would rate exactly that contest, so the ordering
is load-bearing and is asserted.

**Ties do not reduce the count.** Eight entrants of whom two tie are still eight
participants and the contest is rated; the threshold counts people, not distinct
ranks.

**"Zero submissions" means zero submissions *in this contest*** —
`submission_count` on the scoreboard row, which counts `contest_submissions`.
Since 4d refuses out-of-window submissions at the door and DIV-1 filters any
that predate it, a participant whose only attempt fell outside the window has a
count of zero and is excluded. That follows from the existing rules rather than
adding a new one.

**Ranks are taken from the scoreboard unchanged**, gaps included. After
exclusions the surviving ranks may read 1, 2, 4, 7 — which is fine: Glicko-2
compares ranks pairwise, so only their order and equality matter, and
re-numbering them would be work that changes nothing except the chance of a
bug.

## 4. Schema

```sql
ALTER TABLE contests ADD COLUMN is_rated boolean NOT NULL DEFAULT false;

rating_event(id, contest_id, user_id,
             rating_before, rd_before, volatility_before,
             rating_after,  rd_after,  volatility_after,
             rank, created_at,
             UNIQUE (contest_id, user_id))
```

Matching foundation §"Data model" field for field.

`users.rating` and `users.max_rating` become **denormalised caches** of the
latest event — the profile reads them, and the replay rewrites them. That is a
second write path, which this project has twice removed elsewhere; it is
justified here only because a profile must not fold a user's entire contest
history to render, and it is rewritten wholesale by the same code that writes
the events, never incrementally.

**`volatility` has no column on `users`.** It is carried by `rating_event`
alone, because nothing displays it and the replay reads it from the last event.
Adding a third cached column with no reader would repeat the mistake
`contest_submissions.points` was deleted for.

## 5. The fold

```
replayFrom(contest) :=
  for each rated contest with end_time >= contest.end_time, ordered by (end_time, id):
     ranking  := scoreboard(contest) filtered per §3
     players  := each user's rating as of the previous event, or the default
     changes  := rateContest(ranking)
     write rating_event rows, replacing any for this contest
  then rewrite users.rating / max_rating from the last event per user
```

**Ordered by `(end_time, id)`**, not `end_time` alone: two contests ending in
the same second must fold in a defined order or the result depends on how
Postgres happened to return them, and the whole determinism claim collapses on
a tie nobody will think to test. The id is the tiebreak, and it is stable.

**`max_rating` is recomputed over the replayed history**, not maintained as a
running maximum against the old value — otherwise unrating a contest could
leave a peak that no longer happened anywhere in the record.

## 6. Endpoints

```
POST /admin/contests/:key/rate     admin — mark rated and replay forward
POST /admin/contests/:key/unrate   admin — mark unrated and replay forward
GET  /users/:username/rating       @Public — the user's rating history
```

Both writes are admin-only and `@SessionOnly()`: rating is the most
consequential retroactive operation in the system, and a scoped API token
should not reach it. That mirrors the ruling that kept role promotion
session-only.

Rating is **not** automatic on contest end. A contest is rated when a human says
so, because "the contest ended" and "the results are final" are different
claims, and the gap between them is where broken testdata gets found.

## 7. Testing

1. **The replay is reproducible**: rate a contest, delete every `rating_event`
   row, replay, and get byte-identical rows. This is §2's determinism claim and
   the reason the table is a result rather than an input.
2. **Order independence of the fold is *not* claimed** — the opposite: two
   contests ending in the same second must produce the same result across
   repeated replays, asserted by replaying twice.
3. **Filter-then-count**: a contest with 12 participants of whom 5 submitted is
   **not** rated. This fails against an implementation that checks the
   threshold first, and that is the only thing separating the two orderings.
4. **Ties at the boundary**: 8 participants including a tied pair *is* rated.
5. **Exclusions**: a virtual entrant, a disqualified entrant and a
   zero-submission entrant each appear on the scoreboard and none receives a
   `rating_event`.
6. **Unrating replays forward**: rate A then B, unrate A, and B's ratings must
   be those of a world where A never happened — not B's old numbers.
7. **First-timers start at the default** 1500/350/0.06.
8. **`max_rating` falls** when the contest that produced the peak is unrated.
9. **A token cannot rate**, even an admin's.
10. Every new test demonstrated to fail against unfixed code.

## 8. Risks

**Test 1 is the phase's acceptance criterion**, exactly as the golden replay was
4c's. If `rating_event` cannot be regenerated from nothing, every later
correction is guesswork.

**Test 6 is the one most likely to be got wrong.** Unrating A and recomputing
only A is the natural implementation and passes any test that looks at A alone.
The bug shows only in B, downstream, which is where a real user's rating lives.

**The scoreboard is recomputed once per contest per replay.** For a season of
contests this is fine; if it ever is not, the fix is caching within a single
replay, not snapshotting rankings — which §2 ruled out for correctness.

## 9. Deferred, and needing a product decision

**Inactivity decay.** `applyInactivity` exists and is pure, but a contest is our
rating period, so nothing in the data says how much time passed. Whether RD
grows per elapsed month, per missed rated contest, or not at all changes every
rating trajectory, and retroactively, given §5's replay. **This phase applies no
decay** — the conservative option, and the only one that is reversible without
rewriting history. It is flagged for the user rather than defaulted quietly.
