# F3 — TOTP recovery codes (2026-08-29 feature/bug loop)

Closes "TOTP is a one-way door": a lost phone no longer costs an administrator.
Migration 0019, D39. Nothing on the live stack was stopped or rebuilt.

## Part A — the demo set is classified live
`content/README.md` step 6 applied as `duckadmin`: five PATCHes from
`content/tags.json`, all 200. `GET /api/v1/problems?tag=do-thi` returns both graph
problems, difficulty 6, tags exactly as `tags.json` lists them. Nothing to commit.
**The README's URL does not work as written from here.** `https://localhost:8443`
resets the connection (curl 35); `http://localhost:8080` through the same Caddy
answers 200, with the `Secure` flag cleared in the cookie jar. Worth a runbook line.

## Part B — what shipped
- `b82682e` **db** — `totp_recovery_codes` (user_id, code_hash, used_at,
  created_at; unique on (user_id, code_hash)), migration 0019, drizzle-generated.
- `b985821` **contracts** — confirm 204→200 with `{recoveryCodes}`; `POST
  /auth/totp/recovery/regenerate`; `LoginRequest.recoveryCode`;
  `MeResponse.recoveryCodesRemaining`; openapi + SDK regenerated.
- `3c4ee08` **api** — `TotpRecoveryService`: eight 50-bit codes over a Crockford
  alphabet, sha256 of the canonical form, `UPDATE … WHERE used_at IS NULL
  RETURNING` to spend. Login takes `recoveryCode`; `disable` (so also the admin
  reset) clears the set; regenerate gated on `isEnabled`.
- `80eb645` **web** — codes panel (print `<pre>`, copy, "I saved them"), remaining
  count, regenerate flow, login toggle, vi/en, notification line.

## Tests — 10 new API specs, 7 new web specs, each shown red first

`apps/api/test/totp-recovery.spec.ts` (real Postgres, real module graph) plus
additions to `apps/web/test/{security,login}.spec.tsx`. Mutations, each restored
after: `isNull(usedAt)` dropped from the consume → replay + race red; `issue()`
not deleting the old set → regenerate red; the exhaustion `notify` removed →
notification red; regenerate's `isEnabled` gate removed → 409 red; `disable` not
clearing codes → re-enrolment red; login's `else if (body.recoveryCode)` → `false`
→ sign-in red; three web mutations (panel gate, enrol warning, `totpCode`
suppression under the toggle) → red.

## Rulings (all in D39; nobody to ask)
sha256 not argon2 (server-generated entropy, no dictionary; argon2 × 8 rows on an
anonymous route is a DoS surface; `one_time_tokens` is the precedent). Unknown /
malformed / already-spent all answer `401 invalid_totp_code` and count toward D16;
`recoveryCode` is validated loosely so a typo stays inside that window. `totpCode`
wins when both arrive. Regenerate demands a live code and spends it (D34), and
checks `isEnabled` first because `verify` fails open. Confirm replaces the set,
since it proves what a regenerate proves; `invalid_totp_enrolment_code` covers both
management routes.

## Concerns
- The race spec (`Promise.all` on one code) passes, but `withTestDb` runs on one
  connection — evidence the second attempt is refused, not a concurrency proof;
  the claim rests on the `WHERE used_at IS NULL` re-check.
- `AuthnModule` ↔ `NotificationsModule` is now a `forwardRef` cycle (the notice
  writes inside the spend's transaction); one shared instance, the alternative
  being a second copy provided in `AuthnModule`.
- Codes are shown to a bare *session*, so a stolen one sees them at enrolment;
  closing that needs the step-up re-auth D33 already names as missing.
- Ritual green, after the 9deec85 merge landed: `-r typecheck`,
  `typecheck:scripts`, `-r lint`, `lint:scripts`, `-r test` (no flakes),
  contracts + SDK regen with no diff, web `vite build`.
