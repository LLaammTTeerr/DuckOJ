# B1 — bug hunt: auth + accounts (2026-08-29 feature/bug loop)

Read every route in `apps/api/src/authn`, `users`, `admin/admin-users`, plus
`apps/oj` and the web auth screens; probed the live stack with throwaway
`bh1-*` accounts. Eight findings, all fixed, one commit each; D32–D34 used.

## Fixed

1. **A password reset revoked sessions but not access tokens.** Live repro:
   mint `duck_…` from a session → redeem the mailed reset → session 401, token
   still 200 on `/auth/me`. `POST /auth/tokens` is `@SessionOnly()`, i.e.
   reachable with exactly the session an intruder stole, so the rescue was
   walk-around-able. Both now die in the reset's transaction. **D32**,
   `6a8517a` (red: token 200 → green: 401).
2. **`POST /auth/totp/begin` silently un-enrolled a confirmed 2FA.** Live
   repro: begin → `/auth/me` says `totpEnabled:false` → password-only sign-in
   answers 200. One POST proving nothing turned the second factor off; an
   abandoned re-enrol did it by accident. Now `409 totp_already_enabled`,
   re-enrol via `DELETE` first. **D33**, `b1e477a` (contract + regen; red 200 →
   green 409, old secret still valid).
3. **TOTP codes were replayable** — sign in with a code, present it again,
   also 200 (live). RFC 6238 §5.2 forbids it; a code off a shoulder or a
   phishing relay was worth a whole extra sign-in. Spent on first use via a new
   race-free `RateLimiter.consumeOnce` (advisory lock; `allow(…,1,…)` is not
   race-free and says so). **D34**, `9ef25e0` (red: replay 200 → green 401;
   plus a 3-connection concurrency test, mutation-checked by deleting the lock).
4. **m2 — session rows recorded the proxy's address.** `req.ip` with
   `trust proxy` unset is the Caddy container (`10.89.0.7`, seen in live logs),
   identical on every session ever issued. Now `clientIp(req)`. `26bed27`.
5. **m3 — three tables nothing ever deleted from**: `rate_events` (per-key
   cleanup never revisits a sprayed key), `sessions`, `one_time_tokens`
   (expiry filtered, never deleted). New hourly `ExpiredRowsSweeper`, 24 h
   retention so no live window is swept. `685a78f` (two mutation checks).
6. **Profile edit stored junk `timezone`/`locale`** — `PATCH /users/me` with
   `Not/AZone` answered 200 (live); the first `Intl` call on that row is a
   RangeError months later. Now 422, shape only (any IANA zone, any well-formed
   BCP-47 tag), so no ruling about which locales exist. `c4ad0ed`.
7. **m20 — a register retry re-POSTed the registration** and accused the user
   of taking their own username. Now the page remembers what it created; a
   changed username registers again. `f54ecd7` (two web tests, first red).
8. **`oj login` created the credential file world-readable, then chmod'ed.**
   `{ mode: 0o600 }` at creation, `chmod` kept for pre-existing files.
   `7f9a653` (mutation-checked by dropping the chmod).

## Cleared, with evidence

- **XFF forgery / per-IP bypass (m1).** Caddy rewrites `X-Forwarded-For` to its
  own hop — live logs show `10.89.0.7` for requests that sent two entries. No
  bypass; m1's comment and the runbook were already corrected.
- **One-time tokens.** Reset replay → 400 `invalid_token`; cross-purpose
  redemption refused; a verification link cannot set a password.
- **Case folding / whitespace.** Login by username or email in any case works;
  a case-variant username is 409; a taken address in any case gets D26's fake
  201; a leading space is 401 (no silent trim). No enumeration delta beyond
  what D26 already documents.
- **Scope escalation.** An empty-scope token reaches only `/auth/me`
  (`@NoScopeRequired`); `/auth/tokens` and every TOTP route answer 403
  `session_required`. Logout revokes only the presenting session (deliberate).

## Rulings / concerns

- D33 leaves `DELETE /auth/totp` needing no code — step-up re-auth is a bigger
  decision (no password-confirm flow exists yet). Staging the new secret in a
  `pending_secret_enc` column is the better fix, skipped because this brief
  adds no migration (the number is shared with the other agents).
- `POST /auth/totp/confirm` has no attempt limiter (12 wrong codes all 422);
  the caller already holds the session, so not fixed.
- Two flakes on this contended host during the first full run
  (`contest-scoreboard-cache`, D25's 2 s TTL versus a loaded machine; one
  `packages/db` spec). Both pass alone; the final `-r test` was green.
- Live stack: `bh1-*` accounts remain, one with its password reset. Nothing
  stopped, rebuilt, or written outside them.

Ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`,
`-r test` (16 packages), contracts+SDK regen (no diff), web `vite build`.
