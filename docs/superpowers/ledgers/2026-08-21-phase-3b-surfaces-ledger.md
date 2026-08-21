# Phase 3b decision ledger — API completeness and the retro terminal

**What this is.** The record of every decision made while implementing Phase
3b, written as the work happened.

**Read this before Phase 4.** The deferred table is its input.

| Deferred | Ruling |
|---|---|
| **The `me` column shows the *latest* verdict, not the best.** One `GET /submissions?user=<self>&limit=100` per page render, never per row. A problem outside the most recent 100 submissions shows nothing even when a verdict exists | R8 — "best" needs either an aggregate the API does not expose or a scan the list must not do, and a wrong "best" is worse than an honest "latest" |
| **Membership mutation for organizations** — invite, approve, remove. `POST /orgs` and `PATCH /orgs/:slug` were specced and are **not built**; only the read side and the scope exist | Spec §2.3 — it needs the join-request state machine `org_join_requests` already models, and half-implementing that is worse than not starting |
| **No Playwright coverage for the revisions page.** Fresh registrations cannot reach setter/admin, `test:e2e` is not in CI, and the `e2eset*` accounts are non-reproducible dev-DB debris. Covered by vitest instead | B3's ruling, accepted: a committed browser test coupled to a hand-made dev account is fragile in a way that will fail for the next person, not for us |
| **A throwaway problem `e2erevtest1787293732` is permanent dev-stack data** — the screenshot subject for the draft-only null case | Dev data is disposable by the project's founding constraint; recorded so nobody mistakes it for a fixture |
| **`GET /submissions` has no aggregate**, so "solved count" and "best verdict per problem" are not answerable without scanning | Named here because two Phase 4 features (scoreboards, problem statistics) both need it |
| Everything in Phase 3a's deferred table that 3b did not touch | Carried unchanged |

---

## The rulings

**R1 — the Vietnamese check that looked like a failure and was not.**
`document.fonts.check('14px "IBM Plex Mono"', '<vietnamese>')` returns **false**
on a working page. Chased rather than accepted: driving a real browser shows
`ibm-plex-mono-vietnamese-400-*.woff2` fetched **the instant Vietnamese text is
inserted** — `unicode-range` subsets load lazily, so a page with no Vietnamese
never requests it — and the string measures 544 px in Plex against 573 px in
generic monospace. Different metrics prove Plex set it. The API is conservative
across subset splits; the evidence beats the API.

**R2 — a mockup does not outrank a test.** The mockup specifies a 1060 px
column; Playwright asserts `main` ≤ 1000 px. The implementer sized to 960 and
said so rather than editing the assertion. Correct: the assertion exists to
catch an *unconstrained* column and 1000 was an arbitrary ceiling, but not
editing a test to fit a drawing is the part that matters.

**R3 — Stream A generalised the constraint instead of satisfying it.** §4.1
asked for a *test* proving `GET /submissions` and `GET /submissions/:id` agree.
It extracted `submission.visibility.ts` with the same two-form shape as
`problem.visibility.ts` — `canViewSubmission(actor, ownerId)` for a row in hand,
`visibleSubmissionsWhere(actor)` for a `WHERE` clause — pointed both call sites
at it, **and** wrote the test. A test proves they agree today; a shared
predicate makes disagreement require deliberately writing a second copy.

**R4 — mutation evidence in both directions, only one of which I asked for.**

    laxer    -> expected [1,2,3,4,5,6,7] to deeply equal [1,2,3,6]
    stricter -> expected [1,2,3]         to deeply equal [1,2,3,6]

The second is the more valuable half. A list that is too *strict* leaks
nothing, so it passes every security-minded check — and silently hides a user's
own work from them. Proving the property bidirectionally makes it an invariant
rather than a leak test.

**R5 — brief defect: I described a file I had not opened.** I wrote "update the
vocabulary test by hand", presupposing one existed in
`packages/contracts/test/scopes.spec.ts`. It did not.

**R6 — descending keyset pagination.** Ascending's `gt(id, after)` has a free
sentinel (`after = 0`); descending's `lt(id, before)` has none, so an absent
cursor **omits the condition** rather than coercing to infinity, and
`nextCursor` is the page's *smallest* id. Recorded because every other list in
this codebase is ascending and the next reader will assume this one is.

**R7 — brief defect, again: I asserted `ProblemSummaryDto` "should already
carry" `testCount`.** It did not; only `ProblemDetail` did. The implementer
verified against the mapper, refused to fetch it per row, left the column out,
and said the fix belonged outside its scope. Right on every count.

**R8 — the `me` column's limits, disclosed rather than discovered.** See the
deferred table.

**R9 — my own test did not pin what its comment claimed.** I added `testCount`
with a `revisionId === null ? null : ...` guard and wrote that the test pins it.
Mutation says otherwise: removing the guard leaves all 15 tests green, because
a draft-only problem has **no `currentRevisionId` at all**, so the leftJoin
matches nothing and every revision column is already SQL NULL before the guard
runs. The guard is belt-and-braces; the join's `state = 'published'` term
carries the weight. Comment corrected.

The general form, and it applies to everyone: **writing a guard and a test in
the same commit does not mean the test covers the guard.** I would have shipped
that assumption without mutating my own work.

**R10 — the stale-artifact class, third distinct form.** `testCount` was
silently absent from live responses despite correct source, because both the
running `api` container **and** `packages/sdk/dist` predated the commit. This
project has now hit the same class three ways: a stale `dist/` defeating a
mutation check (3a R20), a stale image serving old code while reporting healthy
(2b R61), and now a stale generated SDK. The shared shape is that a build
artifact and its source disagree, and every symptom appears somewhere other
than where the cause is.

**R11 — the CLAUDE.md graphify rule was rewritten to match measured
behaviour.** The installed rule said to query the graph first for any codebase
question; I then used `git grep` for six hours without noticing. Measured
rather than argued: asked the graph a question grep had answered in six lines
and got 296 nodes truncated to 59, including ledger rulings about package
hashing, because the edges are imports and a BFS from a 69-edge hub returns
most of the repo. Rule now reads structural → grep, cross-document → graph.
A rule nobody follows is worse than no rule.

---

## Acceptance

All gates green from a clean tree with `dist/` **and** `tsconfig.tsbuildinfo`
deleted: **465 tests** across 12 packages, plus 9 Playwright tests in a real
browser.

Verified by screenshot in both colour schemes, signed in, on the running stack
— the check that found every visual regression this phase and that no test
would have caught:

- Problem list: `TIME` / `MEM` / `TESTS` as separate right-aligned columns,
  `64 MB` not `65536 KB`, `ME` showing `x WA`, and a draft-only problem
  correctly showing `—` in all three revision-derived columns.
- Submissions list: newest first, `+ AC` / `x WA` glyph-and-colour badges,
  points as `3/3`, problem-code and username filters.
- Fonts self-hosted: zero `googleapis`/`gstatic` references in the built
  output, six fingerprinted subsets served, Vietnamese fetched on demand.
