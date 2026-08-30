# F19 — reuse for teachers: an authoring round trip and two clones (D88)

**Status: DONE.** Nothing pushed.

## Shipped
**Round trip (F18's "not built").** `POST /problems/{code}/drafts/from-revision/{version}` unpacks a
revision's package and copies the files its manifest NAMES into a fresh draft under flat canonical
names — `draftCaseStem` and `DRAFT_CHECKER_FILE_NAME` moved into `@duckoj/contracts` and re-exported
by `pairing.ts`, so browser and server cannot name a case differently — rewriting the manifest to
match, so the draft is ordinary and buildable. `GET .../files/{name}` reads one file back as raw
bytes under the PUT's authorization; `loadEditableRevision` gives the 404-then-403 ordering. Web:
"Tải từ phiên bản đã công bố" fills the table from the published revision, then DISCARDS that draft
and builds through a fresh one.
**Problem clone.** `POST /problems/{code}/clone` → statement, editorial, tags, difficulty, and the
published revision's package as revision 1 (`draft`, same hash, no re-upload). Private, cloner as
sole author. Web: a "Nhân bản" panel on the edit screen that LINKS to the copy — a redirect would
discard unsaved edits to the form.
**Contest clone.** `POST /contests/{key}/clone` → format, config, precision, freeze, time limit,
problems (label/points/partial/order, by id) and orgs (D56), into a private contest at the new
window, validated as an edit would be. Web: "Nhân bản kỳ thi" → `/contests/new?cloneFrom=`, asking
for key/name/window and showing the rest read-only.

## Tests
11 API integration tests on `testDbUrl()` (`problem-from-revision`, `problem-clone`, `contest-clone`;
every fixture a Polygon-shaped nested package) and 7 web tests. The API tests and the two
test-data-tab tests were written first and seen red; the other five passed on first run, so mutation
checks are their whole red evidence. **32 mutations** were each applied, run and restored, and each
redded exactly its own test — load-bearing ones: no flattening in `planPrefill` (the draft rejects
`tests/01.in` outright), the draft keeping the un-rewritten manifest (D60 refuses the rebuild),
`readFile` skipping `resolve` (a stranger reads a private problem's tests), the problem clone
dropping `canCreateProblem` or carrying `editorialPublishedAt`, the contest clone dropping
`canRunContest` or `assertFreezeFits`.
Ritual: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts` green; regen left no diff;
`vite build` green. Tests green **per package under `--no-file-parallelism`** (api 980/980, web
495/495). Literal
`corepack pnpm -r test` is NOT: `apps/web` flaked 4 files under default file parallelism
(`submit.spec.tsx` among them — F18 saw the same; none touched here) and pnpm stopped there.

## Rulings (all in D88)
Cloning a problem needs EDIT rights on the source — it hands over the unpublished editorial and the
whole test set. Both clones are private and unpublished. The contest clone is 404 for a non-organiser
(matching `update`), 403 for someone who may not create contests; problems and orgs copied by id,
never re-resolved. A sample is inferred as `points === 0 && group === 0`. Only manifest-named files
round-trip: generators are dropped, and a no-edit round trip yields a new hash (paths flattened).

## Deviations / concerns
- Staged explicit paths, never `git add -A`. No migration; 0033 unused.
- `GET .../drafts/{draftId}/files/{name}` was not in the brief — the tab cannot show a test it cannot
  read, and the alternative was returning up to 512 MiB inline.
- A test file over 1 MiB cannot be loaded into the browser (refused by name, nothing loaded); an API
  client can still PUT one file into the pre-filled draft and build in place.
