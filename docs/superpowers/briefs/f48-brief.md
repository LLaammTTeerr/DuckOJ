# F-48 — Finish applying two rulings that were only applied where they were found

Two decisions this campaign made are correct and partially applied. Both were
scoped to the place the defect was *found*, not to everywhere the reasoning
holds. That is the honest way to ship a fix under time pressure and the wrong
place to leave it.

Read `docs/superpowers/briefs/f43-report.md` and `b32-report.md` first, and
decisions **D161** and **D165/D166** in `docs/DECISIONS.md`.

## 1. D161 covers two forms; five have the shape

D161 ruled that a save declares the version it believes it is replacing, and
the server refuses a stale one under `SELECT … FOR UPDATE`. The reasoning was
not about problems and contests — it was about **any form that seeds once from
a cached query and saves by replacement**, because that combination silently
overwrites a co-editor's work with a copy the form has been holding since
before they saved. No request fails. Nobody is told.

F-43 applied it to `problem-edit` and `contest-edit`, and its report says
plainly: **"the other three seed-once forms still have no token."**

Find them. F-43's report names them; verify against the code rather than
trusting the count, because the number may have moved with F-41's
language-limits form and F-46's changes. For each one, answer in writing:

- Does it seed once from a query and save by replacement?
- Can two people plausibly hold it open at the same time? A teacher and a
  co-organiser can. A pupil editing their own account settings cannot.
- If they can, it gets the token. If they cannot, say so and leave it — and
  say what would make that stop being true.

`expectedVersion` is deliberately **optional** on the wire (F-43's residual),
so the guarantee is per-form rather than per-route. Decide whether that should
stay true once most forms carry it, and argue it. Making it required is a
breaking change for any client that has not been updated; leaving it optional
means a client that forgets is silently unprotected. Neither is obviously
right.

**The conflict message matters as much as the check.** A teacher who is
refused must understand they were refused *because someone else saved*, not
that they did something wrong, and must be able to get to the newer version
without losing what they typed. F-43 shipped that for two forms — reuse it,
do not reinvent it, and do not regress it.

## 2. B-32's O1: the write is pinned, the read is not

Migration 0045 sets `SET LOCAL extra_float_digits = 3` because at the default,
**48,861 of 50,000 values failed to round-trip** through
`to_jsonb(double precision)`. That guard is inside one migration's
transaction.

B-32 checked the doors around it and found the write path safe — drizzle's
jsonb writer is client-side `JSON.stringify`, and the migrator wraps
migrations in one transaction so `SET LOCAL` holds. Then it found the door
still open and recorded it rather than fixing it:

> the **reads** of `submission_cases.points` inherit the cluster default,
> pinned by nothing.

A province's Postgres is not this one. If its cluster default differs, a value
read back for a fold could differ in its last bits from the value the judge
wrote — a wrong scoreboard, reported as a right one, on their hardware and not
ours.

Pin it where the connection is made, not where each query is written. Prove
the pin holds across a pooled connection that has been recycled, because a
session setting that a pool resets is a pin that is not there. B-32 also
recorded **O3**: 0045's own `SET LOCAL` is asserted by no test — close that
too, since you will already have the machinery.

Record the ruling as **D175**.

## Out of scope

`contestWindowOpenWhere` (D49's anti-join). Registration's account-existence
oracle (D26). Syntax highlighting. Do not start any of them.

## How you work

**The live stack is production**, deployed at `16dd990`, CI green, seven
languages live and all seven proven grading, migrations through 0046.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Scratch databases are
  yours to create and drop.
- **Never** write to `apps/web/dist`. **Do not run the web build.** Playwright
  points at the live edge, deployed at `16dd990` — a walk can show a bug red
  but not your fix green; mark such a test clearly, as `organiser.spec.ts`
  journey 2b does.
- **Never** read, print or commit anything from `.secrets/`.
- Live rows follow **D153** naming; close what you open.

**Read `CLAUDE.md`** before you finish — it names the cross-cutting guards
that fail in CI and not locally. Run the **full suite of every package you
touch**; that rule has caught two CI reds today.

**Tests**: the stale-seed class is invisible to a test that mocks the SDK or
builds a fresh `QueryClient` per render. `apps/web/test/edit-form-stale-seed.spec.tsx`
is the shape that works — one real client, real keys, two mounts. Every test
demonstrated **red** first, with the failure output in your report.

**Thermal**: `nice -n 19` on everything; vitest `--no-file-parallelism`; one
container-backed spec at a time; no load test. **Leave no process running when
you finish** — two orphans have held this host hot today.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D175** is yours; **D176** and **D177** after it. Do not go
past D177, do not renumber.

## Report

Write `docs/superpowers/briefs/f48-report.md`: the form-by-form table with
your verdict for each, the connection-level pin and how you proved it survives
a recycled connection, and red-test output for every fix. Return only: status,
commits, the real `N passed` line, and what you could not finish.
