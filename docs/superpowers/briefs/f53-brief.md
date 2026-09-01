# F-53 — The same ruling, on the rosters that carry the same risk

## Why this slot

F-52 ruled on `GET /users` and shipped it: the directory needs an actor, and
the **walk** — a request carrying a cursor — is metered per user id, never per
address, because thirty pupils behind one school NAT must not lock each other
out. Read `docs/superpowers/briefs/f52-report.md` and **D188** first; this
slot applies that ruling, it does not re-argue it.

F-52 measured two neighbours and deliberately left them. The controller
re-measured the sharper one against the live host after deploying:

```
GET /api/v1/orgs/probe-org/members?limit=100      (no cookie, no token)
→ 200, items carry username, displayName, role, joinedAt
```

A **public** school's roster is an anonymous download. On this host that org
holds two accounts; F-52 walked **80 distinct pupils in 27 anonymous
requests** across the public orgs that exist today, and the contract
advertises rosters of 5,000. D185 gave it a search, so a stranger can now also
ask it for names.

`GET /contests` is the same shape at a much smaller stake (146 rows, 2
requests) — a contest list is meant to be public, so weigh whether it needs
anything at all beyond what it has.

## What to do

**Apply D188's framework, do not invent a second one.** For each list a
stranger can walk, answer the three questions D188 answers:

- Who legitimately reads it, and from where? Enumerate the real callers before
  you gate anything — F-52's ruling turned on a caller inventory of exactly
  one, which is why it cost nothing.
- What should an anonymous caller get? A public org is *public on purpose*
  (D56 makes visibility a deliberate setting), so "require a session" may be
  the wrong answer here where it was right for `/users`. A page without a
  cursor, a smaller page, or fields trimmed to what a public page actually
  renders are all live options. Argue the one you pick.
- What is metered, and keyed on what? Reuse D188's walk meter rather than
  writing a second one, and keep its property: **never key on an address.**

**Weigh a real tension.** An org set to `public` was set that way by someone
who wanted it seen. Gating it hard would break a legitimate choice; leaving it
open publishes a list of children. Trimming the payload — a roster page that
shows who is in the school without shipping a machine-readable list of every
pupil — may serve both. That is a judgement, so make it and record it as
**D191**.

## The residual F-52 left open, and named

> a signed-in account can still harvest up to `limit` rows per distinct `q`
> without touching the walk budget.

D188 records this as open rather than closed: attributable and revocable,
which anonymous harvesting was not, and closing it costs the admin lookup its
box. Decide whether this slot closes it or leaves it. Either is defensible —
an unexamined "still open" is not.

## Prove it the way F-52 could not

F-52's 401 was proven in vitest because the edge carried the older build. The
edge now carries **`007540a`**, so you can measure the *before* against the
live host with anonymous `curl` exactly as this brief does, and your *after*
in tests. Quote both. Do not claim a live "after" you cannot run.

## Out of scope

`contestWindowOpenWhere` (D49). Registration's oracle (D26). Roster freezing
(D99). The `fe42-*` contest fixtures that grow ~1 per walk run.

## How you work

**The live stack is production**, deployed at `007540a`, CI green, seven
languages, migrations through 0047, 461 accounts.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Anonymous `curl` through
  the edge is fine and is how the measurements above were taken.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/`.
- Live rows follow **D153** naming; delete what you can when you finish.
- **Next migration is 0048** if you need one — check the journal; D133 exists
  because 0025 was skipped forever.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; Playwright
`--workers=1`; no load test. **Leave no process running** — this host is
shared with another project and orphans have cost a day of false alarms.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D191** is yours; **D192** and **D193** after it. Do not go
past D193, do not renumber.

## Report

Write `docs/superpowers/briefs/f53-report.md`: the caller inventory per list,
the ruling and what it costs a legitimate reader, the before/after
measurements with the anonymous ones taken live, and your verdict on F-52's
residual. Return only: status, commits, the real `N passed` line, and what you
could not finish.
