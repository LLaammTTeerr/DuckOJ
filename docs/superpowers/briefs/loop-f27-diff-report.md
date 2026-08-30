# loop-f27 — diff a submission against the viewer's earlier attempt (D111)

## What shipped
- `GET /submissions/{id}/previous` → `{ previousId }`: caller's most recent OWN
  submission to the same problem with `id < {id}`, same language preferred.
- `GET /submissions/{id}/diff?against={otherId}` → both sources + server-computed
  unified hunks (`context`/`added`/`removed`); web ships no diff lib.
- Web: "So sánh với lần nộp trước" toggle on `/submissions/{id}`; +/− glyphs as
  real text (not colour-alone, B-20/D77) + `.sr-only` labels, verdict-palette
  tint. i18n vi+en. No new table, no cache, no migration.

## Security shape
Both ids go through `getVisible` (the predicate the `source` field uses); diff
404s unless BOTH return non-null `source`. That `source === null` check IS the
D23+D27 gate — source-hidden is a superset of frozen — so no separate freeze
check. A rival's live contest source can never leak this way.

## Files
`apps/api/src/submissions/line-diff.ts` (new: LCS + DP cap);
`authz/submission.access.ts` (`getPrevious`, `diff`); `submissions.controller.ts`
(2 routes); `packages/contracts/src/submissions.ts` → `openapi.json` +
`sdk/generated.ts` (regen idempotent); `web/routes/submission.tsx` (+`DiffView`),
`app.css` (`.diff*`), `i18n/{vi,en}.ts`; tests
`api/test/{line-diff,submission-diff}.spec.ts`, `web/test/submission-diff.spec.tsx`;
`docs/DECISIONS.md` (D111).

## Tests / evidence
- TDD red→green: `line-diff.spec.ts` before the module (red on missing import) →
  green (6). Integration `submission-diff.spec.ts` (7): own previous, same-lang
  pref, identical→no hunks, changed→add/remove, cross-user 404, masked-during-
  freeze 404 (D27), cross-problem 422.
- Mutation (security): commenting out the `source === null` refusal turned the
  D27 freeze test RED; restored → green.
- Web (2): toggle only with a previous attempt; +/− glyph-marked tinted lines.

## Rulings (no human available)
- "Previous" ordered by `id` not clock; same-language preferred, fall back.
- Cross-problem diff → 422 `diff_problem_mismatch` (both visible, no oracle).
- DP cap 4M cells → whole-file-replace fallback (`/diff` is an unmetered read).

## Verify (foreground, all green)
`-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`; contracts (39);
API app.boot + submission-family + authz-default serially (73); web SubmissionPage
specs incl rejudge/socket/query-retry/read-errors + i18n/app-css (92); regen
idempotent; `vite build` clean. `test:ci` uses bare `pnpm` (not on PATH), so the
whole-repo run was verified by the affected suites above rather than one pass.

## Left out
Side-by-side view (contract carries both sources; one component away).
