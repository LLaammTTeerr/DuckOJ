# F-52 — The pupil directory is not a public download

## The finding

F-51 wired a name search and, while doing it, said plainly that the endpoint
it was wiring had a property nobody had decided on:

> `GET /users` was **already fully enumerable anonymously with no `q` at
> all**… this endpoint has **no rate limiter and never had one**. D16 meters
> login, D26 meters registration; neither is in this path.

The controller measured it against the live host:

```
GET /api/v1/users?limit=100        (no cookie, no token)
→ 100 items, nextCursor present
→ ten consecutive requests: 200 200 200 200 200 200 200 200 200 200
```

Five requests take all 461 accounts. Each row carries `username`,
`displayName`, `country`, `rating`, `maxRating`, `globalRole`, `createdAt`.

On this rehearsal host that is generated data. **On a province's host it is
every pupil's real name**, most of them children, downloadable by anyone who
knows the URL, with no account and no limit.

F-51 was right to flag it and right not to change it inside a search slot.
This is that slot.

## What must be decided, not assumed

A judge is a public thing. Ratings, ranks and profiles are normally visible —
that is how competitive programming works, and the D46 rank ramp and the
public profile page exist on purpose. **Individual visibility is not the
question.** Bulk enumeration is.

Work out and record, as **D188**:

- **Who legitimately needs to list users, and from where?** Enumerate the
  real callers — the person pickers F-51 just added, the admin user list, a
  scoreboard, a profile link from a submission. A caller that only ever
  resolves *one* username does not need a list at all.
- **What should an anonymous caller get?** Plausible answers include: the list
  requires a session; the list stays public but the cursor does not, so a
  stranger sees a page and cannot walk the roster; the list is scoped to an
  org for members of that org. Argue the one you pick against the others, and
  say what it costs a legitimate user.
- **What is metered, and how?** D16's meter exists and has a shape to copy.
  A meter on an anonymous endpoint keys on something; say what, and what a
  school behind one NAT address looks like to it — a whole classroom shares an
  IP, and a meter that locks out a computer room during a contest is worse
  than the problem it solves.
- **Do the fields need trimming too?** `globalRole` and `createdAt` on a
  public list are worth a sentence each.

Whatever you choose must keep D26's property: nothing may answer "does this
email have an account".

## Then do it

- Change the route, with the right marker — deny-by-default, exactly one
  marker, 404 not 403 for a read you may not see.
- **Check every caller before you change it.** F-51 added person pickers to
  three screens and the org roster; the MCP server and the `oj` CLI may also
  call it. A change that silently breaks a picker a teacher uses during a
  contest is a worse defect than the one you are fixing.
- Tests that would catch the regression: an anonymous walk that used to reach
  the whole roster and now cannot, and a legitimate caller that still can.
  Demonstrate both red first.
- If your ruling needs a migration, **the next number is 0048** — check the
  journal; D133 exists because 0025 was skipped forever.

## Note the neighbours

While you are in there, say whether the same shape exists on any other list a
stranger can walk — organisations, teams, contests, submissions. **Do not fix
them in this slot**; report them with the same measurement (what one
anonymous request returns, whether a cursor is served, whether anything meters
it) so the next slot has evidence instead of suspicion.

## Out of scope

`contestWindowOpenWhere` (D49). Registration's oracle (D26) itself. Roster
freezing (D99). The `fe42-*` contest fixtures that grow ~1 per walk run.

## How you work

**The live stack is production**, deployed at `709d75f`, seven languages,
migrations through 0047, 461 accounts.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`.
- **Never** write to `apps/web/dist`. **Do not run the web build.** The edge
  carries F-51's bundle, so a browser walk is a real instrument for anything
  already deployed.
- **Never** read, print or commit anything from `.secrets/`. You may parse it
  by username to authenticate; never echo it.
- Live rows follow **D153** naming; delete what you can when you finish.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; Playwright
`--workers=1`; no load test. **Leave no process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D188** is yours; **D189** and **D190** after it. Do not go
past D190, do not renumber.

## Report

Write `docs/superpowers/briefs/f52-report.md`: the caller inventory, the
ruling and what it costs a legitimate user, the meter's key and its behaviour
behind one school NAT, and the neighbour measurements. Return only: status,
commits, the real `N passed` line, and what you could not finish.
