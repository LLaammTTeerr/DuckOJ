# loop-f34 — per-viewer status filter on the problem list (D125)

**Status: DONE**

## What shipped
`GET /problems` gains `status = solved | attempted | unsolved`, and every list
row + the detail carries `myStatus: 'solved' | 'attempted' | null` for a ✓/…
marker. One statement, no N+1.

- **Contracts** (`packages/contracts/src/problems.ts`): `ProblemStatusFilter`
  (3-valued) added to `ProblemListQuery`; `ProblemMyStatus` (2-valued nullable)
  added to `ProblemSummary`; `/problems` summary+description updated. openapi +
  SDK regenerated, no diff left.
- **API** (`apps/api/src/authz/problem.access.ts`): a second
  `LEFT JOIN LATERAL` (`meSolvedLateral`) beside the existing best-verdict one
  — a window-gated closed-`AC` existence probe reusing `contestWindowOpenWhere`
  (D49). `toMyStatus` folds it + `meVerdict` into the field; the `status`
  filter reads the same two laterals. Wired into all three `toSummary` paths
  (list, detail, `loadDetailById`). Controller passes `status` through.
- **Web** (`router.tsx`, `routes/problems.tsx`, i18n vi/en): a `<select>` shown
  only when signed in, URL-wired via `validateSearch` + the route `key`; a
  per-row glyph marker with `aria-label` (never colour alone).

## Rulings (D125)
- **"solved" is window-gated** like `solvedCount`: an in-contest `AC` reads
  `attempted` until the round ends, so `me.verdict==='AC'` can sit beside
  `myStatus:'attempted'` mid-round (deliberate, not a bug).
- **Anonymous + status → 422 `status_requires_auth`** (not silently ignored — a
  wrong 200 otherwise); `myStatus` stays `null` for anon.
- **In-flight-only submissions read unsolved** (mirrors `me`'s graded-only rule).
- **`status` does NOT widen the D35 hidden-problem exclusion** — it reads the
  viewer's own submissions, which D35 never masks; tag/difficulty keep theirs.

## Tests — `apps/api/test/problem-status-filter.spec.ts` (8) + web (3)
Each status, composability with tag/difficulty, anon 422, freeze open→attempted
/ closed→solved, detail agreement, one-statement query-log proof.
- **Mutation checks (red→green):** (A) drop the window-gate in `meSolvedLateral`
  → freeze test reddens (`w-live` becomes solved); (B) neutralise the filter
  conditions → filter test reddens; (C) web: disable the solved glyph → marker
  test reddens. All restored, all green.

## Verify ritual
typecheck (all pkgs + scripts), lint (all + scripts), contracts (39), web (601),
api (1120/1121 — the 1 fail was `problem-comments` D109 timing out at 5s under
full-suite container load; passes in isolation, unrelated to this change),
openapi+SDK regen clean, `vite build` OK. D113 source-scan guard stays green
(`me_solved` keys on `submissions.user_id`).
## Concerns
- The full-suite `problem-comments` 5s flake is pre-existing (container
  contention under parallel runs), not introduced here.
