# Phase 4a — Contest format goldens: design

**Status:** approved for implementation.
**Predecessors:** `2026-08-17-foundation-design.md` §"Contest formats".

---

## 1. A correction to the foundation spec, and why it changes this phase

The foundation spec says:

> The contest formats are the highest silent-failure risk in the system and
> **they cannot be ported** — DMOJ's implementations are entangled with raw SQL
> and Django template rendering.

I read the code. **That is overstated**, and the difference matters:

| Format | Lines | Raw SQL | Notes |
|---|---|---|---|
| `default` | 116 | **none** | Pure ORM aggregation |
| `icpc` | 285 | **one block** (`icpc.py:69-85`) | A single `connection.cursor()` for per-problem attempt counts |
| `ioi16` | 52 | none | Subclasses `legacy_ioi`; needs per-batch best scores |
| `legacy_ioi` | 162 | none | Pure ORM |

615 lines across the four, of which one block is raw SQL. The `format_html`
calls in three of them are **display** code — they render a scoreboard cell,
they do not compute it. Every score, penalty and tiebreak value comes from
`update_participation`, which is readable Python.

**So the position is better than the spec assumed: these formats can be read
and ported.** The goldens are still worth building — but as *verification of a
reading*, not as a black box we reverse-engineer. Porting-with-verification is
a materially stronger position than reverse-engineering, and it means a golden
mismatch will point at a specific line rather than an unknown.

This is the fourth time a claim in this project's own documentation has turned
out to be broader than the facts. Recorded here so Phase 4b starts from what
the code says.

## 2. What this phase produces

**Only test fixtures. No product code.** A directory of golden scoreboards, and
a documented, repeatable way to regenerate them.

```
fixtures/contest-goldens/
  <format>/<scenario>/
    contest.json        the inputs: problems, participants, submissions, timings
    scoreboard.json     the frozen output: per-participant score, cumtime,
                        tiebreaker, format_data, and the ranked order
    PROVENANCE.md       the exact commit of online-judge, the command, the date
```

Phase 4b implements the formats against these. If our implementation disagrees
with a golden, one of them is wrong and both are inspectable.

## 3. Feasibility, checked rather than assumed

The old application needs **Django 5.1 and SQLite** — `dmoj/settings.py:658`
defaults to `django.db.backends.sqlite3`. This is not a decade-old stack
needing MySQL and Python 2; it is a current Django on a file database.

That makes the harness a container that installs `requirements.txt`, runs
`migrate` against a temporary SQLite file, loads a fixture, and prints JSON.
No database server, no persistent state, nothing to clean up.

## 4. Scenarios

Four formats × the situations where implementations actually disagree. Every
scenario must be one where a naive reimplementation plausibly differs — a
scenario both implementations obviously agree on tests nothing.

**Shared across formats**
1. **Nobody solves anything** — all zeros, and the *ordering* of equal rows.
2. **A tie on score** — does the format break it, and by what?
3. **A submission exactly at the deadline**, and one a second after.
4. **A participant who joins late** — `participation.start` differs, so every
   relative time does.
5. **A virtual participation** alongside live ones — `default` excludes virtuals
   from first-solve, and a reimplementation will forget.

**`icpc` specifically**
6. **Wrong answers before an accept** — the penalty is per-attempt-before-solve
   and this is where every ICPC implementation disagrees.
7. **Wrong answers after an accept** — must *not* add penalty.
8. **A problem solved by nobody** — no first-solve, and `total_ac` zero.

**`ioi16` / `legacy_ioi` specifically**
9. **Partial subtasks across multiple submissions** — the score is the best
   *per batch*, summed, not the best submission. A reimplementation that takes
   the max submission score is wrong and will pass every other scenario.
10. **`points_scaling_factor` other than 1** — `ioi.py` multiplies each batch by
    it before summing.
11. **A batch with no points at all** vs a batch scoring zero.

Scenario 9 is the single most valuable one in this list: it is the difference
between "best submission" and "best per subtask", it is invisible in any
scenario with one submission per problem, and DuckOJ already stores what it
needs — `submission_cases.groupIndex` is DMOJ's `batch`.

## 5. What DuckOJ already has, and the one gap

| The formats need | DuckOJ has |
|---|---|
| Per-problem best points | `submissions.points` |
| Per-batch points | `submission_cases.groupIndex` + `.points` |
| Submission time relative to a start | `submissions.createdAt` |
| Attempts before first accept (icpc) | derivable from `submissions` |
| Points scaling per contest problem | **nothing — no contest tables exist yet** |

Contest tables are Phase 4b's job. This phase does not create them; it only
freezes what the old system produces, so 4b has something to build against.

## 6. Testing

The harness itself needs to be trustworthy, so:

1. **A golden must be reproducible.** Running the generator twice on the same
   fixture must produce byte-identical `scoreboard.json`. If it does not,
   something non-deterministic (a timestamp, a dict ordering) is leaking into
   the output and every later comparison is noise.
2. **A golden must be sensitive.** Deliberately perturb one input — move a
   submission one second later — and the output must change. A golden that is
   identical under a changed input is measuring nothing.
3. **`PROVENANCE.md` records the exact `online-judge` commit.** A golden whose
   source revision is unknown cannot be re-derived and is worthless the first
   time someone disputes it.

## 7. Risks

**The old app may not install cleanly.** `requirements.txt` pins ranges, not
exact versions, so a fresh resolve today may differ from what the fork ran
with. If it does not install, that is a finding to report, not something to
force — and the fallback is reading the 615 lines and writing the goldens by
hand from them, which is slower but not blocked.

**Non-determinism in the output.** `format_data` is a dict; JSON key order and
float formatting must be normalised or §6.1 will fail for cosmetic reasons.

**Scope creep into 4b.** It will be tempting to start modelling contests while
the old app is up. Do not. This phase's deliverable is JSON files.
