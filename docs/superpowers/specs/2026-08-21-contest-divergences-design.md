# Contest semantics: deliberate divergences from DMOJ

**Status:** approved for implementation (user-directed: *"should not inherit bugs"*).
**Predecessors:** 4a ledger R6 (what the formats actually do), 4b design §5
(which reproduced these bugs deliberately and deferred the product decision).

---

## 1. The decision, and what it costs

4b implemented DMOJ's behaviour exactly, including two defects, and recorded
that *"deliberately diverging is a product decision for later"*. That decision
is now taken: **DuckOJ does not inherit them.**

The cost is that the 23 goldens stop being a pass/fail oracle for production
code. They are the only evidence we ever understood the original, so they are
**not edited and not deleted**. They move from "the specification" to "the
compatibility baseline", and the divergence becomes a measured, named delta
between two registries.

## 2. The two divergences

**DIV-1 — a submission outside its participation's window does not count.**
Nothing in any DMOJ format filters by time; `icpc/03-deadline-boundary` scores
a submission 60 seconds past the deadline as a solve. DuckOJ drops it.

**DIV-2 — `default` times a problem by its *best* submission, not its last.**
DMOJ computes `Max(points)` and `Max(date)` as independent aggregates, so junk
submitted after an accept raises the penalty. DuckOJ takes the time of the
best submission, **earliest among ties** — the same rule `legacy_ioi` already
uses, and the same rule the `me` column uses for best-verdict.

**Nothing else changes.** `icpc`'s minute flooring, `ioi16` reading test cases
rather than `ContestSubmission.points`, `legacy_ioi`'s config-gated cumtime and
`default`'s always-zero tiebreaker are **design, not defects**. A divergence
list that grows during implementation is a rewrite; this one is closed at two.

## 3. The window, read from source not memory

`ContestParticipation.end_time`, `judge/models/contest.py`:

| Participation | Window end |
|---|---|
| spectator (`virtual = -1`) | `contest.end_time` |
| virtual (`virtual > 0`) | `real_start + (time_limit ?? contest duration)` |
| live (`virtual = 0`) | `contest.end_time`, or `min(real_start + time_limit, contest.end_time)` when a time limit is set |

**The window end is inclusive.** `Contest.ended` is `end_time < now` — strictly
after — so a submission stamped exactly at the deadline is still inside the
contest. `03-deadline-boundary` contains one by design and it must keep
counting; only submissions strictly after the end are dropped.

**A virtual participation legitimately outlives the contest.** In all three
`05-virtual-participation` goldens the virtual entrant submits six hours after
`contest.end_time`, inside her own five-hour window. A filter written against
`contest.end_time` would void her, which is a *new* bug traded for an old one.
This is the trap DIV-1 exists to avoid, and it is why the window is
per-participation.

**One helper, not two.** `lower.ts` already derives `ContestParticipation.start`
(`participationStartMs`, line 155). The window end must be derived beside it and
both must come from the same function. Every visibility bug this project has
found came from a second implementation of a rule that already existed.

**Not modelled:** DMOJ's `pre_registered` branch keys off `real_start` falling
on 1970-01-01, a sentinel DuckOJ has no concept of and no fixture exercises.
Omitted deliberately rather than half-ported.

## 4. Shape

`ContestFormat` gains an optional second argument:

```ts
export type FormatSemantics = 'duckoj' | 'dmojCompat';
export type ContestFormat = (input: ContestInput, semantics?: FormatSemantics) => Scoreboard;
```

**`duckoj` is the default**, so production cannot select the buggy path by
forgetting an argument, and `dmojCompat` is named in exactly one place: the
golden suite. `lower()` applies DIV-1; `default.ts` branches for DIV-2. No
format grows a second copy of any arithmetic.

## 5. Testing

The whole verification rests on the divergence being **measured**, not asserted.

1. **Run both registries over all 23 goldens and diff.** Every golden that
   differs must be attributable to a named divergence, and every divergence
   must produce at least one differing golden. An unexplained diff is a bug; a
   divergence that changes no golden is a fix nobody can observe.
2. **`dmojCompat` still reproduces all 23 byte-for-byte.** This is what keeps
   the goldens meaningful after the split.
3. **DIV-1 by an independent derivation, not a transcribed scoreboard.**
   Assert `duckoj(x)` deep-equals `dmojCompat(stripOutOfWindow(x))`, where the
   strip is written test-locally from §3's table. Two independent derivations
   agreeing is evidence; a hand-copied expected scoreboard is a typo waiting to
   pass. Do **not** implement DIV-1 as that same wrapper, or the test becomes a
   tautology.
4. **Non-vacuity, named.** `icpc/03`: the entrant 60 seconds late loses the
   solve. `default/03`: the 90-minutes-late accept stops scoring. Asserted by
   name with the expected drop, not merely covered by the sweep.
5. **The at-deadline submission still counts** — the inclusivity edge of §3.
6. **All three `05-virtual-participation` goldens are unchanged** under both
   registries. This is DIV-1's regression test against its own trap.
7. **Spectators do not throw** and take the contest window.
8. **DIV-2 changes cumtime and not score**, on `default/06-zero-after-accept`.
   Compare whole scoreboards modulo nothing; if `submission_count` moves, DIV-2
   has been implemented as a filter, which is wrong — the junk submission was
   still submitted.
9. Every test demonstrated to fail against unfixed code.

## 6. The integration edge

**4c's golden replay compares service output against `scoreboard.json`, and
that comparison breaks for every divergent golden the moment production flips.**
The tempting repair is editing the fixtures, which destroys the provenance that
makes them worth having.

Instead: the replay's stated purpose is proving *the mapping* produces correct
format input. So it compares service output against
`computeContestScoreboard(contest.json)` — the same input through the same
production semantics, differing only in whether it travelled through Postgres.
Byte-level golden pinning stays in 4b's `dmojCompat` suite, which is where it
belongs. **No fixture under `fixtures/contest-goldens/` is modified.**

## 7. Deferred

**Refusing an out-of-window submission at the door** is the real fix; DIV-1 is
the scoreboard's backstop. It belongs with contest submission routing (4d),
which is where a submission first learns which contest it is in. Recorded here
so the backstop is not mistaken for the whole job.
