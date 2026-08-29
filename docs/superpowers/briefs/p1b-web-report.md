# P1-B report — TOTP enrolment UI, float-precision display (web only)

Status: DONE_WITH_CONCERNS. Branch `worktree-agent-a35dec3c52fa8290b`.
Web-only: `corepack pnpm --filter @duckoj/web` typecheck + lint + test + `vite build` all green
(20 files, 135 tests). Nothing outside `apps/web/**` is modified — no lockfile, no API, no contracts.

## Shipped

**1. TOTP enrolment UI.** New `src/routes/security.tsx` at `/account/security`, linked from the nav
beside Tokens (both `/account/*`, both session-only). Status read from `GET /auth/me`'s
`totpEnabled` via the shared `['me']` entry — the page keeps no second copy, so confirm/disable
invalidate `['me']` and the refetch is what flips the status. Enable → `POST /auth/totp/begin` →
secret in a `<code>` block *and* a client-side SVG QR → six-digit input → `POST /auth/totp/confirm`.
Disable behind `window.confirm()` → `DELETE /auth/totp`. All three handlers use the
try/catch/finally busy-flag shape from `tokens.tsx`; the busy flag is shared because `begin` is
destructive on repeat (it upserts a *fresh* secret and clears `confirmedAt`).

**2. QR encoder.** `src/vendor/qrcodegen.ts` — Project Nayuki's MIT TypeScript encoder, verbatim
plus a header and an `export` line; `src/qr.tsx` is the typed wrapper (`qrModules`, `<QrCode>`) and
the only importer.

**3. `src/format.ts` `formatPoints(value, precision = 2)`** — `toFixed` then `Number(...)` to drop
trailing zeros. Applied at every points/score render: `submissions.tsx` (points/maxPoints),
`submit.tsx` `VerdictPanel` (which is what `submission.tsx` renders), `contests.tsx` (problems
table, scoreboard `cell()`, scoreboard `score`), `user.tsx` (`stats.points`).

## Tests (red → green evidence)

- `test/format.spec.ts` (6): red as unresolvable import, then green. Mutation: swap the body for
  `String(value)` → **3 red**, restored → green.
- `test/qr.spec.tsx` (5): red as unresolvable import, then green. Asserts a legal side length
  (17+4N), the three finder patterns at corner/inset/core, determinism, the one-`<path>` SVG, and
  that an unencodable payload renders nothing rather than throwing.
- **Independent cross-check of the vendored encoder** (scratchpad, not committed): matrices for four
  payloads — including a real `otpauth://` URL — rendered to pixels and decoded with `jsqr`; **4/4
  decoded back to the exact input**. A module-for-module diff against npm `qrcode@1.5.4` differs
  (equally valid mask choice), which is why the round-trip decode is the check that was used.
- `test/security.spec.tsx` (11). Mutation: remove the `window.confirm` gate *and* the six-digit
  guard → **2 red**, restored → green.
- `test/contests.spec.tsx` +2 precision regressions. Mutation: revert all three `contests.tsx`
  call sites to raw values → **2 red**, restored → green.

## Rulings (no human available)

1. **QR vendored, not `pnpm add qrcode`.** The brief allowed either; the parent's `apps/web/**`
   constraint decides it, since a dependency rewrites the root `pnpm-lock.yaml`. Hand-rolling
   Reed–Solomon was rejected as the higher-risk option — a subtly wrong encoder yields a code that
   scans into the *wrong secret* rather than one that visibly fails.
2. **`@ts-nocheck` + `eslint-disable` on the vendored file only.** This repo sets
   `noUncheckedIndexedAccess`, under which upstream's dense array indexing raises ~30
   `possibly undefined` errors. Suppressing file-wide keeps the copy byte-identical to upstream and
   therefore re-syncable; `qr.tsx` re-establishes a fully typed surface for the rest of the app.
3. **Login TOTP: no-op.** `login.tsx` already has the `needsTotp` second-step input and
   `router.tsx`'s `useAuthGate` already maps `totp_required` / `invalid_totp_code` onto it, with
   coverage in `login.spec.tsx`. Nothing to add.
4. **`problem.tsx`: no-op.** The brief lists it as a points display; it renders no points at all.
5. **Scoreboard precision defaults to 2.** `GET /contests/{key}` carries `pointsPrecision` and
   `ContestPage` uses it. The scoreboard payload does *not*, and fetching contest detail purely for
   a display nicety would add a request and churn test mocks — so "the contest's `pointsPrecision`
   when known" is read as *known in the payload at hand*.
6. **Verification scope.** The brief's web-only gate replaces conventions.md's full-repo block; no
   `-r test`, no contracts/SDK regen (no contract changed).
7. **`graphify update .` skipped** — it writes `graphify-out/`, outside the allowed paths.
8. **Staged by path, not `git add -A`** (conventions.md), so the narrower parent constraint holds.
9. **"Use it everywhere" verified by sweeping all of `apps/web/src`, not just the five named
   files.** No further display sites exist: the remaining `points` hits are `<th>` labels, comments,
   and `contest-new.tsx`'s authoring *input* — a controlled text field whose string state is parsed
   with `Number()` on submit, where formatting would corrupt what the author is typing.

## Concerns / left out

- The vendored encoder is ~1000 lines of third-party code carrying a blanket `@ts-nocheck`. If a
  lockfile change is ever acceptable, `pnpm add qrcode` in `apps/web` is the smaller footprint.
- `vite build` still warns that the main chunk exceeds 500 kB. Pre-existing (KaTeX dominates); the
  encoder adds roughly 30 kB before gzip.
- `formatPoints` is display-only. No sort, total or comparison reads its output — worth preserving.
- No e2e coverage for `/account/security`: `e2e/` needs a live stack, which is out of scope here.
