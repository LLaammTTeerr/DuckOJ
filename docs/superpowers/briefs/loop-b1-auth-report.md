# B1 — bug hunt: auth + accounts (2026-08-29 feature/bug loop)

Read every route in `apps/api/src/authn`, `users`, `admin/admin-users`, plus `apps/oj`
and the web auth screens; probed the live stack with throwaway `bh1-*` accounts. Eight
findings, all fixed, one commit each; D32–D34 used. Every fix was shown red first.

## Fixed (live repro → fix)

1. **`6a8517a` D32 — a password reset revoked sessions but not access tokens.** Mint a
   `duck_…` from a session, redeem the mailed reset: session 401, token still 200.
   `POST /auth/tokens` is `@SessionOnly()`, i.e. reachable with exactly the session an
   intruder stole, so the rescue was walk-around-able. Both die in the reset's
   transaction now.
2. **`b1e477a` D33 — `POST /auth/totp/begin` silently un-enrolled a confirmed 2FA.**
   begin → `/auth/me` says `totpEnabled:false` → password-only sign-in 200. One POST
   proving nothing turned the second factor off, and an abandoned re-enrol did it by
   accident. Now `409 totp_already_enabled` (contract + regen); re-enrol by disabling.
3. **`9ef25e0` D34 — TOTP codes were replayable**: the same code twice, both 200; RFC
   6238 §5.2 forbids it. Spent on first use through a new race-free
   `RateLimiter.consumeOnce` (advisory lock — `allow(…,1,…)` is not race-free and says
   so), whose concurrency test is mutation-checked by deleting the lock.
4. **`26bed27` m2 — session rows recorded the proxy's address.** `req.ip` with `trust
   proxy` unset is the Caddy container (`10.89.0.7` in the live logs), the same string
   on every session ever issued. Now `clientIp(req)`.
5. **`685a78f` m3 — three tables nothing ever deleted from**: `rate_events` (its
   per-key cleanup never revisits a sprayed key), `sessions`, `one_time_tokens`. New
   hourly `ExpiredRowsSweeper`, 24 h retention so no live window is swept.
6. **`c4ad0ed` — profile edit stored junk `timezone`/`locale`**: `PATCH /users/me
   {timezone:'Not/AZone'}` answered 200, and the first `Intl` call on that row is a
   RangeError months later. Now 422, shape only (any IANA zone, any well-formed BCP-47
   tag), so nothing here rules on which locales exist.
7. **`f54ecd7` m20 — a register retry re-POSTed the registration** and accused the user
   of taking their own username. The page remembers what it created; a changed username
   registers again.
8. **`7f9a653` — `oj login` created the credential file world-readable, then chmod'ed.**
   `{ mode: 0o600 }` at creation; the `chmod` stays, for files that already exist.

## Cleared, with evidence

- **XFF forgery / per-IP bypass (m1):** Caddy rewrites `X-Forwarded-For` to its own hop
  — the live logs show `10.89.0.7` for requests that sent two entries.
- **One-time tokens:** a reset replay is 400; cross-purpose redemption is refused.
- **Case folding / whitespace:** login by username or email in any case works, a
  case-variant username is 409, a taken address in any case gets D26's fake 201, a
  leading space is 401. No enumeration delta beyond the one D26 documents.
- **Scope escalation:** an empty-scope token reaches only `/auth/me`; `/auth/tokens` and
  every TOTP route answer 403. Logout revokes only the presenting session (deliberate).

## Rulings / concerns

- D33 leaves `DELETE /auth/totp` needing no code; step-up re-auth needs a
  password-confirm flow that does not exist anywhere yet. Staging the new secret in a
  `pending_secret_enc` column is the better fix, skipped for want of a migration number
  (shared state with the other agents tonight).
- `POST /auth/totp/confirm` has no attempt limiter — twelve wrong codes all answer 422.
  The caller already holds the session, so this was left alone.
- Two flakes in the first full run on this contended host (`contest-scoreboard-cache`,
  D25's 2 s TTL against a loaded machine, and one `packages/db` spec); both pass alone
  and the final `-r test` was green end to end.
- Live stack: the `bh1-*` accounts remain, one with its password reset. Nothing was
  stopped or rebuilt.
- Ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`,
  `-r test` (16 packages), contracts + SDK regen (no diff), web `vite build`.
