# B-31 — The invalidation class

## The defect that names this hunt

F-42's first live browser walk found this, in `apps/web/src/routes/teams.tsx`:

> `OrgTeams.refresh()` invalidated `['org-teams', slug]`. The member names on
> each row come from `['org-team', slug, teamSlug]`. Different first element,
> so TanStack Query's prefix matching never touched it. The team count moved
> to 2; the names stayed at 1.

The visible half was a stale list. The severe half was this: that same stale
entry prefills the **edit form**, and saving replaces the whole roster — so a
teacher who reopens the form to add a third pupil writes back the pre-edit
list and **silently drops the pupil they just added**. No failed request. No
error. Nothing on screen. The teacher finds out when a child cannot log in to
their round.

That is a data-loss bug wearing a caching bug's clothes, and it survived
every unit test in the repo because those tests mock the SDK — a mock returns
the new data regardless of which key was invalidated.

**One instance of a class is a bug. The class is a hunt.** This is the hunt.

## What to sweep

Every mutation in `apps/web/src` that writes something a screen also reads.
For each one, answer three questions in writing:

1. **Which query keys hold data this mutation changed?** Not the one obvious
   list — every key. A rename changes a detail view, a list, a breadcrumb, a
   picker somewhere else, and possibly a count in the navigation.
2. **Does the invalidation actually reach them?** TanStack matches by key
   *prefix*, and two keys that read alike to a person (`['org-teams', slug]`
   and `['org-team', slug, x]`) share no prefix at all. Check the literal
   arrays, not the intent.
3. **Does anything prefill a form from a query that could now be stale, and
   does saving that form replace rather than merge?** That combination is
   what turns cosmetic staleness into silent data loss, and it is the thing
   to grep for hardest.

Rank findings by that third question. A stale count is a nuisance; a stale
form that overwrites is a lost pupil.

## Where to look first

The screens where a mutation and a detail read live under different key
roots, and the ones a teacher uses under time pressure: teams and org
membership (the known instance — check its neighbours), problem sets,
contest participants and clarifications, problem revisions and test data,
admin user editing, account settings, notification read-state.

Do not stop at the web app if the trail leads out of it. A cache that
invalidates correctly but reads a route that itself caches — Redis, the
scoreboard store, an HTTP `Cache-Control` — is the same defect one layer
down. D142 reserved `Cache-Control: no-store` and never spent it; if you
find the reason it was reserved, say so.

## How to prove a finding

**A unit test that mocks the SDK cannot see this class** — that is why the
class exists. A finding needs either a browser walk (fourteen suites live in
`apps/web/e2e`; `organiser.spec.ts` journey 2b is the model) or a test that
exercises the real query client with real keys.

Every fix carries a test demonstrated **red** against the unfixed code, with
the failure output in your report.

**A clean sweep is a valid result** and must show its work: the mutations you
enumerated, their keys, and why each invalidation covers them. An
unsupported all-clear is worse than a missed bug.

## How you work

**The live stack is production**, deployed at `470c182`, six containers
healthy, five languages live.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`. Only the controller deploys.
- **Never** write to `apps/web/dist` — Caddy bind-mounts it and it holds the
  deployed bundle. **Do not run `pnpm --filter @duckoj/web build`.**
  Playwright points at the live edge; use it.
- Live rows you create follow **D153**'s test-artefact naming, and you close
  what you open — F-42 left nine contests public by accident and had to shut
  them by hand. Its `afterAll` is the pattern to copy.
- **Never** read, print or commit anything from `.secrets/`. Parse it by
  username to authenticate; never echo it.
- axe-core goes in via `page.evaluate`, never `addScriptTag` (D120).

**Report the real result.** Two false-green e2e runs have already happened in
this campaign. Quote the actual `N passed` line, never an exit code.

**Thermal caps** (93 °C incident here): every command under `nice -n 19`;
Playwright `--workers=1`; vitest `--no-file-parallelism`; only the specs you
touch.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D161** is unused and is yours; **D162** and **D163** after
it. Do not go past D163, do not renumber.

## Report

Write `docs/superpowers/briefs/b31-report.md`: the enumeration table (mutation
→ keys it changes → keys it invalidates → verdict), every defect with its
reproduction and what a teacher or pupil loses, and the red-test output for
each fix. Return only: status, commits, the real `N passed` line, defect count
by severity, and what you could not finish.
