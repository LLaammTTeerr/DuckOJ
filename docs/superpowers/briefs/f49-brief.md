# F-49 — Lists at school scale

## The instance

Deploying F-48, the organiser browser walk went red. It looked exactly like a
regression in the roster panel it exists to guard. It was not: the walk had
created three teams per run in one shared org for a fortnight, `GET
/orgs/{slug}/teams` pages at 25, and the 27th team pushed the walk's own row
off the page it navigates to.

The test defect is fixed. The product question it exposed is not:

`apps/api/src/authz/team.access.ts:130` orders an org's teams
**`.orderBy(asc(teams.id))`** — oldest first. A teacher in a school with more
than 25 teams creates a team and it lands on the **last** page. The thing you
just made is the thing you are least likely to see.

Whether that is a defect depends on facts you must check rather than assume:
does the panel offer "load more", or is page one all a teacher ever sees? Is
there a filter or a search? A cursor-paginated list ordered by ascending id is
a perfectly sound *engineering* choice; it is the *product* consequence that
may be wrong.

## The class

One instance is a bug; the class is the slot. Sweep every paginated list an
organiser or teacher uses and answer, for each, in a table:

- What is it ordered by, and is that the order its reader needs?
- What is the page size, and does the UI let a reader reach page two at all?
- Is there a filter or search when the list outgrows a page?
- **At what count does it become unusable?** Give a number. "It paginates" is
  not an answer; "past 25 teams a teacher cannot see a team they just made"
  is.

Start with the organiser's own surfaces — teams, problem sets, org members,
the org's contests, the problem list an author browses, the admin user list,
the submissions list — and follow the shape wherever it goes. The province
this is built for has many schools, each with many classes; these lists grow
monotonically and nothing has ever been looked at past a page.

## Fix what the table indicts

Reordering a list is cheap and visible. Adding a "load more" that was never
there is a real feature. Adding search is a bigger one. Do the cheap correct
things, propose the expensive ones with a reason, and **do not** rewrite five
screens because they share a shape.

Where you change an order, say what a cursor over that order costs: a cursor
over `asc(id)` is stable and cheap; a cursor over `desc(created_at)` needs a
tiebreak or it can skip and repeat rows. Get that right — a paginated list
that drops a row is worse than one in an awkward order.

## A second, smaller item

`GET /orgs/{slug}/teams` serves a `memberCount`, and the panel fires one
detail query **per row** to show names (`team.access.ts` comments explain
why). At a page of 25 that is 25 extra requests to render one screen. Measure
it, and say whether it is fine, worth batching, or worth widening the summary
after all. The existing comment argues against widening; it may still be
right, and if so say so rather than churning it.

## Out of scope

`contestWindowOpenWhere` (D49's anti-join). Registration's account-existence
oracle (D26). Team roster freezing (D99). Do not start any of them.

## How you work

**The live stack is production**, deployed at `925f27a`, CI green, seven
languages live, migrations through 0046.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Scratch databases are
  yours to create and drop — and are the right way to answer "at what count
  does this break", since the live host has only 27 teams and 431 users.
- **Never** write to `apps/web/dist`. **Do not run the web build.** Playwright
  points at the live edge, deployed at `925f27a`; a walk can show a bug red
  but not your fix green — mark such a test clearly.
- **Never** read, print or commit anything from `.secrets/`.
- **Live rows follow D153 naming, and you delete what you can when you
  finish.** This slot exists partly because a walk did not: `test.afterAll` in
  `apps/web/e2e/organiser.spec.ts` is the pattern, including its comment about
  what cannot be deleted and why.

**Read `CLAUDE.md`** before you finish — cross-cutting guards fail in CI and
not locally. Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19` on everything; vitest `--no-file-parallelism`; one
container-backed spec at a time; no load test. **Leave no process running when
you finish** — two orphans held this host at 94 °C today.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D177** is yours; **D178** and **D179** after it. Do not go
past D179, do not renumber.

## Report

Write `docs/superpowers/briefs/f49-report.md` with the list-by-list table and
the count at which each becomes unusable. Return only: status, commits, the
real `N passed` line, the table's verdicts, and what you could not finish.
