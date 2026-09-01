# F-51 — Finding a person, and a school

## Why this slot

F-49 swept nineteen lists; F-50 fixed eight items. Three findings were named
and deliberately left, and they are the ones that stop being about pagination
and start being about **search**. Read `docs/superpowers/briefs/f49-report.md`
and `f50-report.md` first, plus **D177–D182**.

### 1. The search that exists and nobody calls

`GET /users?q=` is **fully built server-side and has zero callers.** Meanwhile
an org roster of 5,000 pupils is two hundred presses of "load more".

That is the shape of a province: one school, many classes, thousands of
accounts. A teacher looking for *Nguyễn Văn An* should type a name, not page.

Wire it. Find every surface where a person is chosen or looked up — the org
roster, the team form's member entry, contest participant management, the
admin user list — and decide for each whether search belongs there. Where it
does, use the endpoint that exists rather than adding a second one; if the
endpoint is missing something a surface needs (a filter to one org, say), say
so and extend it deliberately.

**Vietnamese names are the hard part and the point.** Test with real
diacritics. Decide, and record, whether a teacher typing `nguyen` should find
`Nguyễn` — unaccented search over accented data is how Vietnamese users
actually type, and getting it wrong makes the feature useless to the people it
is for. Whatever you decide, prove it with a test that contains real
Vietnamese names, not ASCII placeholders.

### 2. `GET /orgs` is ordered by id and read by name

F-49 calls this "the one list whose reader's order genuinely is not the served
order". A province's schools are looked up by name; they are served oldest
first. F-50 left it because it needs a second cursor grammar over
`organizations.slug` rather than an id.

Do it properly: a keyset cursor over a non-unique or textual column needs a
tiebreak or it can skip and repeat rows. D177's test reds three ways,
including a mismatched seek — copy that discipline exactly.

### 3. Two silent caps (D178)

`progress.tsx` stops at 100 rating events and says nothing; notifications stop
at 50 and say nothing. A cap a reader cannot see is a lie of omission. Either
page them or tell the reader they are looking at a window — argue which, per
list, from who reads it.

## A closing item, since you will be in that org anyway

`fe42-truong` on the live host now holds **30 teams and grows by two every
time the organiser walk runs**, because journey 2 seats its Alpha and Bravo
pairs in a contest and D101 rightly refuses to delete a team that competed.
The walk already deletes what it can (`test.afterAll`).

Fix the accumulation at its source rather than by deleting rows: a walk that
seats teams in a contest should use fixtures it can afford to leave, or an org
it owns for that run. Decide which, keeping in mind that a per-run org trades
team accumulation for org accumulation unless the org itself is cleaned up.
This host is handed to a province eventually and D153's inventory is what
they will read.

## Out of scope

`contestWindowOpenWhere` (D49). Registration's account-existence oracle (D26).
Roster freezing (D99). Do not start any of them.

## How you work

**The live stack is production**, deployed at `b8701f4`, CI green, seven
languages, migrations through 0046. The edge carries the current bundle, so
**Playwright can prove your work green**.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Scratch databases are
  yours — and are how you answer "does this search still work at 5,000
  pupils", since the live host has 431 users.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/`.
- Live rows follow **D153** naming; delete what you can when you finish.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; Playwright
`--workers=1`; one container-backed spec at a time; no load test. **Leave no
process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D185** is yours; **D186** and **D187** after it. Do not go
past D187, do not renumber.

## Report

Write `docs/superpowers/briefs/f51-report.md`: the surfaces you gave search
and the ones you did not, the diacritics ruling with the test that proves it,
the cursor grammar for `GET /orgs`, and what you did about the fixtures.
Return only: status, commits, the real `N passed` line, and what you could not
finish.
