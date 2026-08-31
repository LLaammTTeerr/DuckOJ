# B-34 — auth/session/credentials, re-hunted for the PAIRS

Branch `worktree-agent-a9f9c36a2790f3af7`, nothing pushed; every finding is a state two shipped features can only reach
together. **Five bugs fixed** (red first, each re-mutated), **five clearances pinned**. Rulings **D140, D141**; **D142
reserved and unspent** (B13's precedent with 0030). No migration, no contract change.

## Fixed

**1. `4f81def` — a mailed reset left `must_change_password` set. MEDIUM (D140).** `changePassword` clears the flag;
`resetPassword` set only the hash, so the D61 pupil who forgets the printed password and takes the *other* way in keeps
it forever — wrong in both directions at once. D102 refuses that account every token it will ever hold (`oj login` dead,
remedy already performed); and the flag makes `currentPassword` OPTIONAL on `/auth/password/change`, so the one-shot
bootstrap exemption stayed open for good: the next person at that shared computer can rewrite the password unaided.

**2. `23e114a` — every OTHER reset link outlived the credential change. MEDIUM (D141).** `redeem` marks the one row it
was handed; siblings stayed redeemable for the rest of their hour, and `changePassword` never touched `one_time_tokens`
at all — and two links in flight is routine: a slow first mail, or an intruder asking for one out of a mailbox they can
read. D32's sentence ("no instant at which the new password is live and an old credential still is") with one table left
out. Both now mark every LIVE unused `password_reset` row used in that transaction; `email_verification` stays live.

**3. `ea186b6` — one refused credential check was counted twice. LOW (D47).** `spendPasswordCheck` and `confirmEnrolment`
both `allow` (which marks the refusal) then `retryAfterSeconds` with the default `mark: true` — same purpose, key and
request — so the number D47 gives an operator and D95's monitor an organiser was **double**, for exactly the two meters
guarding a credential. D80 passes `mark: false`; these predate it. Red: 2 rows where 1 belongs.

**4. `5180196` — signing IN did not drop the previous viewer's cache. LOW-MEDIUM.** `SignOutButton` has removed every
non-`['me']` entry since P5 and says why; `handleLogin` and `/register`'s chained sign-in invalidated `['me']` alone. The
school sequence: a session ends *without* the button (expired, or revoked elsewhere by D32/D141), the shell drops to the
sign-in form with a full cache behind it, the next pupil signs in on that tab. One shared helper now; narrow by
construction (in-memory, one document lifetime) — hence not MEDIUM. Red on both call sites.

**5. `f63271d` — `problem-comments.spec.ts` ran on vitest's 5 s default. LOW, and not mine.** The one red in an otherwise
green api pass ("Test timed out in 5000ms"); passes alone, branch touches nothing in it. Thirteen cases start a Postgres
container and run `runMigrations` on **no** budget while every sibling passes `120_000` — the flake family B10/B13/B19
reported rather than fixed. Now `120_000` throughout.

## Cleared, with evidence (`c9d3cbd` pins the first five)

- **A reset is not a 2FA bypass** and neither spends nor reissues the printout: the code is still demanded, and a
  pre-reset recovery code still signs in (7 left). **An admin TOTP reset (M9) takes the recovery codes with it** —
  cleared in `disable`'s transaction; mutation: drop `recovery.clear` → 8 survive. Unpinned until now.
- **A recovery-code sign-in leaves `must_change_password` standing** (it proves the second factor, not the password).
  **Login's 429 leaks no existence**: byte-identical status/code/detail, known vs unknown. **D73's budget is not D16's**:
  eleven wrong `/auth/password/change` guesses still leave a 200 sign-in. Pinned elsewhere: a session/token re-reads
  `globalRole`/`status` per request (`admin-users.spec.ts`); `list`/`revoke` are `userId`-scoped under `@SessionOnly`.
- **Session expiry has no D-number**: `SESSION_TTL_HOURS` (720), absolute only, no idle timeout; revoked on logout,
  change, reset. A gap needing schema work, not a bug. **D26's 5-vs-30 is not drift** — D26 carries the amendment.

## Concerns

- **No `Cache-Control: no-store` on API responses**, recorded not fixed: a blanket header is a product ruling,
  `GET /packages/{hash}` is a long-cache candidate, and Express' default ETag forces a revalidation that 401s once signed
  out. Worth D142's own brief. Other specs may share finding 5's defect; only the file that went red was audited.
- D141 adds a third table to `changePassword`'s transaction. **Live stack untouched** — no `bh34-*` account, no token.

## Verify

`-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts` green; contracts + SDK regen **no diff**; `vite build`
green; `graphify update .` run. Tests per package, sequential (B13/B19 precedent), api in its own `--no-file-parallelism`
pass: **api 133 files / 1167**, web 621, judged 130, contest-formats 120, mcp 90, db 62, every other package green.
