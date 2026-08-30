# loop-f27 — diff a submission against the viewer's earlier attempt (D111)

Status: DONE.

## What shipped
- `GET /submissions/{id}/previous` → `{ previousId }`: caller's most recent
  OWN submission to the same problem with `id < {id}`, same language preferred.
- `GET /submissions/{id}/diff?against={otherId}` → both sources +
  server-computed unified hunks (`context`/`added`/`removed`); web ships no
  diff lib.
- Web: "So sánh với lần nộp trước" toggle on `/submissions/{id}`, unified diff
  with +/− glyphs (real text, not colour-alone, B-20/D77) + `.sr-only` labels,
  tint mixed from the verdict palette. i18n vi+en.
- D111 recorded; no new table, no cache, no migration.

## Security shape
Both ids go through `getVisible` (the predicate the `source` field uses); diff
404s unless BOTH return non-null `source`. That `source === null` check IS the
D23+D27 gate — source-hidden is a superset of frozen — so no separate freeze
check. A rival's live contest source can never leak this way.

## Files
`apps/api/src/submissions/line-diff.ts` (new, LCS + DP cap);
`apps/api/src/authz/submission.access.ts` (`getPrevious`, `diff`);
`apps/api/src/submissions/submissions.controller.ts` (2 routes);
`packages/contracts/src/submissions.ts` → `openapi.json` +
`packages/sdk/src/generated.ts` (regen idempotent);
`apps/web/src/routes/submission.tsx` (+`DiffView`), `app.css` (`.diff*`),
`i18n/{vi,en}.ts`; tests `apps/api/test/{line-diff,submission-diff}.spec.ts`,
`apps/web/test/submission-diff.spec.tsx`; `docs/DECISIONS.md` (D111).

## Tests / evidence
- TDD red→green: `line-diff.spec.ts` written before the module (red on missing
  import) → green (6). Integration `submission-diff.spec.ts` (7): own previous,
  same-language pref, identical→no hunks, changed→add/remove, cross-user 404,
  masked-during-freeze 404 (D27), cross-problem 422.
- Mutation (security): commenting out the `source === null` refusal turned the
  D27 freeze test RED; restored → green.
- Web (2): toggle only with a previous attempt; diff renders +/− glyph-marked
  tinted lines on demand.

## Rulings (no human available)
- "Previous" ordered by `id` not clock; same-language preferred, fall back.
- Cross-problem diff → 422 `diff_problem_mismatch` (both visible, no oracle).
- DP size cap 4M cells → whole-file-replace fallback (`/diff` is an unmetered
  read over ≤64 KiB sources).

## Verify
`pnpm -r typecheck`, `typecheck:scripts`, `pnpm -r lint`, `lint:scripts`,
contracts tests, API submission+authz specs (56), web submission/i18n/app-css
all green; regen idempotent; `vite build` clean.

## Left out
Side-by-side view (contract carries both sources; one component away).
