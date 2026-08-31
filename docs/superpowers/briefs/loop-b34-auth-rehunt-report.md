# B-34 — auth/session/credentials, re-hunted for the PAIRS

Branch `worktree-agent-a9f9c36a2790f3af7`, nothing pushed. Every finding is a state two shipped features can only reach
together. **Four bugs fixed** (red first, each re-mutated), **five clearances pinned**. Rulings **D140, D141**; **D142
reserved and unspent** (B13's precedent with 0030 — the other two fixes are bug fixes). No migration, no contract change.

## Fixed

**1. `4f81def` — a mailed reset left `must_change_password` set. MEDIUM (D140).** `changePassword` clears the flag;
`resetPassword` set only the hash, so the D61 pupil who forgets the printed password and takes the *other* way in keeps
it forever — wrong in both directions at once. D102 refuses that account every token it will ever hold (`oj login` dead,
remedy already performed); and the flag makes `currentPassword` OPTIONAL on `/auth/password/change`, so the one-shot
bootstrap exemption stayed open for good and whoever next sat at that shared computer could rewrite the password from
the session alone, not knowing it. Red: still `true` after a 200 reset.

**2. `23e114a` — every OTHER reset link outlived the credential change. MEDIUM (D141).** `redeem` marks the one row it
was handed; siblings stayed redeemable for the rest of their hour, and `changePassword` never touched `one_time_tokens`
at all — and two links in flight is routine: a slow first mail, or an intruder asking for one out of a mailbox they can
read. D32's own sentence ("no instant at which the new password is live and an old credential still is") with one table
left out. Both paths now mark every LIVE unused `password_reset` row used in the same transaction; `email_verification`
untouched, pinned by a third test. Red on both: the stale link reset the password, 200.

**3. `ea186b6` — one refused credential check was counted twice. LOW (D47).** `spendPasswordCheck` and `confirmEnrolment`
both `allow` (which marks the refusal) then `retryAfterSeconds` with the default `mark: true` — same purpose, key and
request, so the number D47 gives an operator and D95's monitor an organiser was **double**, for exactly the two meters
guarding a credential. D80 passes `mark: false`; these predate it. Red: 2 rows where 1 belongs, both routes.

**4. `5180196` — signing IN did not drop the previous viewer's cache. LOW-MEDIUM.** `SignOutButton` has removed every
non-`['me']` entry since P5 and says why; `handleLogin` and `/register`'s chained sign-in invalidated `['me']` alone. The
school sequence: a session ends *without* the button (expired, or revoked elsewhere by D32/D141), the shell drops to the
sign-in form with a full cache behind it, the next pupil signs in on that tab. One shared `dropDepartingViewerCache` so
the halves cannot drift again; narrow by construction (in-memory, same document) — hence not MEDIUM.

## Cleared, with evidence (`c9d3cbd` pins the first five)

- **A reset is not a 2FA bypass** and neither spends nor reissues the printout: the code is still demanded afterwards,
  and a pre-reset recovery code still signs in (7 left). **An admin TOTP reset (M9) takes the recovery codes with it** —
  cleared inside `disable`'s transaction, table empty; mutation: drop `recovery.clear` → 8 survive. Unpinned until now.
- **A recovery-code sign-in leaves `must_change_password` standing** (it proves the second factor, not the password).
  **Login's 429 leaks no existence**: byte-identical status/code/detail, known vs unknown. **D73's budget is not D16's**:
  eleven wrong `/auth/password/change` guesses still leave a 200 sign-in. Already pinned elsewhere: a live session/token
  re-reads `globalRole`/`status` per request (`admin-users.spec.ts`), so demotion and deactivation land mid-flight, and
  `list`/`revoke` are `userId`-scoped under class-level `@SessionOnly`.
- **Session expiry has no D-number**: `SESSION_TTL_HOURS` (default **720**), absolute only — no idle timeout, no sliding
  renewal; revoked on logout, change, reset. A gap needing schema work, not a bug. **D26's 5-vs-30 is not drift.**

## Concerns

- **No `Cache-Control: no-store` on API responses**, recorded not fixed: a blanket header is a product ruling,
  `GET /packages/{hash}` is a legitimate long-cache candidate, and Express' default ETag forces a revalidation that 401s
  once signed out. Worth D142's own brief.
- D141 makes `changePassword` write a third table inside its transaction (bounded by that user's live links). **The live
  stack was never touched** — every finding was test-reachable, so no `bh34-*` account was registered, no token minted.

## Verify

`-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts` green; contracts + SDK regen **no diff**; `vite build`
green. Tests per package, sequential (B13/B19 precedent: `-r test` flakes under contention here), api in its own
`--no-file-parallelism` pass: **api VERIFY_API**, web 621, judged 130, contest-formats 120, mcp 90, prepare 62, db 62,
package-format 54, similarity 43, glicko2 41, contracts 39, oj 35, every remaining package green. `graphify update .` run.
