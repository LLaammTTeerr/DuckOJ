# loop-f26 — comments on problems (thảo luận), D109

## Shipped
Flat discussion (one level of replies) under every problem.
- **Table** `problem_comments` (migration 0039): id, problem_id, author_id,
  parent_id (self-FK, nullable), body, created_at, edited_at, deleted_at;
  CHECK body ≤ 4000; indexes `(problem_id, id)` keyset + `parent_id`.
- **Routes** (tag Problems): `GET /problems/{code}/comments` (@Public,
  problems:read, keyset D58); `POST` (problems:write, rate-limit 10/user/hr →
  429 `comment_rate_limited` + Retry-After); `PATCH .../{id}` (author only,
  sets edited_at); `DELETE .../{id}` (author or admin, soft delete, 204).
- **Service** `apps/api/src/authz/problem.comments.ts` — reuses
  `problem.visibility.ts` predicates; extracted `contestHiddenProblemIds`
  there so D35's mask and D109's are one query (ProblemAccessService delegates
  to it now). Reply notifies the parent author (D14
  `problem_comment_reply`), never on self-reply.
- **Web** "Thảo luận" section on the problem page (composer, reply/edit/delete
  where allowed, load-more, contest note); notification kind rendered; i18n
  vi/en. Bodies go through the same DOMPurify `renderStatement` path.
- Contracts + SDK regenerated (deterministic). D109 added to DECISIONS.md.

## D109 spoiler rule
While the viewer competes in a running contest using the problem
(`contestHiddenProblemIds`), the thread is withheld: read returns an empty
page flagged `hiddenDuringContest: true` (the one deliberate break of D35's
"never signalled" — discloses nothing the viewer doesn't know, UI needs the
note); every write is 403 `comment_hidden_contest`. Organisers/admins
unaffected; after the contest it appears.

## Rulings (no human to consult)
- Writes reuse `problems:write` (no discussion scope; clarifications reuse
  `contests:write` — same precedent).
- Soft delete = author or admin (not curator — moderation is an admin act).
- Tombstone only while a deleted top-level anchors a *visible* reply, else
  omitted; deleted replies always omitted; reply-to-deleted-parent refused.
- Parent validation before the rate limiter (a typo mustn't burn the window).
- Keyset cursor = last row examined, so an omitted tombstone never
  skips/repeats across pages.

## Tests (red→green by mutation)
- API `test/problem-comments.spec.ts` (10, service-level on testDbUrl):
  thread/replies, 404-not-403, one-level, D109 hide + organiser/admin/
  bystander/after-contest, tombstone-vs-omit, rate limit, reply notification
  (both directions), author-only edit / author-or-admin delete, bad cursor.
  Mutation-checked (each red, restored): D109 hide, one-level, self-reply
  skip, tombstone omit.
- Web `test/problems.spec.tsx` +3: thread render, contest note, tombstone.

Verify: repo typecheck/lint (+scripts) green; contracts 39, web 533 (incl.
i18n parity) green; vite build green; regen clean. API suite: see status.
