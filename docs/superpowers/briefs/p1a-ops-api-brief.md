# Task P1-A — ops features: rejudge, disqualify, contest edit, login rate limit

Read `docs/superpowers/briefs/conventions.md` first. Migration numbers
reserved for you: 0016 (if you need one at all — you probably do not).

## 1. Rejudge
- `POST /admin/submissions/{id}/rejudge` → 202 `{ submissionId, jobId }`.
- `POST /admin/problems/{code}/rejudge` → 202 `{ submissionsQueued: number }`
  (every submission of that problem, newest first; use the CURRENT published
  revision's package hash).
- Semantics: reset the submission to `queued` (clear verdict/points/time/
  memory, delete its case rows), bump `grading_jobs.attempt`/insert a new
  `grading_jobs` row exactly the way `SubmissionAccess.create()` does — read
  `apps/api/src/authz/submission.access.ts` ~line 110-140 and `apps/judged/src/job-store.ts`
  `claim()` to decide whether a NEW job row or a re-queued old row is right;
  the judged fencing (`fencedById` in `apps/judged/src/event-writer.ts`) must
  keep working — a stale attempt must not overwrite the rejudge. Add an
  integration test proving a rejudged submission gets re-claimed by
  `claim()` and the stale attempt's write is fenced.
- Publish the realtime `submissions` update (same channel `create` uses) so
  open pages refresh.
- Rating: D4 says regrading changes rating history — after a problem
  rejudge, if any affected submission belongs to a rated contest, call
  `RatingService.replayAll()` (see `apps/api/src/authz/rating.service.ts`).
- Tag: `Admin`. Session-only + admin (403 `admin_forbidden`; 404 unknown).
- Web: a "Rejudge" button on `apps/web/src/routes/submission.tsx` and on the
  problem page's edit screen (`problem-edit.tsx`), admin-only (`me.globalRole === 'admin'`),
  with confirm() and busy flag.

## 2. Disqualify
- `PATCH /contests/{key}/participants/{username}` body
  `{ disqualified: boolean }` → 200 participation summary. Allowed for the
  contest creator and global admins; others 404 (contest) / 403
  `contest_forbidden` (visible contest, not allowed). Tag `Contests`.
- `contest_participations.is_disqualified` already exists; the scoreboard
  lowering must exclude disqualified participants (check
  `packages/contest-formats/src/lower.ts` — if it already honours it, test it;
  if not, add).
- Web: on the scoreboard (`contests.tsx`) a `DQ`/`un-DQ` link per row for
  allowed actors; disqualified rows rendered struck-through with `[DQ]`.

## 3. Contest edit
- `PATCH /contests/{key}` — same body shape as `POST /contests` but all
  fields optional (name, startTime, endTime, format, formatConfig,
  pointsPrecision, timeLimitSeconds, visibility, problems[],
  frozenLastMinutes accepted but must still be 0 — a later task lifts
  that). Creator or admin; 404 otherwise. Refuse changing `format`/`problems`
  once the contest has started (409 `contest_started`). Tag `Contests`.
- Web: `apps/web/src/routes/contest-edit.tsx` at `/contests/$key/edit`,
  prefilled; link from the contest page for allowed actors (the server tells
  the client via a `canEdit: boolean` field on `GET /contests/{key}` — add it).

## 4. Login rate limiting
- Reuse `apps/api/src/common/rate-limiter.ts` (purpose `login`): 10 failed
  attempts per username per 15 min AND 30 per client IP per 15 min → 429
  `login_rate_limited` with `Retry-After`. Only FAILED attempts count; a
  success does not consume. Read `apps/api/src/authn/auth.controller.ts`.
  Get the IP from `X-Forwarded-For` first hop (Caddy sets it) else socket.
  Add D16 to `docs/DECISIONS.md`.
- Contract: add the 429 response to `/auth/login`.

## Done means
Everything above with tests (red→green evidence), full verify ritual green,
committed. Report to `docs/superpowers/briefs/p1a-ops-api-report.md`.
