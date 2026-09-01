# F-42 — Browser coverage where there has never been any

## Why this slot

`docs/PROVINCE-READINESS.md` has carried this gap since 29 August, at
position 4:

> The new organiser routes — similarity, live monitor, teams — have no
> Playwright coverage; the web tests mock the SDK.

Mocking the SDK proves the component renders what the mock returned. It
proves nothing about the route existing, the authorisation marker being
right, the query actually returning that shape, or the page surviving a real
navigation. These are the screens a **teacher operates during a live
contest** — the live monitor while a round runs, the similarity report after
it, the team roster before it — and they are the least proven code in the
system.

Three feature slots have also shipped in the last day (F-39, F-40, F-41) with
**no Playwright run at all**. The language picker every student touches on
every submission has never been driven in a browser.

## Scope

Twelve suites already live in `apps/web/e2e` and run against the live stack.
Extend them; do not build a second harness.

### 1. The organiser routes

A walk each, as a teacher, against the live stack:

- **Live monitor** — open it on a running contest, see the feed and the
  per-problem panel, confirm what it shows agrees with what the API says.
  D100 records that the counter and the queue depth can honestly disagree;
  your assertion must be true under that, not flaky because of it.
- **Similarity report** — run it on a contest with submissions, see the
  matched spans render.
- **Teams** — create a team, add a member, confirm the one-seat-per-contest
  rule (D101, D104) is visible to the teacher rather than only enforced in
  the database.

### 2. The language path

- The submit picker offers all five languages, **preselects C++17** (D158 —
  this is the defect B-30 found; a browser test is what would have caught
  it), and the limits shown beside the picker change when the language does.
- Switching language and back **restores the draft** (D84). B-30 fixed the
  explicit-switch path; F-41's report says the mount path that corrects an
  unofferable default still loses typing, and that it is now reachable
  because setters can write `allowed = false`. **Fix that residual in this
  slot** — it is small, and you will have the test that proves it.
- A language a problem refuses is absent from the picker, and the page does
  not post it.

### 3. The language-limits form (F-41, deployed but never seen in a browser)

Set an override, save, reload, confirm it persisted; clear a field and
confirm it stores **inherit**, not zero. The distinction is the whole point
of the form and a browser is where it breaks.

## How you work

**The live stack is production**, deployed at `908a6b8`, six containers
healthy, five languages live, migration 0043 applied.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`. Only the controller deploys.
- **Never** write to `apps/web/dist` — Caddy bind-mounts it and it currently
  holds the deployed bundle. `pnpm --filter @duckoj/web build` writes there:
  **do not run it.** Playwright's config points at the live edge; use it.
- Rows you create in the live database must follow **D153**'s test-artefact
  naming, so the cleanup script can find them. Contests and problems you
  create for a walk are real rows on a real host — name them accordingly and
  do not attach them to the demo set.
- **Never** read, print or commit anything from `.secrets/`. You may parse it
  by username to authenticate; you may not echo it.
- **axe-core must be injected via `page.evaluate`, never `addScriptTag`** —
  CSP blocks inline scripts (D120), and that mistake has already cost this
  campaign a full red suite.

**Report the real result.** This campaign has had two false-green e2e runs: a
bare `exit 0` that ran zero tests, and a missing `axe-core` that silently
skipped. **Quote the actual `N passed` line, never an exit code.** A suite
that fails is a finding, not something to work around by loosening the
assertion — if a walk fails against the live stack, that is very likely a
real defect and it is the most valuable thing you will produce today.

**Thermal caps** (93 °C incident on this host):
- Every command under `nice -n 19`. Playwright's own workers count: keep
  concurrency low and say what you used.
- Vitest always `--no-file-parallelism`; run only the specs you touch.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D161** is yours (unused); **D162** and **D163** if needed.
Do not go past D163, do not renumber.

## Report

Write `docs/superpowers/briefs/f42-report.md`: what each walk asserts, the
real run output, and every defect a walk uncovered. Return only: status,
commits, the actual `N passed` line, defects found, and what you could not
finish.
