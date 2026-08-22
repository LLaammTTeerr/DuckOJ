# Phase 6a — in-app notifications (D14): ledger

## What shipped

- `notifications` table (migration 0015): per-user rows, `kind` text +
  `payload` jsonb snapshot — a new kind is a producer and a renderer,
  never a migration.
- `NotificationsService` (`notify` takes the caller's tx; `listFor` /
  `markAllRead` are always `user_id = actor`), session-only controller
  at `GET /notifications` + `POST /notifications/read`.
- Three producers: org join requested (to owners/admins, only when the
  request row was actually created), join decided (to the requester,
  inside the deciding transaction), role granted (to the target, never
  on self-regrant).
- Web: `/notifications` feed page; nav bell `[n]` polling once a
  minute while signed in. Unread rows are strong-weight — weight, not
  colour.

## Rulings

- **R1 — session-only, no new scopes.** D14 says in-app; a token has no
  business here, and the scope vocabulary stays untouched.
- **R2 — the decide-notification shares the decision's transaction**;
  the request-side one does not (it fans out after a plain insert). A
  lost "someone asked" is a nuisance; a decided request with no record
  of telling the requester would be a divergence.
- **R3 — payloads are snapshots** (username, slug as they were), not
  foreign keys: a notification about a since-renamed org should read as
  it did when it happened.

## Findings

- **A surviving mutant, run to ground:** hard-coding "approved" in the
  web renderer passed every test — no fixture was a declined request.
  The recurring lesson (three phases now): a surviving mutant is a
  state no fixture reached. Added the declined item; the mutant dies.

## Mutation evidence (isolated, restored green after each)

API: plain members notified (1 fail) · re-ask re-notifies (1 fail) ·
markAllRead ignores the actor (1 fail) · self-regrant notifies (1
fail) · `approved` flipped in payload (1 fail).
Web: unknown kind renders blank (1 fail) · every row strong (1 fail) ·
renderer hard-codes "approved" (survived → fixture added → 2 fail).
