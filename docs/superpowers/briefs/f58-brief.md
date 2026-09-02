# F-58 — The handover documents, checked against the machine

## Why this slot

Two slots in two days found a **false claim in the document a province reads**:

- F-57 struck `PROVINCE-READINESS.md` gap 4, which said two F-42 fixes were
  undeployed and that a walk was "red on purpose". Both pass on the live edge,
  and the spec's own docstring had already recorded the fix landing.
- F-56 found `docs/guide/quan-tri.md` documents **neither** `NAME_DISCLOSURE`
  nor `REGISTRATION` — the two switches that now decide what a province
  discloses and who may sign up.

This is the same class as F-43's false comment and F-52's stale one, one level
up: **documentation that has quietly become untrue is a trap**, and a readiness
doc that tells the next reader a green walk is an expected failure is how a
real failure gets waved through.

Twenty slots have shipped since these documents were last audited. They are
now the least verified artefacts in the project, and they are the ones the
handover depends on.

## Scope: 5,081 lines, checked against the running system

- `docs/PROVINCE-READINESS.md` (176) — what a province gets, supplies, and
  what is open
- `docs/guide/quan-tri.md` (535) — the administrator's guide
- `docs/guide/giao-vien.md` (660) — the teacher's guide
- `docs/guide/hoc-sinh.md` (517) — the pupil's guide
- `docs/guide/chuan-bi-de.md` (222) — preparing a problem
- `docs/guide/truoc-khi-trien-khai.md` (289) — the pre-production checklist
- `docs/guide/mcp.md` (308) — the agent interface
- `docs/runbook.md` (2,374) — operations

**Every factual claim gets one of three verdicts**, and the verdict must be
earned rather than assumed:

1. **True** — verified against the live stack, the code, or a command you
   actually ran. Say how.
2. **Stale** — was true, no longer is. Fix it, and say what changed it.
3. **Never true** — say so plainly. These are the dangerous ones.

Do not rewrite prose you have not checked, and do not "improve" wording. This
is an audit, not an edit: a document that reads worse but is true beats one
that reads well and misleads.

## What has changed under these documents

Twenty slots, roughly: seven languages with per-language limits · mail that
refuses rather than lying · optimistic concurrency on five forms · every
organiser list reaching its last page · a name search · the pupil directory
and school rosters gated · `NAME_DISCLOSURE` and `REGISTRATION` as deployment
policies · the scoreboard fold removed · migrations through 0049. Commands,
routes, screenshots-in-words, counts and defaults have all moved.

**Pay particular attention to:**

- **Commands and flags.** If a guide says to run something, run it. `pnpm` is
  not on PATH — `corepack pnpm` is; a guide that says otherwise fails at the
  first step for a province's IT team.
- **The two new switches.** They belong in the administrator's guide and in
  the pre-production checklist, with what each rung costs a reader.
- **`truoc-khi-trien-khai.md`** — this is the one-time checklist for turning
  this host over, and it is the highest-stakes page in the set.
- **Anything that names a count, a version, a port, or a default.**
- **The pupil and teacher guides** now describe a judge where a signed-out
  visitor sees handles and cannot sign up. Screens changed; the guides may not
  have.

## Also worth doing while you are there

The atlas artifact the controller maintains is derived partly from these
documents, so an error here propagates. You cannot publish it, but **list in
your report any claim you corrected that a summary of this system would
repeat** — that list is what the controller uses to fix the published page.

## Out of scope

Roster freezing (D99). `judged.live`'s attempt keying (D29). Do not add
features. If an audit finds a *product* defect rather than a documentation
one, report it with evidence and do not fix it here.

## How you work

**The live stack is production**, deployed at `01e59f2`, CI green, seven
languages, registration closed, `NAME_DISCLOSURE` on its default rung,
migrations through 0049, 480 accounts.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**. **Never edit the
  live `.env`.**
- Live database is **read-only**: `SELECT`/`EXPLAIN`. Anonymous and
  authenticated `curl` through the edge is how many claims get checked.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/` — a guide that
  quotes a credential is itself a finding.
- Live rows follow **D153** naming; the cleaner covers `^b[0-9]+-` and
  `^fe[0-9]+-`.

**Read `CLAUDE.md`.** If you touch code at all, run the full suite of every
package you touch.

**Thermal**: `nice -n 19`; Playwright `--workers=1`; no load test. **Leave no
process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D204** is yours if the audit forces one; **D205** after it.
Do not go past D205, do not renumber.

## Report

Write `docs/superpowers/briefs/f58-report.md`: a table of every claim you
checked with its verdict and how you checked it, the "never true" list
separately and first, and the list of corrections a summary of this system
would repeat. Return only: status, commits, counts by verdict, the most
dangerous thing you found, and what you could not finish.
