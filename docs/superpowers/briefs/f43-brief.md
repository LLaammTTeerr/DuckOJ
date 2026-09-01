# F-43 — Two people, one screen, one of them loses

## Why this slot

B-31 swept the invalidation class and fixed what it could. It left two things
recorded rather than closed, both of the same shape: **two actors touch one
piece of state and the system quietly picks a loser.** Read
`docs/superpowers/briefs/b31-report.md` first — it has the reasoning and the
line numbers.

Neither is hypothetical on contest day. Both are the kind of thing a teacher
blames themselves for.

## 1. Two teachers editing one problem, and the first value wins forever

The edit forms seed their fields from a cached query **once**, and never
reseed. B-31 fixed the case where the stale value was your own pre-save text.
The case it could not fix without a ruling is the one with two people in it:
teacher A opens a problem, teacher B saves a change, teacher A fixes only the
title and saves — and B's work is gone, overwritten by the copy A's form had
been holding since before B saved.

No request fails. Nobody is told. The system had both versions and threw one
away.

**Decide how this should behave and record it as D161.** The obvious move —
reseed an undirty form when fresh data arrives — is a real behaviour change
and needs the argument written down, including what happens to a form that
*is* dirty. Consider whether the server should be refusing the write instead:
a save that silently clobbers a newer version is arguably the API's problem,
not the form's, and an optimistic-concurrency check is a different and
stronger answer than a smarter form. Weigh both, pick one, say why, and say
what it costs when it is wrong.

Whatever you choose, a teacher must never lose work without being told.

## 2. The monitor's clarifications panel goes stale during a live round

`apps/api/src/contests/contest.monitor.ts:113-118` caches its snapshot with
no invalidation, and the comment justifying that says every write which could
change the snapshot is a submission or a verdict.

**That comment is wrong.** B-31 established it: the snapshot carries a
clarifications panel, and both clarification writes are handled by the API,
which could invalidate and does not. So during a contest a teacher answers a
question and the monitor — the screen they are watching precisely because the
round is running — keeps showing the old state until a TTL expires.

Fix the invalidation. Then **fix the comment**, because a wrong comment that
explains why something is safe is worse than no comment: it is what stops the
next reader from checking.

While you are in there, audit the rest of that snapshot the same way: for
each panel, what writes can change it, and does one of them invalidate? The
other server-side gaps B-31 enumerated are TTL-bounded and two are deliberate
per D25 — do not churn them, but if you find another whose stated reason is
false, that is the same defect and it is in scope.

## Out of scope

Everything else in B-31's enumerated gaps. Syntax highlighting on the
submission detail page. Do not start either.

## How you work

**The live stack is production**, deployed at `c68fcf1`, six containers
healthy, five languages live, migration 0043 applied.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`. Only the controller deploys.
- **Never** write to `apps/web/dist` — Caddy bind-mounts it and it holds the
  deployed bundle. **Do not run `pnpm --filter @duckoj/web build`.**
- Fourteen Playwright suites point at the live edge. Note that the edge is
  deployed at `c68fcf1`, so a browser walk can show a bug **red** but cannot
  show your fix green until the controller ships it — write the walk anyway
  if it is the honest proof, mark it clearly, and say so in the report. That
  is exactly what F-42's journey 2b did.
- Live rows follow **D153**'s naming, and you close what you open.
- **Never** read, print or commit anything from `.secrets/`. Parse it by
  username to authenticate; never echo it.

**Tests**: the invalidation class is invisible to a test that mocks the SDK
or builds a fresh `QueryClient` per render. B-31's `edit-form-stale-seed.spec.tsx`
shows the shape that works — one real client, real keys, two mounts. Use it.
Every test demonstrated **red** first, failure output in the report.

**Thermal caps** (93 °C incident here): every command under `nice -n 19`;
Playwright `--workers=1`; vitest `--no-file-parallelism`; only the specs you
touch. Never a container-backed spec alongside another suite.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.
Typecheck passing is not lint passing.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D161** is yours for the concurrent-edit ruling; **D162** and
**D163** after it. Do not go past D163, do not renumber.

## Report

Write `docs/superpowers/briefs/f43-report.md`. Return only: status, commits,
the real `N passed` line (never an exit code), and what you could not finish.
If a claim here is wrong when you check it, say so — including B-31's claim
about that comment, which you should verify rather than inherit.
