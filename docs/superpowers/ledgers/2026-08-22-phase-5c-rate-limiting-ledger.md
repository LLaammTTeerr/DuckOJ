# Phase 5c — rate limiting on account recovery (D13): ledger

## What shipped

- `rate_events` table (migration 0014, drizzle-kit generated) with the
  `(purpose, key, created_at)` index the count query walks.
- `RateLimiter.allow(purpose, key, limit, windowMs)` in `common/` —
  fixed window, count-then-insert, opportunistic per-key cleanup.
- Both mail-sending sites limited to **5/hour**: password reset keyed by
  the asked-for lowercased email (before the user lookup, so probes of
  nonexistent addresses burn a window), verification resend keyed by
  the authenticated user id.

## Rulings

- **R1 — refusal is silent.** The endpoint's contract is "always 202";
  a 429 would make the limiter itself the membership oracle. The sixth
  response is asserted byte-identical to the first.
- **R2 — count-then-insert without a lock.** Two concurrent requests at
  the boundary can both pass. Accepted: the limit guards outbound-mail
  nuisance volume, not an exact security invariant.
- **R3 — refused attempts are recorded.** A refused caller keeps
  burning their window rather than probing its edge for free.

## Findings

- **The HTTP suites cannot see the purpose filter.** Their keys (an
  email vs. a user id) never collide across purposes, so a limiter that
  ignored `purpose` passes all of them — same key, different purpose is
  a state no endpoint fixture reaches. Pinned with a direct
  `RateLimiter` test on a shared key.
- First test run failed on fixture drift: `registerAndLogin` registers
  `@example.com`, the test asked about `@example.test` — the failure
  was the test's, not the limiter's.

## Mutation evidence (isolated, cp-backup, restored green after each)

| Mutation | Result |
| --- | --- |
| reset-side check removed | 3 fail |
| `<` → `<=` boundary | 4 fail |
| cleanup delete removed | 1 fail (row-count pin) |
| purpose dropped from count | 1 fail (shared-key pin) |
| verification-side check removed | 1 fail |

Also removed the other stale eslint-disable (`apps/judged`), twin of the
one 5b removed.
