# F18 — problem authoring in the browser (D87)

**Status: DONE.** Full verify ritual green; nothing pushed.

## Shipped

**API.** `POST /problems/{code}/drafts` → `PUT .../files/{name}` (raw bytes) → `POST .../build`,
plus `DELETE .../drafts/{draftId}`. All `problems:publish`; authorization mirrors `PATCH /problems/{code}` via a new public `ProblemAccessService.loadEditableProblem`. `buildPackage` moved
from `scripts/lib` into `@duckoj/package-format` (the scripts file re-exports it) so CLI, seed path
and API run one implementation — `apps/api` cannot import from `scripts/`. Build chains existing
paths: `buildPackage` → `PackagesService.upload` → `attachRevision` → optional `publishRevision` →
delete the draft; a refusal leaves the draft intact. Drafts are filesystem-only under
`<packageStoreDir>/drafts/<id>/`, `meta.json` outside `files/`; `DraftSweeper` reclaims disk hourly
while expiry is enforced per request. `readRawBody` extracted to `common/raw-body.ts` and shared
with `POST /packages`.

**Web.** `src/testdata/pairing.ts` (pure: `pairByStem`, `planPackage`) and
`src/routes/problem-testdata.tsx` — the "Dữ liệu chấm" tab: limits, checker (standard, or a testlib
source in the same lazy CodeMirror as the submit box), case table, bulk add by stem, per-file
progress, inline refusals, link into the revisions screen. vi/en both.

## Tests — red→green evidence

11 API integration tests on `testDbUrl()` (`apps/api/test/problem-drafts.spec.ts`), 14 web tests
(`apps/web/test/{problem-testdata,testdata-pairing}.spec.*`). Twelve mutations were each run and
each redded exactly its own test, then restored — the two most load-bearing:
`loadEditableProblem` → `findProblemRow` (no authz) turns the stranger's 404 into a 201, and
`putFile`'s temp file moved back inside `files/` packs a `.tmp-` orphan left by a killed worker into
the problem's package, changing its hash. The rest: the name regex, the `problemId` and expiry
checks, both caps, the verbatim build message, deleting the draft before the attach, `missing-answer`
pairing, `.out`-over-`.a` preference, a sample's zero points, and `manifest.json` first.

Ritual: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`, `-r test` (api 943, web 482,
every package green), regen with no diff, `vite build`.

## Rulings (all recorded in D87)

No zips — 7a stands, a bulk add is many individual files paired client-side. No drafts table: the
files must live on the shared volume anyway, so a row would be a second source of truth. Expiry at
access time, sweeper for disk only. Flat names, `.`/`..` refused by name as well as by pattern (the
class admits both). A sample is `points: 0, group: 0` — the manifest has no sample flag and did not
gain one. `problems:publish`, not `packages:write`. Unrecorded elsewhere: the publish control says "Công bố",
the revisions screen's existing word, not the brief's "Xuất bản" — the link lands on that screen.

## Deviations / concerns

- Staged explicit paths, never `git add -A` — the brief overrides `conventions.md`.
- No migration; 0032 was reserved and not needed.
- `i18n.spec.tsx` gained `testData.unpaired.` to its dynamic-key prefixes.
- `apps/web` flaked twice under default file parallelism (`editor.spec.tsx`, `settings.spec.tsx`,
  neither touched here); the same command re-run and the `--no-file-parallelism` run both pass
  482/482.
- The build re-unpacks the archive it just made (inside `upload`) — deliberate, one validation path,
  a few hundred ms on a large test set.
- Not built: reading an existing revision's test data back into the tab.
- Files, per commit: `03ae314` (API + contracts + regen), `7f3cf3e` (web), then the docs commits.
