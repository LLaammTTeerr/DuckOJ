# F-41 — The language limits become editable, safely, and a stuck submission says so

Two slots and a hunt have now built the per-language limit system and proved
it live. Three things they each deferred are the same thing, and this slot
closes them together.

Read `docs/superpowers/briefs/f39-report.md` and `b30-report.md` first, and
D154 (the limit arithmetic), D68 (`blocked_reason`) and D153 (what a test
artefact is) in `docs/DECISIONS.md`.

## 1. The override has no form

`problem_language_limits` exists, is enforced, is on the contract, and is
read correctly. A setter who wants "Python gets no bonus on this problem" or
"this problem is not solvable in Python" must write SQL against production.

Build the authoring surface, on the problem edit screen, in both languages
(D18). It edits three things per language: the time multiplier, the memory
addend, and whether the language is allowed at all.

Two things it must get right, because they are what the data model already
promises and a form is where promises get broken:

- **Null is not zero.** Both numeric columns are nullable and inherit
  **column by column** from the language default — a row that pins the time
  and says nothing about memory keeps the interpreter floor. The form needs
  a real "inherit" state distinct from a typed value, and clearing a field
  must store null rather than 0.
- **Refusing a language is not a limit of zero.** `allowed = false` is a
  404 at submit time (D154). The form says "not allowed", never "0 ms".

Show the *resulting* limits beside the inputs, computed the same way the
submit page computes them, so a setter sees what a pupil will see.

## 2. `0` is still reachable, and it is the exact lie D154 forbids

B-30 found there is no `CHECK` on `time_multiplier_pct`. An operator typo of
`0` yields `timeMs: 0` — every submission in that language TLEs instantly,
which is D154's "refusal presented as a TLE, teaching the pupil their correct
program was too slow", arrived at by accident instead of by design.

Add the database constraint. Decide the floor and the ceiling and justify
both: a multiplier of 1 % is as broken as 0, and an unbounded ceiling is a
denial-of-service on a province's single judge. Do the same for the memory
addend. The migration must be **idempotent** and must not fail on the live
data, which you should check first with a read-only query.

The form validates the same bounds, with the message in both languages, and
the API rejects them independently of the form — three layers, because the
form is not the only way in.

## 3. A pupil whose language nothing can grade waits forever

D68 gives a job a `blocked_reason`, and B-30 found it is **admin-only**. A
submission whose language no connected judge announces sits at `queued` with
nothing on screen ever explaining why. On today's fleet this is unreachable —
every seeded language maps to an executor the one judge announces — but it
becomes reachable the moment a province adds a language, narrows
`--only-executors`, or runs a judge that is still coming up.

Make the pupil's view honest. What exactly to say is your call: it must not
leak fleet topology or anything about other users, and it must not read as
the pupil's fault. "Waiting for a judge that can run Python" is true and
useful; the internal reason string is not necessarily either.

Weigh whether a submission that can never be graded should stay queued at
all, or reach a terminal state. Argue it and record it.

## Out of scope

Syntax highlighting on the submission detail page (F-39's other residual) —
it is unrelated work and belongs in its own slot. Do not start it.

## How you work

**The live stack is production**, deployed at `322681c`, six containers
healthy, five languages live.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`. Only the controller deploys. Read the live database
  with `podman exec duckoj_postgres_1 psql -U duckoj -d duckoj -c '<SELECT>'`
  — **reads only**. `curl http://localhost:8080/...` is fine; live rows you
  create must follow D153's test-artefact naming.
- **Never** write to `apps/web/dist` — Caddy bind-mounts it.
- **Never** read, print or commit anything from `.secrets/`.
- **The next migration number is 0043.** Check the journal before you write
  it; migration 0025 was skipped forever once, and D133 exists because of it.

**Thermal caps** (93 °C incident on this host):
- Every command under `nice -n 19`; vitest always `--no-file-parallelism`.
- Run the specs you touch, never the whole workspace suite.
- Never a container-backed spec alongside another suite.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.
Typecheck passing is not lint passing.

**Tests**: every test demonstrated **red** against deliberately broken code
first, with the real failure output in your report.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D159** is yours; **D160** and **D161** if needed. Do not go
past D161, do not renumber.

## Report

Write `docs/superpowers/briefs/f41-report.md`. Return only: status, commits,
one line of real test output (the actual `N passed` line, never a bare exit
code), and what you could not finish. If a claim here is wrong when you
check it, say so.
