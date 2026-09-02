# F-55 — A province decides how much of a child is public

## Why this slot

F-52 and F-53 gated the two directories. B-35 then measured what remains, and
the number is the point:

> `GET /contests/{key}/scoreboard` is a third bulk list of people —
> `@Public()`, uncapped, unmetered. **142 distinct usernames in 159 anonymous
> requests**; 108 of them reachable no other way; **264 of 481 accounts
> (54.9%) anonymously harvestable with display names.**

The controller confirmed the chain on the live edge: a scoreboard hands a
stranger `participant` usernames, and `GET /users/{username}` — still
`@Public()`, correctly — dereferences each one to a **real name**.

**The gates are not wrong and the scoreboard is not wrong.** A judge's
standings are its front door; D46's public rank names and public profiles are
how competitive programming works, and B-35 was right to refuse to gate them
on its own authority. D192's "events, not people" argument is sound about a
contest *list* and stops one dereference short of a scoreboard.

What is actually unresolved is a **policy question this system has never
asked**: an adult on a public judge and a twelve-year-old in a provincial
school are not the same population, and the software currently treats them
identically.

## The shape to build

Do not hard-code a new answer. **Make the disclosure level a deployment
policy**, with a default chosen for the population this system is for.

- The data model already separates `username` from `displayName`. A username
  is an identifier the pupil chose or was issued; a display name is very often
  a child's real, full name. Those deserve different defaults.
- Decide what an anonymous caller sees: plausibly the username and rating
  everywhere, and the display name only to a signed-in caller — or only within
  the pupil's own organisation. Argue your choice against the alternatives,
  and say what each costs a legitimate reader: a public scoreboard that shows
  only handles is still a usable scoreboard, and a parent looking up their
  child is a real user with a real need.
- **One switch, read in one place.** Every surface that renders a person —
  scoreboard, profile, submissions list, comments, the monitor feed, results
  CSV and PDF, certificates, the printed seat slips (D129) — must consult the
  same predicate. A policy honoured by six surfaces and forgotten by the
  seventh is not a policy, and B-35's finding is exactly that shape one level
  up.
- The default must be safe for a school. An operator who reads nothing and
  changes nothing should get the protective behaviour; the open behaviour is
  the one you opt into.
- Whatever you choose, the **export paths matter most** — a CSV or a PDF is
  the artefact that leaves the building.

Record it as **D197**.

## Also close two small things B-35 left

- **`scripts/cleanup-test-data.ts` does not know about `b35-`.** Its bug-hunt
  pattern is `^bh[0-9]+`, so B-35's probe account and 22 `rate_events` are
  live and unreachable by the cleaner. B-35 was right not to write to the
  database to remove them. Widen the pattern to cover the naming this campaign
  actually uses, and say in D153's terms what the pattern now claims.
- **B-35's NUL-byte interceptor is deployed**; its `route-fuzz` red was 228
  route/mode 5xx. Check whether the same class — a byte or shape that reaches
  a bind — has other members the fuzzer cannot currently express, and say so.
  Do not build a second interceptor.

## Out of scope

Registration's oracle (D26). Roster freezing (D99). D195's search residual —
B-35 measured it at 482 accounts in 576 requests and D192 rules it open on
purpose; **your policy switch may change what those requests are worth, which
is the point, but do not re-litigate the meter.**

## How you work

**The live stack is production**, deployed at `fe4ec8d`, seven languages,
migrations through 0048, 481 accounts.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Anonymous `curl` through
  the edge is fine.
- **Never** write to `apps/web/dist`. **Do not run the web build.** The edge
  carries the current bundle, so a browser walk is an honest instrument.
- **Never** read, print or commit anything from `.secrets/`.
- Live rows follow **D153** naming; delete what you can when you finish.
- **Next migration is 0049** if you need one — check the journal.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; Playwright
`--workers=1`; no load test. **Leave no process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D197** is yours; **D198** and **D199** after it. Do not go
past D199, do not renumber.

## Report

Write `docs/superpowers/briefs/f55-report.md`: the surface inventory with what
each shows at each policy level, the default and why it is that one, what a
legitimate reader loses, and the export paths specifically. Return only:
status, commits, the real `N passed` line, and what you could not finish.
