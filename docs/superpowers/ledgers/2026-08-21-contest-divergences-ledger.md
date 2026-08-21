# Contest divergences — ledger

**Spec:** `docs/superpowers/specs/2026-08-21-contest-divergences-design.md`
**Trigger:** user ruling, *"should not inherit bugs"*, answering the product
question 4b's design §5 deliberately deferred.

**Result:** 669 tests green (was 596). All 23 goldens still reproduce
byte-for-byte under `dmojCompat`. No fixture was modified.

---

## R1 — the divergence list is closed at two

**DIV-1**: a submission outside its participation's window does not count.
**DIV-2**: `default` times a problem by its best submission, earliest among
ties, not by its last.

`icpc`'s minute flooring, `ioi16` reading `SubmissionTestCase` rather than
`ContestSubmission.points`, `legacy_ioi`'s config-gated cumtime and `default`'s
always-zero tiebreaker are **design, not defects**, and stay. A divergence list
that grows during implementation stops being a fix and becomes a rewrite.

**Cost if wrong:** a genuine third bug ships. Cheap to add later; each addition
is one entry in `DIVERGENT` plus its evidence.

## R2 — the window was read from source, not reconstructed

`ContestParticipation.end_time` in `judge/models/contest.py`, not from memory:
spectator → contest end; virtual → `real_start + (time_limit ?? duration)`;
live → contest end, or `min(real_start + time_limit, contest end)`.

Two edges that a plausible implementation gets wrong:

**A virtual participation legitimately outlives the contest.** In all three
`05-virtual-participation` goldens the virtual entrant submits *six hours after*
`contest.end_time`, inside her own five-hour window. A filter written against
`contest.end_time` — the obvious reading of "submissions after the contest end
should not count" — would have voided her. That is a new bug traded for an old
one, and it is why DIV-1's window is per-participation.

**The window end is inclusive.** `Contest.ended` is `end_time < now`, strictly
after. `icpc/03-deadline-boundary` contains a submission stamped at exactly
`14:00:00Z` against a `14:00:00Z` deadline; it must keep counting. Getting this
wrong voids a legitimate solve, which is worse than the bug being fixed.

**Omitted deliberately:** DMOJ's `pre_registered` branch keys off `real_start`
landing on 1970-01-01, a sentinel DuckOJ has no concept of and no fixture
exercises. Not half-ported.

## R3 — one window helper, not two

`lower.ts` already derived `ContestParticipation.start`. Rather than add an end
rule next to it, both moved into `window.ts` and `lower.ts` imports them.

Every visibility bug this project has found came from a second implementation of
a rule that already existed, and this is the same shape: two derivations of
"when does this participation end" that agree until one is edited.

## R4 — `duckoj` is the default; `dmojCompat` is named once

`computeContestScoreboard(input)` computes DuckOJ semantics. Production cannot
select the buggy path by forgetting an argument, and `dmojCompat` appears in
exactly one non-test place — the type that defines it.

## R5 — the divergence set was measured, and my prediction was wrong

I predicted three goldens would change. **Four do.** `default/01-nobody-solves`
also moves: nobody scores, so every submission ties at zero and DIV-2 takes the
earliest, changing the `format_data.time` a scoreboard displays. Cumtime is
unaffected — an unscored problem contributes none.

I did not derive this. I ran both registries over all 23 and diffed, after the
advisor pointed out that "three goldens" was a hypothesis. This is the fourth
time in this project that reasoning about behaviour has lost to measuring it.

Kept without a special case: `legacy_ioi` already breaks ties by `Min(date)`,
and "time the best submission, earliest among ties" with no exception for
all-zero is one fewer rule to get wrong.

**The test asserts both directions** — no golden differs without a named
divergence, and no named divergence changes nothing. A fix nobody can observe
is the failure mode this project shipped once already.

## R6 — `submission_count` moves under DIV-1 and not under DIV-2

DIV-1 drops the row: a submission outside the window is not a contest
submission at all, and once 4d refuses it at the door it will not exist.

DIV-2 keeps it: the junk submission *was* submitted, and dropping it would be
implementing an arithmetic change as a filter. This is pinned by a test, because
the wrong shape produces the right cumtime and is otherwise invisible.

## R7 — 4c's golden replay compares against production, and no fixture was edited

The replay compared service output against `scoreboard.json`, which four
goldens no longer describe. The tempting repair is editing the fixtures, which
destroys the provenance that makes the corpus worth having.

Instead it now compares against `computeContestScoreboard(contest.json)` — the
same input, the same formats, differing only in whether it travelled through
Postgres. That is what the replay was always for: 4c's design §2 says its job is
proving *the mapping*. Byte-level pinning stays in `contest-formats`'
`dmojCompat` suite.

`contest-regrade-attempt.spec.ts` had the same hidden coupling on
`default/02-score-tie`. That fixture is not divergent, so it passed either way —
decoupled anyway, because depending on it is depending on a coincidence.

## R8 — mutation evidence

Every test demonstrated to fail against broken code:

| Mutation | Result |
|---|---|
| M1 window end exclusive (`<=` → `<`) | 2 fail — the at-deadline solve is voided |
| M2 virtual window taken from contest end | 6 fail — all three virtual goldens |
| M3 DIV-2 reverted to last submission | 5 fail |
| M4 DIV-1 disabled | 7 fail |
| M5 DIV-2 implemented by dropping rows | 7 fail |

A sixth check was added after review: the window is also asserted by *counting*
the submissions each participation keeps, against an independently stripped
input. The obvious form — `duckoj(x)` against `duckoj(strip(x))` — was tried
first and **rejected**, because the implementation's own filter runs on both
sides, so a too-narrow window agrees with itself and the assertion passes. It
was written, mutated, observed to stay green under M1, and replaced. Counting
rows catches the window being too narrow *and* too wide, on every fixture
including `default`, where DIV-2 confounds the scoreboard identity.

**Two of these five mutations silently failed to apply on the first attempt**
(shell quoting, then an indentation mismatch), and each printed a full green
suite. I reported both as "not evidence" and re-ran them rather than banking the
pass. A mutation that does not apply looks exactly like a test that cannot fail.

## R9 — a scratch measurement that cried wolf

My first diff script reported `COMPAT REGRESSION` on all 23 goldens. The cause
was mine: it compared raw JSON, skipping the nine-place normalisation the
generator applied. The real harness showed all 23 still byte-identical.

Recorded because the failure mode is general — a hand-rolled comparison that
omits the corpus's own normalisation manufactures differences, and a less
careful reading of that output would have concluded the change broke everything.

## Deferred

**Refusing an out-of-window submission at the door** is the real fix; DIV-1 is
the scoreboard's backstop. It belongs with contest submission routing (4d),
where a submission first learns which contest it is in.
