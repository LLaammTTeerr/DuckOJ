# B-31 report — the invalidation class

**Status: complete.** Every mutation in `apps/web/src` enumerated against every
query key it moves — 38 rows below, covering every write the SPA makes.
**Three defects found and fixed** (table rows 1–3), each with a test
demonstrated red against the unfixed code; **five further client-side gaps
found, reasoned about and deliberately not fixed** (rows 4–8), with the reason
given per row. Two commits in this clone on `main`, plus this report. **Not pushed, not
deployed.**

`podman-compose`, `scripts/compose-up.sh` and `scripts/deploy.sh` were never
run. **`apps/web/dist` was never written and no `vite build` was run.** Nothing
in `.secrets/` was read, printed or committed. **No live rows were created** —
see "Why there is no browser walk". **D161 is unused**: no fix changes a stated
behaviour, so none spends a decision (F-42's precedent, which is B-30's).

---

## Commits

| | |
| --- | --- |
| `e971024` | `fix(edit)` — a saved statement and a saved problem list survive reopening the form |
| `59b9385` | `fix(revisions)` — publishing a revision refreshes the limits a pupil is quoted |
| *(HEAD)* | `docs(b31)` — this report |

HEAD before this slot was `470c182`, which is **the commit the live stack is
deployed at**. So F-42's two fixes are already on the edge, and the three fixes
in this slot are not — which is what decides the proof strategy below.

---

## The runs, verbatim

**Whole `@duckoj/web` package, `--no-file-parallelism`, every command under
`nice -n 19`:**

```
 Test Files  70 passed (70)
      Tests  758 passed (758)
   Duration  122.27s
```

754 before this slot, 758 after: the four new cases are the three in
`edit-form-stale-seed.spec.tsx` and the one in `revision-publish-refresh.spec.tsx`.

`tsc --noEmit` clean on `@duckoj/web`; `eslint src test` clean. **Nothing in
`packages/` or `apps/api` was touched**, so nothing there was re-run and
`openapi.json` / `packages/sdk` cannot have moved. No Playwright suite was run
— see immediately below.

### Why there is no browser walk

The brief allows either a browser walk **or** "a test that exercises the real
query client with real keys". This slot took the second, on purpose, for a
reason F-42 established: **the live edge is at `470c182`, so a walk could only
ever show these bugs red.** It could not show a fix green, because the fix is
a local commit the edge does not carry. A red walk against production that
proves a thing this report already proves at the cache would buy nothing and
would leave `fe`-named artefacts on a production list to clean up.

What the new specs do instead is the thing the mocked unit tests in this repo
structurally could not do, and the reason this class survived 754 of them:
**they share ONE `QueryClient` across both mounts.** Every existing spec for
these pages builds a fresh client per `render`, so its second mount is a cold
cache and a missing invalidation is invisible. A browser does not do that; it
keeps the cache across a navigation away and back, for the five minutes of
TanStack's default `gcTime`. That single change is what turns the whole class
from untestable into deterministic.

---

## The discriminator, stated once

TanStack's defaults in this app are `staleTime: 0` and `refetchOnMount: true`
(`src/query.ts` overrides only `retry`; the sole `staleTime` overrides in the
tree are `languages.ts` and `tags.ts`, both `Infinity`, both immutable
catalogues, and three `refetchInterval` pollers). So a missing invalidation on
a screen you navigate **away from and back to** refetches on mount and
self-corrects after a flash.

A missing invalidation is therefore only a real defect when one of two things
is true, and every "verdict" in the table below cites which:

1. **stays mounted** — the reading component is alive across the mutation, so
   no mount ever happens to correct it; or
2. **seed-once form** — a form copies query data into local `useState` behind a
   run-once guard. On a remount the cached (stale) value is present
   **synchronously on the first render**, the seeding effect fires on it, and
   the mount's own refetch lands afterwards to find the guard already closed.
   The form then holds pre-save values and, because these forms **replace**
   rather than merge, the next save writes them back.

