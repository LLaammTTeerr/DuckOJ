# Task P1-B — web-only: TOTP enrollment UI, float-precision display

Read `docs/superpowers/briefs/conventions.md` first. You are in an isolated
git worktree; touch ONLY `apps/web/**` (plus this report). No API changes.
Do not run `pnpm -r test` — run `corepack pnpm --filter @duckoj/web test`,
typecheck, lint and `vite build` for the web package only.

## 1. TOTP enrollment UI
- Routes already exist in the SDK: `POST /auth/totp/begin` →
  `{ secret, otpauthUrl }`, `POST /auth/totp/confirm` `{ code }`,
  `DELETE /auth/totp`. `GET /auth/me` exposes whether 2FA is enabled — check
  the SDK types (`packages/sdk/src/generated.ts`) for the exact field.
- New screen `apps/web/src/routes/security.tsx` at `/account/security`,
  linked from the nav next to "Tokens": shows status; "Enable" → begin →
  shows the secret in a `<code>` block AND a QR code (render the otpauth URL
  as an SVG QR client-side — add a tiny dependency `qrcode` or inline a
  minimal encoder; `qrcode` npm package is acceptable) → 6-digit input →
  confirm → success; "Disable" with confirm().
- Login already handles the TOTP challenge? Check `login.tsx`; if the login
  contract has a `totpCode` field and the UI lacks it, add the second-step
  input.
- Tests: Testing Library, mocking the SDK client as existing tests do.

## 2. Float-precision display
- Points/score displays across `problem.tsx`, `submissions.tsx`,
  `submission.tsx`, `contests.tsx` (scoreboard), `user.tsx` currently print
  raw floats (e.g. `33.333333333`). Add one formatter
  `apps/web/src/format.ts` `formatPoints(value, precision?)` that trims to
  at most `precision` decimals (default 2; the contest's `pointsPrecision`
  when known) and drops trailing zeros (`100`, `33.33`, `0.5`). Use it
  everywhere; unit-test it.

## Done means
Web typecheck/lint/test/build green, committed on your worktree branch.
Report to `docs/superpowers/briefs/p1b-web-report.md`.
