# P6 — registration screen + submission→contest link

## Shipped

**1. `/register`** (`apps/web/src/routes/register.tsx`, new; route + links in
`router.tsx`, strings in `i18n/{en,vi}.ts`). Username, email, display name,
password + confirm, validated in vi/en before any request, mirroring
`RegisterRequest` clause for clause — the exact `[A-Za-z0-9_.-]` regex and
**password `min(10)`**, not `ResetPasswordRequest`'s stricter `min(12)`, which
would refuse valid passwords. `POST /auth/register` mints no cookie, so the
page chains `POST /auth/login`, invalidates `['me']` and navigates to `/`; if
that login fails the account still exists, so it says so and stays put.
`username_taken`/`email_taken` land on their own field (`aria-describedby` +
`aria-invalid`), anything else in a banner carrying `detail` verbatim, and a
`role="status"` note says the confirmation mail is on its way. Linked from
`RecoveryLink` (beside every signed-out `LoginForm`) and from the nav.

**2. `contestKey`/`contestLabel`** on `SubmissionSummary` + `SubmissionDetail`
(`packages/contracts/src/submissions.ts`), populated in
`apps/api/src/authz/submission.access.ts` by an aliased LEFT JOIN over
`contest_submissions ⋈ contest_participations ⋈ contests`, in **both**
`listVisible` and `getVisible`. Web: a `contest` column on `/submissions` and a
contest line on `/submissions/{id}`, both linking `/contests/$key` (em dash for
practice rows). openapi + SDK regenerated. D23 added.

**3. `apps/web/e2e/journey.spec.ts`** — journey 1 (register on the new screen →
signed in → VI default → EN toggle). Typechecked and linted only.

## Tests (red → green)

- `apps/api/test/submissions-contest-link.spec.ts` first: red (`expected
  undefined to be null` on `item.contestKey`, plus two `tsc` errors naming the
  missing fields), green after the join. It seeds a practice submission on a
  contest problem — the row any "contest ⊃ problem" reading fails — and asserts
  `items.length` to pin no fan-out.
- `apps/web/test/register.spec.tsx` (13 cases): red as a missing module, then 7
  red against the first implementation (a wrapping `<label>` folded each error
  into the field's accessible *name*). Mutations after green: dropping the
  validation guard and `fieldForCode`'s two branches → 7 red; dropping the
  chained `POST /auth/login` → 2 red; restored → 13 green.
- Web contest-link cases red first (no `Spring Cup 2026` link), green after.

Ritual green: typecheck (+scripts), lint (+scripts), `-r test` (**1051 tests /
138 files / 0 failures**), regen with no residual diff, `vite build`.

## Rulings (nobody was available to ask)

1. **`p5-e2e-report.md` does not exist** — only the brief; P5 runs concurrently
   on another branch. Read the brief instead.
2. **`e2e/journey.spec.ts` did not exist either**, so it was created, not
   extended, with journey 1 alone. **It will conflict with P5's at merge**: take
   P5's and re-apply the `/register` walk (API-path fallback is in a comment).
3. **`contestKey` carries no contest-visibility check** — **D23**. Matches the
   `contest` filter, which applies none either; a per-row check would cost
   `listVisible` its one-query property.
4. `contestLabel` is `contests.name` (the schema has no `title`).
5. The form is `noValidate`: `type="email"` otherwise lets the browser swallow
   the submit and answer in the *browser's* language, not the app's.
6. One pre-existing `getByText('—', {selector:'td'})` went ambiguous with the
   new column; widened, not deleted.

## Concerns

- **Podman flake**: `testDbUrl()` timed out (`Log message "/.*Started.*/" not
  received after 60000ms`) twice running, then passed in 4.5 s on the third
  try, with five sibling worktree agents active. Not a code fault; a loaded CI
  host may still see it.
- e2e **not run** (no live stack in this worktree, per the brief).
- `contestLabel` is the contest's *current* name: a rename renames every row.