(2) is F-42's prefill half, and it is the half that loses work. There are five
seed-once forms in `apps/web/src`. Two of them were unguarded, and they are
defects 1 and 2:

| seed-once form | guard | seeded from | its save refreshed that key? |
| --- | --- | --- | --- |
| `problem-edit.tsx` | `seededFrom === code` | `['problem', code]` | **no — defect 1** |
| `contest-edit.tsx` | `seededFrom === key` | `['contest', key]` | **no — defect 2** |
| `problem-language-limits.tsx` | `seededFrom === code` | `['problem-language-limits', code]` | yes — `query.refetch()` **and** `['problem', code]` |
| `settings.tsx` | `seededFrom === user.id` | `['me']` | yes — `['me']` |
| `contest-new.tsx` (clone) | `seeded` boolean | `['contest', cloneFrom]` | n/a — source is read-only |

The pattern is exact: **the two forms that refreshed their own source are safe,
the two that refreshed nothing are the defects.** `problem-language-limits.tsx`
is the model, and its own comment says why — "the pupil-facing limits … are
cached under a different key on two other screens". The form that owns the
statement never had that sentence.

---

## The enumeration table

Every write `apps/web/src` makes. **"Keys it changes"** is every cached key
holding data the write moves, not the obvious one. **"Reaches them?"** compares
the literal arrays under TanStack's prefix rule.

### Defects (fixed)

| # | Mutation | Keys it changes | Invalidated | Reaches them? | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `PATCH /problems/{code}` — `problem-edit.tsx` | `['problem', code]`, `['problems']`, `['problems', q, …]` | **nothing** | no | **DEFECT — seed-once form. Fixed `e971024`** |
| 2 | `PATCH /contests/{key}` — `contest-edit.tsx` | `['contest', key]`, `['contests']`, `['scoreboard', key]` | **nothing** | no | **DEFECT — seed-once form + the save navigates to a reader. Fixed `e971024`** |
| 3 | `POST /problems/{code}/revisions/{v}/publish` | `['problem-revisions', code]`, `['problem', code]`, `['problems']` | `['problem-revisions', code]` | partial | **DEFECT — stale detail. Fixed `59b9385`** |

### Gaps found, reasoned about, not fixed

| # | Mutation | Keys it changes | Invalidated | Why not fixed |
| --- | --- | --- | --- | --- |
| 4 | `PATCH /orgs/{slug}/sets/{setSlug}` — `problem-sets.tsx` | `['org-set', slug, setSlug]`, `['org-sets', slug]`, **`['org-set-progress', slug, setSlug]`** | `['org-set', slug]` (prefix, reaches the detail), `['org-sets', slug]` | The progress grid's key has a **different root** and is invalidated by nothing in the app — the same shape as F-42's. But it is its own route, nothing stays mounted, and `SetForm` prefills from a **prop** re-read after the awaited invalidation, so there is no latch. Cosmetic within one mount. |
| 5 | `POST /submissions` — `submit.tsx` | `['submissions', …]`, `['problem-stats', code]`, `['problem', code]`, `['my-progress']`, `['user-progress', u]`, `['scoreboard', key]`, `['contest-monitor', key]` | **nothing** | The largest "misses many keys" row in the app, and defensible: at POST time **the verdict does not exist yet**, so there is nothing true to invalidate to. The page watches the socket for it (D150) and every other reader is another route. Invalidating here would refetch seven queries to learn nothing. |
| 6 | `POST /admin/problems/{code}/rejudge`, `POST /admin/submissions/{id}/rejudge` | `['submissions', …]`, `['problem-stats', code]`, `['my-progress']`, `['scoreboard', key]` | `['submission', id]` on the submission page; nothing on the problem form | Same reason as 5: a rejudge **queues** work, so at response time nothing is regraded yet. The one key that IS immediately true — the submission's own `queued` state — is the one invalidated, and its two mounted siblings (`['submission-previous', id]` is an id, `['submission-diff', …]` is source hunks) carry no verdict, so they are genuinely unaffected. |
| 7 | `POST /contests/{key}/join` — `contests.tsx` | `['contest-me', key]`, `['problems']`, `['my-teams', key]`, `['scoreboard', key]` | `['contest-me', key]`, `['problems']` | `['my-teams', key]`'s `eligible` flags go stale on a mounted page — but the team picker is replaced by the participation state the moment the join succeeds, so nothing stale is on screen. The board is another route. |
| 8 | `POST /problems/{code}/drafts/{id}/build`, `POST /problems/{code}/clone`, `POST /contests`, `POST /contests/{key}/clone` | `['problem-revisions', code]` / `['problems']` / `['contests']` | **nothing** | Creates. Each screen renders the created thing directly (a link, or a navigation to it); the list that omits it is another route and refetches on mount. |

