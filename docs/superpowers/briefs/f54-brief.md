# F-54 — The predicate that grows with the season

## Why this slot

F-44 measured six contest-morning routes against real query plans and closed
what it could. F-45 removed the one hazard it found. **One item has been open
since then, named in D163/D164 and deferred twice on purpose**, and it is now
the last measured performance defect in the system:

> `contestWindowOpenWhere` (D49) — it becomes a **Hash Anti Join** over the
> *whole* of `contest_submissions ⋈ contest_participations ⋈ contests` on
> **five hot statements**, growing with **lifetime** contest activity.

Read `docs/superpowers/briefs/f44-report.md` and `f45-report.md` first, and
D163, D164, D49 and D25.

**Why it was left, and why that reasoning does not close it.** F-44 tried the
obvious rewrite — pushing the implied bound into the join — and reported it
does not remove the scans: the plans show that filter already running *after*
the join, and a **virtual participation legitimately outlives its contest's
`end_time`**, so the bound is not sound as stated. It also noted the predicate
is pinned by `submission-freeze.spec.ts`'s agreement test, which is a feature:
whatever you do must keep that agreement exactly.

Deferring it twice was right — neither slot could close it honestly. This slot
exists to close it or to prove it cannot be closed cheaply, with evidence
either way.

## What "growing with lifetime activity" means for a province

The live host has 880-odd submissions. A province runs weekly rounds for a
school year. This predicate does not care how many contests are *running* — it
scans what has *ever* happened. That is the shape that is fine all autumn and
a problem in May, which is exactly the kind of defect nobody catches in
rehearsal.

Put a number on it. F-44 built a **200,880-submission scratch copy** and its
report says how; reuse that method rather than inventing one. Answer: at what
lifetime activity do these five statements stop being acceptable, and what
does the plan look like on either side of that line?

## The work

1. **Understand what the predicate is actually for.** It decides a window
   question — who may see what, and when — and D49, D22/D23 and the virtual
   participation rule all bear on it. Write down the invariant in one
   sentence before you touch a query. A faster predicate that answers a
   slightly different question is the D36 class, and D36 bricked a contest.
2. **Find the shape that is both sound and sargable.** Options worth weighing:
   an index that makes the anti-join cheap rather than removing it; a
   materialised or maintained column that answers the window directly; a
   different join order; narrowing what the anti-join ranges over. F-44
   refused three indexes with plans — read those refusals before proposing a
   fourth.
3. **Keep the agreement.** `submission-freeze.spec.ts` asserts two forms of
   this predicate agree. If your change makes that test pass for a new reason,
   say so explicitly — a green test that no longer tests what it named is
   worse than a red one.
4. **If it cannot be closed cheaply, say that with the numbers** and propose
   what would close it, sized. That is a valid and useful outcome; an
   unsupported "it is fine" is not.

Record the ruling as **D194**.

## Out of scope

Registration's oracle (D26). Roster freezing (D99). F-52's signed-in search
residual (D192 ruled it open on purpose). The `fe42-*` fixtures.

## How you work

**The live stack is production**, deployed at `a9c83fc`, CI green at
`bf2023a`, seven languages, migrations through 0047.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Scratch databases are
  yours to create and drop, and are how the province-scale numbers get made.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/`.
- **Next migration is 0048** — check the journal; D133 exists because 0025 was
  skipped forever. If you add an index on a live-sized table, say what it
  locks and for how long, the way F-51 did for 0047.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch** — the
last two slots each had the full run catch what targeted runs missed.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; one container-backed
spec at a time; **no load test**. Building a large scratch database is itself
hot work — do it once and reuse it. **Leave no process running**; this host is
shared with another project and an orphaned benchmark once held it at 94 °C
for fifty minutes.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D194** is yours; **D195** and **D196** after it. Do not go
past D196, do not renumber.

## Report

Write `docs/superpowers/briefs/f54-report.md`: the invariant in one sentence,
the five statements with plans before and after, the lifetime-activity number
at which the old shape fails, and what you rejected with why. Return only:
status, commits, the real `N passed` line, the measured shape change, and what
you could not finish.
