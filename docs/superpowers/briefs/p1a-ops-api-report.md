# P1-A — rejudge, disqualify, contest edit, login rate limit

**DONE_WITH_CONCERNS.** `9eaa670` rejudge · `bc01c4e` disqualify · `8855bc0` contest edit ·
`a41aad6` login rate limit, plus this report. Migration 0016 **unused** — every table needed
already existed.

## Shipped
1. **Rejudge** — `POST /admin/{submissions/{id},problems/{code}}/rejudge`, 202, `@SessionOnly` +
   admin inside `apps/api/src/authz/rejudge.access.ts`. It **re-queues the existing
   `grading_jobs` row** with `attempt+1`: a new row leaves the old row's attempt still, and
   `EventWriter.fencedById` keys on that row, so a stale in-flight attempt would overwrite the
   rejudge. `created_at` is restamped so "newest first" survives the `created_at` order
   `claim()` takes. Publishes on `SUBMISSION_CHANNEL` via a lazy `RedisSubmissionPublisher` (the
   API's first). Admin-only Rejudge buttons on the submission page and the problem edit screen.
2. **Disqualify** — `PATCH /contests/{key}/participants/{username}`, creator-or-admin; every
   participation that user holds moves together. `canEdit` added to `GET /contests/{key}`.
   `lower.ts`/`scoreboard.ts` already honoured the flag: pinned, not changed. Web: `[DQ]`,
   struck through, per-row DQ / un-DQ for organisers.
3. **Contest edit** — `PATCH /contests/{key}`; hand-written optional schema (not `.partial()`,
   whose defaults would privatise on every edit), merged-state validation, 409 `contest_started`
   on a real `format`/`problems` change. Web `contest-edit.tsx`, prefilled, linked when
   `canEdit`.
4. **Login rate limit** — 10/identifier + 30/IP per 15 min, purpose `login`, 429
   `login_rate_limited` + `Retry-After`. `RateLimiter` grew `retryAfterSeconds`/`record`;
   `AppError` grew `headers`; D16 added.

## Tests
New `{rejudge,contest-disqualify,contest-edit,login-rate-limit}.spec.ts` in `apps/api/test` and
`{rejudge,contest-disqualify,contest-edit}.spec.tsx` in `apps/web/test`. **51 mutants run and
51 killed** — two survived at first because `contest-formats` resolves through `dist` (the
runbook's "dist-resolution can make a mutation test lie"); with `tsc -b` in the loop, both died.
Full ritual green, **925 tests, 0 failures**; regen leaves no diff; `vite build` clean.

## Rulings
- Re-queue, never a new job row (the fence keys on the job row's id).
- A single-submission rejudge keeps its pinned revision; a problem rejudge moves
  `submissions.revision_id` to the current published one; none → 409 `problem_not_submittable`.
  Either, touching a rated contest, calls `replayAll()` (D4).
- DQ excludes from *standing*, not from the page: rows stay (the brief's own `[DQ]` rendering
  needs one), rank last, drop out of the rated field.
- Contest `key`/`orgSlugs` immutable; `visibility:'org'` with no share → 400
  `contest_org_required`. The edit form round-trips each problem's `label` — `problems` is
  replaced wholesale, so dropping it destroys labels and turns an untouched save into a false
  `contest_started`.
- Pre-start problem-list concealment widened from admins to `canRunContest` (same on the
  scoreboard's 409), or the edit form prefills empty.
- Every login 401 counts, `totp_required` included; the 429 records nothing.
- `apps/api/tsconfig.test.json` `rootDir` → `apps/`, so the fencing test reaches
  `apps/judged/src` relatively; a `@duckoj/judged` dep would drag its source and dev-deps into
  the API image for one spec file.

## Concerns
- **404/403 asymmetry**: the brief specifies 403 for a visible-but-forbidden disqualify and 404
  for the same actor on edit. Both verbatim; two adjacent routes with one rule now answer
  differently.
- **`replayAll()` fires on queueing, not completion** — it folds scoreboards whose case rows the
  rejudge just deleted, so ratings are briefly wrong and nothing re-replays when grading ends.
  Someone must re-rate afterwards.
- Realtime publishing is best-effort. Contest `orgSlugs` remain uneditable.
