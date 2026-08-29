# P10: source-access select on the problem edit screen

## What shipped
A labelled `<select id="problem-source-access">` on `/problems/:code/edit`
(edit route only — see ruling below), prefilled from `GET /problems/{code}`'s
`sourceAccess` and resubmitted through the existing `PATCH /problems/{code}`
path. Options are `private` / `solved` (`ProblemSourceAccess` in
`packages/contracts/src/problems.ts`; no `public` value exists — design
2026-08-21-submission-source-visibility-design.md §2.3 stops at "anyone who
has solved it").

## Files
- `apps/web/src/routes/problem-edit.tsx` — `SourceAccess` type, `SOURCE_ACCESSES`
  const, `sourceAccess` state seeded in the existing prefill effect, added to
  the PATCH body, and the new labelled select (edit-only).
- `apps/web/src/i18n/en.ts` / `vi.ts` — `problemEdit.sourceAccess` (field
  label) and `sourceAccess.private` / `sourceAccess.solved` (full human
  meaning per option, matching design §2.3: `private` names the fixed access
  list — submitter, admins, authors/curators — `solved` names only what it
  adds on top).
- `apps/web/test/problem-edit.spec.tsx` — new test plus a `sourceAccess`
  field on the shared `PROBLEM_DETAIL` fixture and a `mockedPatch`.

## Tests
`prefills the source-access select from GET, and PATCH carries a change to
it`: renders the edit page with `sourceAccess: 'solved'` from GET, asserts
the select shows `solved`, changes it to `private`, submits, asserts the
PATCH body carries `sourceAccess: 'private'`.

Red -> green: written before the component change, failed on
`findByLabelText(/Quyền xem mã nguồn/)` (no such field yet). Implemented,
reran — 6/6 passed. Mutation check: removed `sourceAccess` from the PATCH
body only, reran — exactly the new test's PATCH-body assertion reddened
(`expected undefined to be 'private'`), other 5 stayed green; restored from
a `cp` backup, reran — 6/6 green again.

Full web suite: 28 files / 203 tests green (includes `test/i18n.spec.tsx`,
the en/vi key-parity guard, both directions).

## Verification run
`corepack pnpm --filter @duckoj/web typecheck`, `-r typecheck`,
`typecheck:scripts`, `--filter @duckoj/web lint`, `-r lint`, `lint:scripts`,
`--filter @duckoj/web test` (203/203), `--filter @duckoj/web exec vite
build` — all green.

**Ruling: skipped repo-wide `pnpm -r test`.** The brief's convention runs it,
but `apps/api`'s integration tests bring up Postgres via podman
(`apps/api/test/db.harness.ts`), and the parent instruction for this task was
explicit — touch only `apps/web/**` (plus this report) and do not touch the
live stack except the final `vite build`. Ran the web-scoped test command
instead; typecheck/lint were run repo-wide since those touch nothing live.

**Ruling: select is edit-only.** `CreateProblemRequest`
(`packages/contracts/src/problems.ts`) has no `sourceAccess` field at all —
design §5: "a problem is created closed and opened deliberately, never as a
default nobody chose." The select and the PATCH-body field only exist on the
edit path; the create route is unchanged.

**No contracts/SDK regen needed.** `packages/sdk/src/generated.ts` already
had `sourceAccess: "private" | "solved"` on the GET response and
`sourceAccess?: "private" | "solved"` on the PATCH body — carried over from
whichever earlier task shipped the API side of this design. Nothing to
regenerate.

## Left out
Nothing from the task scope. Out of scope per the design doc and untouched:
a `public` source-access value, contest-time overrides, testcase visibility.
