# F18 — problem authoring in the browser (D87)

**Status: DONE.** Full verify ritual green; nothing pushed.

## Shipped

**API.** `POST /problems/{code}/drafts` → `PUT .../files/{name}` (raw bytes) →
`POST .../build`, plus `DELETE .../drafts/{draftId}`. All `problems:publish`;
authorization mirrors `PATCH /problems/{code}` via a new public
`ProblemAccessService.loadEditableProblem`. `buildPackage` moved from
`scripts/lib` into `@duckoj/package-format` (the scripts file re-exports it) so
CLI, seed path and API run one implementation — `apps/api` cannot import from
`scripts/`. Build chains existing paths: `buildPackage` → `PackagesService
.upload` → `attachRevision` → optional `publishRevision` → delete the draft; a
refusal leaves the draft intact. Drafts are filesystem-only under
`<packageStoreDir>/drafts/<id>/`, `meta.json` outside `files/`; `DraftSweeper`
reclaims disk hourly while expiry is enforced per request. `readRawBody`
extracted to `common/raw-body.ts` and shared with `POST /packages`.

**Web.** `src/testdata/pairing.ts` (pure: `pairByStem`, `planPackage`) and
`src/routes/problem-testdata.tsx` — the "Dữ liệu chấm" tab: limits, checker
(standard, or a testlib source in the same lazy CodeMirror as the submit box),
case table, bulk add by stem, per-file progress, inline refusals, link into the
revisions screen. vi/en both.

## Files

`packages/package-format/src/{build,index}.ts`, `scripts/lib/build-package.ts`,
`packages/contracts/src/{problem-drafts,index}.ts`, `openapi.json`,
`packages/sdk/src/generated.ts`, `apps/api/src/common/raw-body.ts`,
`apps/api/src/packages/{draft.store,packages.controller,packages.module}.ts`,
`apps/api/src/problems/{problem-drafts.controller,problem-drafts.service,draft.sweeper,problems.module}.ts`,
`apps/api/src/authz/problem.access.ts`, `apps/api/test/problem-drafts.spec.ts`,
`apps/web/src/testdata/pairing.ts`, `apps/web/src/routes/{problem-testdata,problem-edit}.tsx`,
`apps/web/src/i18n/{en,vi}.ts`, `apps/web/test/{problem-testdata,testdata-pairing,i18n}.spec.*`,
`docs/DECISIONS.md`.
## Tests — red→green evidence

11 API integration tests on `testDbUrl()`, 14 web tests. Each behaviour was shown
failing against broken code, then restored: dropping `DraftFileName`'s regex reds
the path test; dropping the `problemId`/expiry checks reds the cross-problem and
expiry tests; `loadEditableProblem` → `findProblemRow` reds the authz test (201
where 404 expected); disabling either cap reds both cap tests; flattening
`buildPackage`'s message reds the refusal test; deleting the draft before the
attach reds the build-success test; dropping `missing-answer` reds the pairing and
bulk-add tests; ranking `.a`/`.out` by arrival order reds the preference test;
`points: c.points` for a sample reds the sample test; `manifest.json` last reds the
PUT-order test; `error.code` for `error.detail` reds the verbatim test.

Ritual: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`, `-r test`
(api 943, web 482, every package green), regen with no diff, `vite build`.

## Rulings (all recorded in D87)

No zips — 7a stands, a bulk add is many individual files paired client-side. No
drafts table: the files must live on the shared volume anyway, so a row would be a
second source of truth. Expiry at access time, sweeper for disk only. Flat names,
`.`/`..` refused by name as well as by pattern (the class admits both), re-checked
in the store. A sample is `points: 0, group: 0` — the manifest has no sample flag
and did not gain one. `problems:publish`, not `packages:write`.

## Deviations / concerns

- Staged explicit paths, never `git add -A` — the brief overrides `conventions.md`.
- No migration; 0032 was reserved and not needed.
- `i18n.spec.tsx` gained `testData.unpaired.` to its dynamic-key prefixes.
- `apps/web` flaked twice under default file parallelism (`editor.spec.tsx`,
  `settings.spec.tsx`, neither touched here); the same command re-run and the
  `--no-file-parallelism` run both pass 482/482.
- The build re-unpacks the archive it just made (inside `upload`) — deliberate,
  one validation path, a few hundred ms on a large test set.
- Not built: reading an existing revision's test data back into the tab.
