# P1-A — rejudge, disqualify, contest edit, login rate limit

**DONE_WITH_CONCERNS.** Four commits on `main`: `9eaa670` rejudge ·
`bc01c4e` disqualify · `8855bc0` contest edit · `a41aad6` login rate limit.
Migration 0016 **unused** — every table needed already existed.

## Shipped
1. **Rejudge** — `POST /admin/submissions/{id}/rejudge` (202
   `{submissionId, jobId}`) and `POST /admin/problems/{code}/rejudge` (202
   `{submissionsQueued}`), `@SessionOnly` + admin inside
   `apps/api/src/authz/rejudge.access.ts`. It **re-queues the existing
   `grading_jobs` row** with `attempt+1`: a new row leaves the old row's
   attempt still, and `EventWriter.fencedById` keys on that row — a stale
   in-flight attempt would overwrite the rejudge. `created_at` is restamped
   so "newest first" survives `claim()`'s `ORDER BY created_at`. Publishes on
   `SUBMISSION_CHANNEL` via a lazy `RedisSubmissionPublisher` (the API's
   first publisher; no socket until something publishes).
2. **Disqualify** — `PATCH /contests/{key}/participants/{username}`,
   creator-or-admin, 404 invisible / 403 `contest_forbidden` visible; all of
   that user's participations move together. `canEdit` added to
   `GET /contests/{key}`. `lower.ts`/`scoreboard.ts` already honoured the
   flag: pinned, not changed (goldens untouched). Web: `[DQ]`, struck-through
   row, per-row DQ/un-DQ for organisers.
3. **Contest edit** — `PATCH /contests/{key}`; hand-written optional schema
   (no `.partial()`, whose defaults would privatise on every edit),
   merged-state validation, 409 `contest_started` on a real
   `format`/`problems` change. Web `contest-edit.tsx` at `/contests/$key/edit`.
4. **Login rate limit** — 10/identifier + 30/IP per 15 min, purpose `login`,
   429 `login_rate_limited` + `Retry-After`. `RateLimiter` grew
   `retryAfterSeconds`/`record`; `AppError` grew `headers`; D16 added.

## Tests
New `apps/api/test/{rejudge,contest-disqualify,contest-edit,login-rate-limit}.spec.ts`
and `apps/web/test/{rejudge,contest-disqualify,contest-edit}.spec.tsx`.
**33 mutants run, 33 killed.** Two DQ mutants survived at first —
`contest-formats` resolves through `dist`, exactly the runbook's
"dist-resolution can make a mutation test lie"; re-run with `tsc -b` in the
loop, both died. Full ritual green: `-r typecheck`, `typecheck:scripts`,
`-r lint`, `lint:scripts`, `-r test` (**929 tests, 0 failures**), contracts
+ SDK regen leaves no diff, `vite build` clean.

## Rulings
- Re-queue, never a new job row (the fence keys on the job row's id).
- Single-submission rejudge keeps its pinned revision; a problem rejudge
  moves `submissions.revision_id` to the current published one; no published
  revision → 409 `problem_not_submittable`.
- A rejudge touching a rated contest calls `replayAll()` (D4) — both routes.
- DQ excludes from *standing*, not from the page: rows stay (the brief's own
  `[DQ]` rendering needs one), rank last, drop out of the rated field. DQ
  moves every participation; the summary is the highest `virtual`.
- Contest `key`/`orgSlugs` immutable; `visibility:'org'` with no existing
  share → 400 `contest_org_required`.
- Pre-start problem-list concealment widened from admins to `canRunContest`
  (same on the scoreboard 409): otherwise the edit form prefills empty and
  saves that over the real problem list.
- Every login 401 counts, `totp_required` included; the 429 records nothing.
- `apps/api/tsconfig.test.json` `rootDir` → `apps/`, so the fencing test can
  reach `apps/judged/src` relatively. A `@duckoj/judged` dep would drag
  judged's source and dev-deps into the API image (`dockerfile-manifest`
  derives the COPY manifest from that graph) for one spec file.

## Concerns
- **404/403 asymmetry**: the brief specifies 403 for a visible-but-forbidden
  disqualify and 404 for the same actor on edit. Both verbatim; two adjacent
  routes with one permission rule now answer differently. Worth harmonising.
- **`replayAll()` fires on queueing, not completion** — it folds scoreboards
  whose case rows the rejudge just deleted, so ratings are briefly computed
  against zeroed scores and nothing re-replays when grading finishes. The
  brief mandates the call; someone must re-rate afterwards.
- Realtime publishing is best-effort and logged, never fatal.
- Contest `orgSlugs` still cannot be edited anywhere.