### Clean rows

Every remaining write, with the reason its invalidation is sufficient.

| Mutation | Invalidated | Why that covers it |
| --- | --- | --- |
| `POST /auth/login` (`router.tsx`, `register.tsx`) | `['me']` | plus `me.ts`'s `removeQueries({ predicate: key[0] !== 'me' })` on an identity change — the whole cache goes |
| `POST /auth/logout` (`nav.tsx`) | `setQueryData(['me'], null)` | deliberately not `resetQueries()`, which refetched into a 401; same `removeQueries` sweep |
| `POST /auth/register` | `['me']` | signs in on success |
| `POST /auth/password/change` | `['me']` | |
| `POST /auth/password/forgot|reset`, `POST /auth/email/verify` | — | signed-out routes; nothing of the visitor's is cached |
| `PATCH /users/me` (`settings.tsx`) | `['me']` | seed-once form, seeded from the key it refreshes. Misses `['user', username]` (the public profile's display name) — another route, no latch |
| `POST /auth/totp/{begin,confirm}`, `/recovery/regenerate`, `DELETE /auth/totp` | `['me']` ×3 | `begin` writes nothing |
| `POST /auth/tokens`, `DELETE /auth/tokens/{id}` | `['tokens']` | |
| `POST /notifications/read` | `setQueryData(['notifications'], data)` | the **same object** the nav bell spreads, so the count clears with the rows rather than at the next 60 s poll |
| `POST/PATCH/DELETE /problems/{code}/comments` | `['problem-comments', code]` ×3 | all three paths share one `refresh()`; nothing else holds a comment |
| `PUT /problems/{code}/language-limits` | `['problem', code]` **and** `query.refetch()` | the model for this class |
| `POST /problems/{code}/revisions` (attach) | `['problem-revisions', code]` | a *draft* revision changes nothing on `ProblemDetail` |
| `POST /packages` (upload) | — | prefills the attach box; no cached package list |
| `POST /problems/{code}/drafts/from-revision/{v}` | — | reads a revision into a draft; writes nothing anyone reads |
| `POST /contests/{key}/clarifications`, `/announcements`, `PATCH /clarifications/{id}` | `['clarifications', key]` ×3 | one shared `refresh()`; the feed is the only reader |
| `PATCH /contests/{key}/participants/{username}` | `['scoreboard', key]` | the board is the only screen showing it **and it stays mounted** — the one place in the app where that discriminator is satisfied and the invalidation is right |
| `POST /contests/{key}/similarity` | `['similarity', key]` | then a 2 s poller while the run is `running` |
| `contest-monitor` websocket frame | `['contest-monitor', key]` | plus a 5 s poll floor |
| `POST /orgs` | `['orgs']` | a **prefix** of `['orgs', 'picker']`, so the picker is covered too |
| `POST /orgs/{slug}/requests/{id}/approve|reject` | `['org-requests', slug]` + `onDecided` → `['org-members', slug]`, `['org', slug]` | approving adds a member; both the roster and `myRole` are refreshed |
| `POST /orgs/{slug}/members/import` | `onImported` → `['org-members', slug]`, `['org', slug]` | fires even on the partial-failure path, where accounts already exist |
| `POST /orgs/{slug}/join` | `refresh()` on `joined` | on `requested` nothing of this viewer's is cached yet |
| `DELETE`/`PATCH /orgs/{slug}/members/{username}` | `['org-members', slug]`, `['org', slug]` | **checked in the API**: `OrgAccessService.removeMember` (`authz/org.access.ts:527`) touches only `org_members` and does **not** cascade into `team_members`, so `['org-team*']` — mounted on the same page — is genuinely unaffected |
| `POST/PATCH/DELETE /orgs/{slug}/teams…` | `['org-teams', slug]`, `['org-team', slug]` | F-42's fix, deployed at `470c182` |
| `POST /orgs/{slug}/sets` | `['org-sets', slug]` | |
| `DELETE /orgs/{slug}/sets/{setSlug}` | `['org-sets', slug]` + `window.location.assign` | a real page load; every cache dies |
| `POST /admin/contests/{key}/{rate,unrate}` | `['contests']` | misses `['contest', key]`'s `isRated` and `['user-rating', u]` — both other routes |
| `PATCH /admin/users/{username}` (grant role) | **nothing** | the only stays-mounted reader would be `['me']` on a self-demotion, and **the API refuses that outright** — `admin-users.service.ts:89`, `admin_self_demotion`. Promoting someone else changes a cache in *their* browser, which this client cannot reach |
| `DELETE /admin/users/{username}/totp` | — | changes the target's account; nothing of the admin's is cached |
| `POST /admin/mail/test`, `POST /admin/grading/reclaim` | `['admin', 'dashboard']` ×2 | |

---

## Defects 1 and 2 — the edit form reopens showing what it replaced

**Severity: high (silent data loss).** `problem-edit.tsx` and
`contest-edit.tsx`. Fixed in `e971024`; **not deployed**.

### What is wrong

Neither form invalidated **anything** after a successful save. The cosmetic
half is ordinary: every screen reading `['problem', code]` or
`['contest', key]` renders the pre-save value. For the contest form that
includes the page it navigates to on success — the organiser presses Lưu and
lands on the contest they just edited, showing the times and problem list they
just replaced.

The severe half is the seeding guard, and it is the same guard both files
document as a safety feature:

```
if (!query.data || seededFrom === query.data.code) return;
```

It exists so a late refetch cannot clobber what a setter has typed, and for
that it is right. But it also means **the first value the form sees wins**, and
on a remount that first value is the cached one, delivered synchronously on the
first render — React flushes the passive effect within the frame, and the
mount's own refetch is a network round trip behind it. It always loses. So the
guard closes on the stale value and the fresh answer, which really does arrive,
is thrown away.

### What a teacher loses

A setter rewrites a statement, saves, leaves the form, and comes back inside
five minutes to fix a typo in the **name**. The form is prefilled from the
entry their own save left stale. They change the name, press Lưu — and the PATCH
body carries the pre-save `statement`. Their rewrite is gone. No failed
request, no error, nothing on screen, and the statement box holds the largest
single thing anybody types into this site.

On the contest form the field at risk is `problems`, which this file's own
`ProblemRow` comment already calls the all-or-nothing one: "anything this form
drops is a thing the save destroys". An organiser who removes a problem, comes
back and adjusts the freeze has just put the problem back into a round.

### Reproduction, red first

`apps/web/test/edit-form-stale-seed.spec.tsx`, three cases sharing **one**
`QueryClient` across two mounts. Red against `e971024`'s parent:

```
 × the problem edit form … > shows the statement it just saved, not the one it replaced
   → expect(element).toHaveValue(Cong hai so nguyen.)
     Received: "Cong hai so."
 × the problem edit form … > does not write the pre-save statement back over the saved one
   → expected 'Cong hai so.' to be 'Cong hai so nguyen.'
 × the contest edit form … > shows the problem list it just saved, not the one it replaced
   → expected <input aria-label="Mã bài 2" value="xau"> to be null
 Test Files  1 failed (1)
      Tests  3 failed (3)
```

The middle one **is** the data loss, verbatim: a save that touched only the
name silently reverted the statement.

### Fix

`['problem', code]` + `['problems']` on the problem form; `['contest', key]` +
`['contests']` + `['scoreboard', key]` on the contest form, **awaited before the
navigation**, because the navigation's destination is one of the readers.
`['problems']` and `['contests']` are prefixes, so they reach the filtered
catalogue keys too. `['scoreboard', key]` is included because `problems`,
`points` and `frozenLastMinutes` are the board's columns and its scoring.
`['contest-monitor', key]` is deliberately **not** invalidated: it polls itself
every five seconds and adding it would only duplicate that. Green:

```
 ✓ test/problem-edit.spec.tsx (11 tests)
 ✓ test/contest-edit.spec.tsx (13 tests)
 ✓ test/edit-form-stale-seed.spec.tsx (3 tests)
 ✓ test/problem-language-limits.spec.tsx (6 tests)
 ✓ test/problem-editorial.spec.tsx (7 tests)
 Test Files  5 passed (5)   Tests  40 passed (40)
```

No decision spent: this restores the behaviour both forms were written for.

### The residual this fix does **not** close

The guard is still first-value-wins. What the fix removes is the way the app
itself created a stale first value; it does not help when the stale value came
from **someone else's** write — two teachers editing one problem, or a
co-organiser adjusting a round. That case needs the seeding effect to reseed
when fresh data arrives *and the form is not dirty*, which both files already
have the machinery for (`fingerprint(...) !== seed`, D147's guard). It is a
behaviour change rather than a bug fix, it would need its own decision, and it
is deliberately out of this slot. **Recorded, not fixed.**

---

## Defect 3 — publishing a revision does not move the limits a pupil is quoted

**Severity: low (cosmetic within one mount).** `problem-revisions.tsx`. Fixed in
`59b9385`; **not deployed**.

`handlePublish` invalidated `['problem-revisions', code]` — its own table — and
nothing else. Publishing is the write that moves `timeMs`, `memoryKb`,
`testCount`, `totalPoints`, `checkerKind` and `hasPublishedRevision` on
`ProblemDetail`, which lives under `['problem', code]`: a different first
element, no prefix match, invalidated by nothing. `['problems']` prints the
time and memory columns from the same source and was equally untouched.

The reader left behind is the pupil on `/problems/{code}` or in the submit box,
quoted the limits of the revision that was just superseded — at exactly the
moment D87 built this screen for, a setter republishing a corrected test set.

**The severity is honest and low, and the report says why**: no reader of
`['problem', code]` stays mounted across this write, and no seed-once form
latches these fields, so a reader arriving afterwards refetches on mount and
self-corrects. **That is also why this one test asserts on the cache entry
rather than on a screen.** F-42's rule is to drive the panel because the screen
lied; here the screen does not lie, the stale entry is the entire finding, so
the stale entry is what is asserted. Manufacturing a screen-level assertion for
it would have been theatre. Red first:

```
 × after a revision is published > the problem detail the other screens read is refetched, not the pre-publish one
   → expected false to be true
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

---

## One layer down: the server-side caches

The brief said not to stop at the web app. Audited in full; **nothing here was
changed**, and the reason is uniform: every server cache carries a short TTL, so
every gap below is a bounded nuisance rather than a wrong answer that persists.

The complete inventory — there are nine Redis namespaces and **only three call
sites in the entire API ever delete an entry**, all three scoreboard keys
(`authz/contest.access.ts:1203`, `:1766`, `authz/rejudge.access.ts:305`).

| Write that changes a cached read | Busts it? | Bound |
| --- | --- | --- |
| contest PATCH, disqualify/reinstate, rejudge → `duckoj:sb:v1` | yes, after commit, both key sets | — |
| a graded verdict from `judged` → `duckoj:sb:v1` | **no, by design** — D25 says so in as many words: the event writer is a separate process that never calls into the API | 2 s |
| `POST /contests/{key}/join`, `POST /contests/{key}/participants` → `duckoj:sb:v1` | **no** — each adds a ranking row; D25's own bullet list omits both | 2 s |
| `PATCH /orgs/{slug}/teams/{teamSlug}` → `duckoj:sb:v1` | **no** — the board carries a `teams` sidecar of name + members, and `TeamAccessService.update` does not import the cache. Reachable mid-round: F-25's roster lock exempts the organiser, so the person most likely to rename a team live is the one allowed to | 2 s |
| `POST`/`PATCH …/clarifications` → `duckoj:monitor:v1` | **no**, and this one is the class exactly: `contest.monitor.ts:113-118` justifies having no invalidation with "every write that would change this snapshot is a submission or a verdict, and the API does not handle the verdict at all" — but the snapshot **includes a clarifications panel**, and both clarification writes are API-handled. **The code's stated reason does not cover the case.** | 5 s |
| rejudge → `duckoj:monitor:v1` (5 s), `duckoj:pstats:v1` / `duckoj:pcounts:v1` (30 s), `duckoj:progress:v1` (60 s) | **no** — a rejudge deletes the scoreboard keys and recomputes the DB counters, but none of these five | 60 s worst case |

**The counters (D95/D100/D105) are clean** and are the best-invalidated thing in
the repo: `RejudgeService` recomputes `contest_problem_stats` **inside the same
transaction** that invalidates it, an AC being taken away recomputes rather than
decrementing (`packages/db/src/contest-stats.ts:125`), every delta is floored at
zero, and there is no submission-deletion path anywhere to leave a counter
orphaned. Disqualification deliberately does not move them, and the monitor says
why — it is a monitor, not a scoreboard.

The booklet / results / certificates / seats / samples caches are
**content-addressed**: a write does not strand a stale entry, it stops
addressing the old one. That only holds because none of those documents reads a
clock, which is true.

### D142 — the reason it was reserved

**D142 does not exist.** `docs/DECISIONS.md` runs D140 → D141 → **D143**; the
number was reserved and the decision never written. The only text is in
`loop-b34-auth-rehunt-report.md:51-53`, verbatim:

> **No `Cache-Control: no-store` on API responses**, recorded not fixed: a
> blanket header is a product ruling, `GET /packages/{hash}` is a long-cache
> candidate, and Express' default ETag forces a revalidation that 401s once
> signed out. Worth D142's own brief.

So the reason it was reserved and never spent is those three, and they pull in
opposite directions: a blanket `no-store` is a product decision rather than a
bug fix; `/packages/{hash}` is content-addressed and is the one route that
*wants* a long cache, so a blanket rule is wrong for it; and Express's default
ETag makes the status quo a revalidation that 401s after sign-out.

**And there is no HTTP-layer instance of this class to find.** Nothing in
`apps/api` sets any cache directive; the `Caddyfile`'s one `header` block sets
HSTS and the frame/content-type/referrer policies and no caching at all, and the
`/api/*` handle is a bare `reverse_proxy` — **Caddy is not a caching proxy
here**, so nothing can be served stale at the edge after a write. Reporting the
absence, since an unsupported all-clear is worse than a missed bug.

---

## What I could not finish

* **Nothing is deployed.** All three fixes are local commits on `main`. Until
  the controller ships `web`, a setter who reopens the problem or contest edit
  form after saving is still prefilled from the roster of values their own save
  replaced, and their next save still writes them back.
* **The seed-once residual is recorded, not fixed** — see the end of defects 1 and 2.
  Two people editing the same problem still race, and closing that means
  reseeding an undirty form when fresh data lands, which is a behaviour change
  needing its own decision.
* **No server-side cache fix.** All five gaps are TTL-bounded at 2–60 s and two
  of them are by design in D25's own words. Fixing them means API tests that
  start containers, which this slot's thermal caps make a bad trade for a
  bounded nuisance. **`contest.monitor.ts:113-118`'s justification being
  factually wrong about clarifications is the one worth a follow-up** — the
  comment should either stop claiming it or the two clarification writes should
  bust `duckoj:monitor:v1`.
* **No browser walk**, for the reason given above: the edge is at `470c182` and
  could only show these red. No live rows were created, so there is nothing to
  clean up under D153.
* **`D161`, `D162`, `D163` are all unused.** No fix changes a stated behaviour.
