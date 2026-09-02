# F-59 — The operator's first hour

## Why this slot

F-58 audited the handover documents and found **12 claims that were never
true**. It corrected the documents, which was its job. Two of those findings
are not documentation bugs at all — they are **tools that cannot do the thing
the documents describe**, and both sit in the first hour of a province's
deployment.

### 1. A judge's token cannot be rotated

`truoc-khi-trien-khai.md` step 1 told a province to rotate the seeded judge
credential with `judge:node revoke judge-1` then `add judge-1`. F-58 struck
the instruction because it does not work. The controller confirmed why:

```
judge:node add <name>       register a node and print its token (once)
judge:node list             every registered node, and whether it is revoked
judge:node revoke <name>    refuse the node's token, keeping its grading history
```

There is **no `rotate`**. `revoke` keeps the row on purpose — grading history
hangs off it — and `add` refuses a name that exists. So the sequence burns a
credential and then fails, and a province is left with a dead judge and no way
forward except SQL.

**This credential has been seen.** It is in this repository's history, in
`.env.example`'s shape, and on every machine that has ever run this stack. A
province that cannot rotate it is running a judge anyone who read the repo can
impersonate. Rotation is not a convenience.

Build it. Decide what `rotate` means for a node that is currently connected —
the judge holds a live bridge connection authenticated with the old token, and
D68's handshake verifies `(id, key)` against `judge_nodes`. Say what happens to
an in-flight submission, and whether the operator must restart the judge
container afterwards (they may; say so in the runbook if they do).

### 2. The smoke scripts cannot run on a default deployment

`scripts/e2e-submit.ts`, `e2e-problem.ts` and `e2e-contest.ts` are what an
operator runs to prove a fresh install works. All three:

- default `E2E_BASE_URL` to `https://localhost:8443`, which is dead on a
  default deployment (`SITE_ADDRESS=:80`; `http://localhost:8080` is the entry
  point), and
- open with an anonymous `POST /auth/register`, which D200 now refuses `403`.

F-56 and F-57 taught the Playwright walks to mint their pupils as the admin;
these three were not touched. `e2e-problem.ts` calls `fail()` on the refusal,
so the operator's first verification ends in a stack trace.

Fix them the same way the walks were fixed. They are operator tools, so they
must work with what an operator has: the admin credentials they just
bootstrapped (D19), and the URL their `.env` actually serves.

## What "done" looks like

- `judge:node` can rotate, and the runbook and `truoc-khi-trien-khai.md` say
  exactly how, with the restart requirement if there is one.
- The three scripts run against this live stack and print a real verdict. Run
  them; quote the output. They create live rows, so use **D153** naming — the
  cleaner covers `^b[0-9]+-` and `^fe[0-9]+-`.
- Tests for the rotation path demonstrated red first, including the case that
  matters: an old token stops being accepted.

## A caution specific to this slot

Rotating the live judge's token is a **change to the running fleet**, and the
brief does not authorise it: you may not restart a container, and a rotation
without the judge picking up the new token leaves this host unable to grade.
**Build and test the capability; do not rotate the live `judge-1`.** Say in
your report exactly what the controller must run, and in what order, to rotate
it safely — that sequence is the deliverable as much as the code.

## Out of scope

Roster freezing (D99). `judged.live`'s attempt keying (D29). The `open` rung's
D26 residual. Do not re-audit the documents — F-58 did that.

## How you work

**The live stack is production**, deployed at `987061b`, CI green, seven
languages, registration closed, migrations through 0049, 510 accounts.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**. **Never edit the
  live `.env`.** **Do not rotate the live judge's token.**
- Live database is **read-only** except rows the smoke scripts create by
  design; scratch databases are yours.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/` — parse it by
  username to authenticate, never echo it. A printed token is a finding
  against you.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; one container-backed
spec at a time; no load test. **Leave no process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D204** is yours; **D205** and **D206** after it. Do not go
past D206, do not renumber.

## Report

Write `docs/superpowers/briefs/f59-report.md`: what `rotate` does to a
connected judge and to an in-flight submission, the exact sequence the
controller must run to rotate `judge-1` safely, and the real output of all
three smoke scripts against the live stack. Return only: status, commits, the
real `N passed` line, and what you could not finish.
