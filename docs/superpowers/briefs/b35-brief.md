# B-35 — Hunt the gates and the derived column

Six slots have shipped in quick succession into two areas that reward an
adversarial pass more than most: **authorisation** (F-52, F-53 — who may
enumerate a school's children) and **derived state maintained by triggers**
(F-54 — a column that must stay true or the wrong people see the wrong rows).

Read `docs/superpowers/briefs/f52-report.md`, `f53-report.md` and
`f54-report.md` first, plus **D188, D191, D192, D194**, and the diffs of
`3ad6cd2`, `3c3ff10`, `6a3069a`, `7ed0a90`, `9fe461c`.

Two precedents say where the yield is. **B-32** found a derived column whose
one writer picked a different attempt than its three readers — by enumerating
writers against readers, not by finding a wrong row. **B-33** found a real
data-loss defect by capturing the actual request bytes rather than reading the
code. Use both methods.

## 1. The gates (D188, D191, D192)

`GET /users` needs an actor. A public org's roster answers one page to a
stranger and refuses `cursor` and `q`. Members and global admins are exempt
from the walk meter. The meter keys on `user:<id>`, deliberately never on an
address.

Attack all of it:

- **Is there another way to the same rows?** The MCP server, the `oj` CLI, the
  scoreboard, contest participants, a team's own page, submissions, comments,
  notifications, the monitor feed — any of them may name pupils. A gate on one
  route that a second route serves around is not a gate. **This is the highest
  value item in the slot.**
- **Are the exemptions right?** "Member of the org" and "global admin" — check
  what a member of one org can read about another, and whether org membership
  is verified against the org being read rather than any org at all.
- **Is the meter sound?** It is per user id across four API workers, so its
  state is shared — check it actually is. What happens on a token rather than
  a session? What does a caller with several tokens get? Can a request be
  shaped so the meter never sees it (a limit that returns everything, a
  filter that pages implicitly, a route that forwards)?
- **Does the 401/422/429 ordering hold everywhere it was ruled?** F-53 pinned
  anonymous → 401 before the cursor is parsed, and signed-in → 422 before 429.
  Check the neighbours it did not touch.
- **D192 left one thing open on purpose**: a signed-in account can harvest a
  page per distinct `q` without spending walk budget. Do not close it — that
  is ruled. **Measure it**: how many distinct pupils can one ordinary account
  actually collect in an hour, on this host's data? A number turns a ruling
  into an informed one.

## 2. The derived column (D194)

`contest_participations.ends_at` is new, backfilled, indexed, and maintained
by **two triggers**. Every route that decides who may see a submission now
depends on it being true.

- **Enumerate every writer of a participation or a contest window**, and check
  each maintains `ends_at`: joining, virtual participation, a contest whose
  times are edited after the gun (D28 permits some edits), a contest deleted
  or restored, a team seat, a disqualification, an import, a rejudge, anything
  in `scripts/`. A path that forgets does not fail — it serves the wrong rows.
- **Verify the live data independently**, the way B-32 did: recompute
  `ends_at` from `contests` for all 333 live participations and compare. It is
  cheap, it is read-only, and a disagreement is a live visibility bug today.
- **Does the trigger survive a bulk update?** A statement-level path, a
  `COPY`, a migration that touches `contests` — say which of these the
  triggers cover and which they do not.
- Consider adding the check to `scripts/integrity-check.ts`, which already
  audits the F-45 summary for exactly this reason (D168).

## What a finished slot looks like

Depth over breadth. Three real findings with reproductions beat twenty
observations. **A clean result is valid and must show its work** — the
writer/reader table, the routes you tried against the gate, the live
recomputation with its counts. On authorisation code an unsupported all-clear
is worse than useless.

Rank findings by what a person experiences: a pupil's name reaching someone
who should not have it outranks everything else here.

## How you work

**The live stack is production**, deployed at `eef05c1`, CI green, seven
languages, migrations through 0048, 461 accounts, 333 participations.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Scratch databases are
  yours. Anonymous `curl` through the edge is fine and is how the gates were
  measured.
- **Never** write to `apps/web/dist`. **Do not run the web build.** The edge
  carries the current bundle, so a browser walk is an honest instrument.
- **Never** read, print or commit anything from `.secrets/` — parse it by
  username to authenticate, never echo it.
- Live rows follow **D153** naming; delete what you can when you finish.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; Playwright
`--workers=1`; one container-backed spec at a time; no load test. **Leave no
process running** — this host is shared with another project.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D195** is yours; **D196** and **D197** after it. Do not go
past D197, do not renumber.

## Report

Write `docs/superpowers/briefs/b35-report.md`: the route inventory against the
gate, the writer/reader table for `ends_at`, the live recomputation with
counts, the harvest number, and every defect with its reproduction and
red-test output. Return only: status, commits, the real `N passed` line,
defect count by severity, and what you could not finish.
