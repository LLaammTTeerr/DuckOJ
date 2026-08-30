# F3 — TOTP recovery codes (2026-08-29 feature/bug loop)

Closes "TOTP is a one-way door": a lost phone no longer costs an administrator.
Migration 0019, D39. Nothing on the live stack was stopped or rebuilt.

## Part A — the demo set is classified live

`content/README.md` step 6 applied as `duckadmin`: five PATCHes from
`content/tags.json`, all 200. `GET /api/v1/problems?tag=do-thi` returns
`duong-di-ngan-nhat` (6; `cau-truc-du-lieu`, `do-thi`, `duong-di-ngan-nhat`) and
`cay-khung-nho-nhat` (6; `cay-khung`, `do-thi`, `dsu`, `sap-xep`). Nothing to
commit. **The README's URL does not work as written from here.** `https://localhost:8443`
resets the connection (curl 35); `http://localhost:8080` through the same Caddy
answers 200, and the `Secure` session cookie had to have that flag cleared in the
jar for curl to send it back over http. Not chased further — worth a runbook line.

## Part B — what shipped

- `b82682e` **db** — `totp_recovery_codes` (user_id, code_hash, used_at,
  created_at; unique on (user_id, code_hash)), migration 0019, drizzle-generated.
- `b985821` **contracts** — confirm 204→200 with `{recoveryCodes}`;
  `POST /auth/totp/recovery/regenerate`; `LoginRequest.recoveryCode`;
  `MeResponse.recoveryCodesRemaining`. openapi + SDK regenerated.
- `3c4ee08` **api** — `TotpRecoveryService`: eight 50-bit codes over a Crockford
  alphabet, sha256 of the canonical form, `UPDATE … WHERE used_at IS NULL
  RETURNING` to spend. Login takes `recoveryCode`; `disable` (so also the admin
  reset) clears the set; regenerate gated on `isEnabled`.
- `80eb645` **web** — codes panel (print `<pre>`, copy, "I saved them"),
  remaining count, regenerate flow, login toggle, vi/en, notification line.

## Tests — 10 new API specs, 7 new web specs, every one shown red first

`apps/api/test/totp-recovery.spec.ts` (real Postgres, real module graph) plus
additions to `apps/web/test/{security,login}.spec.tsx`. Mutations, each restored
after: dropping `isNull(usedAt)` from the consume → replay + race red; `issue()`
not deleting the old set → regenerate red; removing the exhaustion `notify` →
notification red; removing regenerate's `isEnabled` gate → 409 red; `disable` not
clearing codes → re-enrolment red; login's `else if (body.recoveryCode)` →
`false` → sign-in red; hiding the codes panel → four security specs red; dropping
the enrol warning, and un-suppressing `totpCode` under the toggle → red.

## Rulings (all recorded in D39; nobody to ask)

sha256 not argon2 (server-generated entropy, no dictionary; argon2 × 8 rows on an
anonymous route is a DoS surface; `one_time_tokens` is the precedent). Unknown /
malformed / already-spent all answer `401 invalid_totp_code` and count toward D16;
`recoveryCode` is validated loosely so a typo stays inside that window. `totpCode`
wins when both arrive. Regenerate demands a live code and spends it (D34), and
checks `isEnabled` first because `verify` fails open. Confirm replaces the set,
since it proves what a regenerate proves. `invalid_totp_enrolment_code` reused for
both management routes.

## Concerns

- The race spec (`Promise.all` on one code) passes, but `withTestDb` runs on one
  connection — evidence the second attempt is refused, not proof of concurrency;
  the claim rests on the `WHERE used_at IS NULL` re-check.
- `AuthnModule` ↔ `NotificationsModule` is now a `forwardRef` cycle (the notice
  writes inside the spend's transaction). One shared instance; the alternative
  was a second copy provided in `AuthnModule`.
- Codes are shown to a *session*, so a stolen session sees them at enrolment.
  Closing that needs the step-up re-auth D33 already names as missing.
- Ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`,
  `-r test` (16 packages, 1281 tests, no flakes), contracts + SDK regen with no
  diff, web `vite build`.
