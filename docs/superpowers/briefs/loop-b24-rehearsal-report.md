# B24 — contest-day rehearsal

One scripted rehearsal against the LIVE stack from two seats: `scripts/rehearsal.ts` (API, 21
assertions) and `apps/web/e2e/contest-day.spec.ts` (Playwright, 4 serial journeys, zero console
errors per page). Two genuine integration bugs caught, both fixed red-first + mutated. Fixed
`rehearse-*` accounts, login-first so re-runs cost nothing against the D26 meter.

## Transcript — `scripts/rehearsal.ts` (all 21 ok)

1 admin+5 pupils · 2 admin authors+publishes two problems · 3 org + two teams of two · 4 ICPC team
contest, org-restricted, freeze last 3 min, 2 problems · 5 both teams join, teammate re-join → 409
`contest_team_joined` · 6 pre-freeze AC(p1 by a **teammate**, not captain)+AC(p2)+WA(p1) · 7 **D117**
teammate reads the team's submission+source, a rival is refused 404 · 8 scoreboard rows are team
NAMES (Alpha 200 / Bravo 0) · 9 a rival already sees Alpha's pre-freeze AC · 10 monitor per-problem
counts + room + submitter attribution (D105) · 11 clarification asked→answered→seen by teammate AND
rival · 12 announcement reaches both teams · 13 late Bravo AC inside the freeze · 14 **freeze**: a
rival sees it as *pending*, organiser board + monitor show the real AC (D22/D23) · 15 rejudge →
monitor recomputed (D100) · 16 similarity: 2 pairs on the identical p2 sources · 17 disqualify Bravo
→ scoreboard `is_disqualified` · 18 individual public contest ACs and scores (non-team path) · 19
results.csv (UTF-8 BOM, `members` column, both team rows, DQ flag) · 20 results.pdf · 21
certificates.pdf (eligible teams only — DQ'd Bravo correctly excluded).

## Transcript — `contest-day.spec.ts` (4/4 green)

1 admin authors a problem in the browser authoring tab (2 tests, standard checker) → pupil ACs via
the submit UI · 2 frozen team round: scoreboard renders team names, organiser monitor shows counts +
room + real verdict, a rival's board shows the freeze banner · 3 Q&A panel: member asks, organiser
answers+publishes+announces, teammate and rival both see it · 4 individual public contest joins,
ACs, scoreboard shows the username. `watchForBrokenRequests` on every page/actor.

## Bugs (both fixed)

- **D119 — `8cc07fb`** private team clarification invisible to the asker's teammate. `list()` filtered
  `askedBy = me`, team-blind unlike D117 for submissions, while the notification set already unioned
  the squad — so an organiser's private per-team answer reached one member and hid from the rest. Now
  matches `askedBy IN (teammates in this contest)`; empty for individual rounds, no cross-contest or
  rival leak. Red-first, 20/20 suite green, mutation reverts to red.
- **D120 — `dd82d89`** the CSP (`script-src 'self'`) blocks index.html's D116 pre-paint theme inline
  `<script>` on every page — the *entire* browser e2e suite is red against main (the shipped
  smoke.spec.ts fails identically), plus a theme flash for dark-mode users. Added the script's exact
  sha256 to `script-src` (never `'unsafe-inline'`); new test pins the hash to the file so they can't
  diverge. Red-first, mutation reverts to red.

## Verification

`pnpm -r typecheck`, `typecheck:scripts`, `pnpm -r lint`, `lint:scripts` green; web tests 563; API
tests 1113 (per B13, `-r test` flakes under Testcontainers contention — one file raced with
`relation "users" does not exist`, passes 13/13 in isolation); `contracts openapi` + SDK regen → no
diff. Both rehearsal artefacts green against the live stack. No container was stopped or rebuilt.

## Concerns

- **The D120 fix is committed but NOT deployed** — containers must not be rebuilt, so the live edge
  still serves the old CSP. The Playwright spec tolerates exactly that one CSP console error
  (`CONSOLE_ALLOW`, `watch.ts` gained an `allowedConsole` param); DELETE that allowance once the edge
  ships the hash. Until then the shipped browser specs (smoke/authoring/features/journey/a11y) stay
  red on the live stack.
- D119 ships in source only for the same reason; live step 11b still reports it (a soft probe), so
  the script hard-asserts only the rival-cannot-see half. In a worktree, `E2E_SECRETS_FILE` must
  point at the main clone's `.secrets/duckadmin.txt` (the script falls back to it; the spec needs it).
