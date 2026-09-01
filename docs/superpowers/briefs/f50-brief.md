# F-50 — The six lists that cannot reach page two

## Why this slot

F-49 swept nineteen paginated lists and gave each a number. It fixed one end
to end and **indicted six more with the same defect**, deferring them by the
brief's own scope rule. Read `docs/superpowers/briefs/f49-report.md` and
decisions **D177**, **D178** and **D179** first — the counts and the live
figures are all there, and this brief will not repeat them.

The defect is not pagination. Every one of these endpoints paginates correctly
and returns a `nextCursor`. **The screens throw it away.** A reader sees page
one and has no way to reach page two, so the list is silently truncated at the
page size and nothing on screen says so.

D177 fixed `OrgTeams` — a live school already had **46 teams and showed the
oldest 25**, with no last page to reach. These six are the same shape.

## The work, worst first

D178 ranks them. Take them in that order, because the first one is different
in kind:

1. **`admin.tsx` `RateContests` — this one blocks a write.** An administrator
   cannot rate contest #26 of 167. Every other item here withholds a *read*;
   this one makes an operator unable to do their job, and `limit=100` does not
   save it. Fix it first and say in your report what an operator had to do
   instead until now.
2. `contests.tsx` — 142 rounds unreachable, and `phase=active` is never asked
   for even though D151 built it.
3. `orgs.tsx` `OrgsPage` — 3 of 28 schools already unreachable **on the live
   host today**.
4. `OrgContests`, `OrgSets`, and the org picker at 101.

`OrgTeams` is the worked example: `useInfiniteQuery` plus the existing
`common.loadMore` string. Reuse that pattern rather than inventing a second
one, and reuse the string rather than adding a seventh spelling of "load
more". Where a list is better served by a filter than by paging — D178 notes
`contests.tsx` never asks for `phase=active` — say so and do the smaller
thing.

**Ordering is a separate question from reachability.** D177 changed the teams
order because a teacher needs the newest first. Do not reorder these six by
reflex: for each, say who reads it and what order they need, and change the
order only where you can name the reader. An admin rating contests probably
wants oldest-unrated first. Where you do change an order, the cursor must move
with it — D177's own test reds three ways, including a mismatched seek that
silently truncates the walk; copy that discipline.

## The unbounded one (D179)

`GET /orgs/{slug}/requests` has **no limit, no cursor, no parameters at all** —
5,000 pending join requests is a 219 kB response and 5,000 table rows. The
statement itself is healthy; this is a missing bound, not an index.

Add the bound. **Keep the FIFO order** — a join request queue is answered
oldest first and that is the reader's need. Adding a cursor changes the
contract, so regenerate `openapi.json` and the SDK, and check no caller
depends on receiving everything in one response.

## The N+1 (D178's second item)

F-49 measured the teams panel: **one screen is 26 requests and 181 statements,
≈20 ms**, against **one statement at 0.175 ms** if the summary carried the
names. The existing comment in `team.access.ts` argues against widening — F-49
concluded that comment is **wrong on its own terms**, because each of the 25
detail responses also ships a `contests` array and a D176 `version` token the
panel discards.

Widen the summary. Blast radius is three schemas and no scoreboard shape, per
F-49. **Then fix the comment**, which currently explains why not to do the
thing you just did — a stale comment justifying the old design is how the next
reader gets misled.

## Out of scope

`contestWindowOpenWhere` (D49). Registration's oracle (D26). Roster freezing
(D99). The `GET /users?q=` search box F-49 found built with zero callers — it
is a real gap, it is a bigger feature, and it is not this slot.

## How you work

**The live stack is production**, deployed at `5150b08`, CI green, seven
languages live, migrations through 0046. The teams fix IS deployed, so
Playwright can prove your work green against the edge — unlike F-49, which
could not.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Scratch databases are
  yours to create and drop.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/`.
- Live rows follow **D153** naming; delete what you can when you finish —
  `test.afterAll` in `apps/web/e2e/organiser.spec.ts` is the pattern, comment
  included.

**Read `CLAUDE.md`** before you finish. Run the **full suite of every package
you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; one container-backed
spec at a time; no load test. **Leave no process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D180** is yours; **D181** and **D182** after it. Do not go
past D182, do not renumber.

## Report

Write `docs/superpowers/briefs/f50-report.md`. Return only: status, commits,
the real `N passed` line, which of the seven items you closed and which you
did not, and what you could not finish.
