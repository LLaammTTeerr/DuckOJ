# P6 — registration screen + submission→contest link

## Shipped

**1. `/register`** (`apps/web/src/routes/register.tsx`, new; route + links in
`router.tsx`, strings in `i18n/{en,vi}.ts`). Username, email, display name,
password + confirm, validated in vi/en before any request, mirroring
`RegisterRequest` clause for clause — the exact `[A-Za-z0-9_.-]` regex and
**password `min(10)`**, not `ResetPasswordRequest`'s `min(12)`, which would
refuse valid passwords. `POST /auth/register` mints no cookie, so the page
chains `POST /auth/login`, invalidates `['me']` and navigates to `/`; if that
login fails the account still exists, so it says so and stays put.
`username_taken`/`email_taken` land on their own field, anything else in a
banner carrying `detail` verbatim. Linked from `RecoveryLink` and the nav.

**2. `contestKey`/`contestLabel`** on `SubmissionSummary` + `SubmissionDetail`
(`packages/contracts/src/submissions.ts`), populated in
`apps/api/src/authz/submission.access.ts` by an aliased LEFT JOIN over
`contest_submissions ⋈ contest_participations ⋈ contests`, in **both**
`listVisible` and `getVisible`. Web: a `contest` column on `/submissions` and a
line on `/submissions/{id}`, both linking `/contests/$key`. openapi + SDK
regenerated. D24 added (renumbered from D23 at merge).

**3. `apps/web/e2e/journey.spec.ts`** — journey 1 (register on the new screen →
signed in → VI default → EN toggle). Typechecked and linted only.

## Tests (red → green)

- `apps/api/test/submissions-contest-link.spec.ts` first: red (`expected
  undefined to be null` on `item.contestKey`, plus two `tsc` errors), green
  after the join. It seeds a practice submission on a contest problem — the row
  any "contest ⊃ problem" reading fails — and pins `items.length`, no fan-out.
- `apps/web/test/register.spec.tsx` (13 cases): red as a missing module, then 7
  red against the first cut (a wrapping `<label>` folded each error into the
  field's accessible *name*). Mutations after green: dropping the validation
  guard + `fieldForCode` → 7 red; the chained login → 2 red; the mail note → 1.
- Web contest-link cases red first (no `Spring Cup 2026` link), green after.

Ritual green: typecheck, lint, `-r test` (**1051 / 138 files / 0 fail**), regen
with no residual diff, `vite build`.

## Rulings (nobody was available to ask)

1. **`p5-e2e-report.md` does not exist** — only the brief; P5 runs concurrently
   on another branch. Read the brief instead.
2. **`e2e/journey.spec.ts` did not exist either**, so it was created with
   journey 1 alone. **It will conflict with P5's at merge**: take P5's and
   re-apply the `/register` walk (API-path fallback is in a comment).
3. **`contestKey` carries no contest-visibility check** — **D24**. Matches the
   `contest` filter; a per-row check would cost `listVisible` one query.
4. `contestLabel` is `contests.name` (the schema has no `title`).
5. The verification-mail note is **standing copy, future tense**, not a
   `role="status"` on success: success navigates away and unmounts the page, so
   a success-time note is never read — and the one path where it did survive
   (sign-in failing after the account was made) contradicted the alert beside it.
6. Form is `noValidate` (`type="email"` else answers in the *browser's*
   language); one pre-existing `getByText('—',{selector:'td'})` went ambiguous
   with the new column and was widened, not deleted.

## Concerns

- **Podman flake**: `testDbUrl()` timed out (`Log message "/.*Started.*/" not
  received after 60000ms`) twice running, then passed in 4.5 s on the third
  try, with five sibling agents active. Not a code fault; CI may still see it.
- e2e **not run** (no live stack in this worktree, per the brief);
  `contestLabel` is the contest's *current* name, so a rename renames every row.
