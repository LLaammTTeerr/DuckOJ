# Loop B-26 — whole-diff review IV + systemic integrity (`4bac5f4..HEAD`)

**Status: DONE.** Branch `worktree-agent-a875fb0fd34aecee8`, nothing pushed.
Commits: `2d16afa` (CSP built-artefact drift guard), `df1002f` (D119/D120
ledger backfill). No product-code change — the diff is correct; findings are
cleared-with-evidence plus two infra/docs fixes.

## Blockers — none.

## Fixed
1. **[Major] CSP drift guard was blind to the SERVED artefact (`2d16afa`).**
   D120's `security-headers.spec.ts` hashes the SOURCE `apps/web/index.html`,
   but Caddy serves the BUILT `dist/index.html`. A Vite transform of the inline
   theme script (HTML minify, an esbuild default, a Vite bump) moves the served
   hash while the source test stays green → the CSP silently blocks the script
   on every page (the exact D120 class). A unit test can't catch it — CI and
   `verify` build AFTER tests. New `scripts/verify-csp-hash.ts` runs after the
   build, hashes EVERY inline `<script>` in `dist/index.html` (the D120 regex
   took only the first) and asserts each is in the Caddyfile `script-src`, no
   `'unsafe-inline'`. Wired into `verify` + a CI step after Build. Green now;
   red on a minified inline script (Vite-bump sim), a corrupt hash, a missing dist.
2. **[Minor] D119/D120 cited by commits, absent from DECISIONS.md (`df1002f`).**
   Conventions require a D-entry per ruling; `8cc07fb`/`dd82d89` had none.
   Backfilled under their cited numbers. D121 was pre-allocated in the B-24
   dispatch note's "D119–D121" range but no commit cites it — never a ruling.

## Cleared with evidence
- **Fresh-clone integrity (item 1) — GREEN.** `git archive HEAD` → fresh tree.
  Offline install FAILS on this host (`ERR_PNPM_NO_OFFLINE_TARBALL` on
  drizzle-orm — a local store gap, not a repo defect); online
  `--frozen-lockfile` green. Then `pnpm -r typecheck`, `vite build`, and the
  **api image build via podman** (`apps/api/Dockerfile`, incl. typst stage) all
  exit 0. **F-21 trap closed:** root script is `prepare:problem`, not the
  `prepare` lifecycle name. **B-25 trap:** `-r typecheck` builds contracts/
  glicko2 `dist/` before `vite build` resolves them — confirmed on the clean tree.
- **CSP hash match (item 2).** Caddyfile hash ==
  `sha256(source index.html inline script)` == `sha256(dist/index.html inline
  script)` — all three byte-identical; Vite does not currently minify it.
- **D117 teammate submission visibility.** SQL sound: freeze escape is
  `(actingParticipationWhere) IS NOT TRUE` (NULL-safe vs a stranger's team_id-
  NULL individual row); all three callers pass `db, actor` (`user.access:152`,
  `submission.access:395/650`); team join is LEFT so `teamName` is null-safe;
  `username`/`teamName` populated on list+detail; contract `username` non-null,
  `teamName` nullable — both catalogues.
- **D119 clarification fix.** `teammatesInThisContest` uncorrelated, scoped to
  this contest, empty for individual rounds; no cross-contest/rival leak.
- **i18n parity.** `i18n.spec.tsx` asserts both-direction key equality + NFC; 4
  new keys (`submittedBy`, `teamLabel`, `startsIn`, `endsIn`) present en+vi.
- **D118 countdown.** Leaf, `setInterval` cleared on unmount, `role="timer"`
  (not aria-live), locale-neutral `HH:MM:SS`.
- **534aaf5 picker.** Composite `orgSlug/slug` option value disambiguates same-
  slug teams; server still gets bare `teamSlug` (B-23 tiebreak, accepted bound).
- **Migrations:** none in range (`git diff --stat` empty) — no schema drift.
- **Secrets:** `scripts/rehearsal.ts` reads `E2E_SECRETS_FILE`, prints only
  response bodies on failure (never the request password); no leak.

## Concerns
- `test:ci` nests bare `pnpm` (not on PATH here); ran green via a corepack shim
  (c1 concern #2 recurs — CI has pnpm via action-setup, unaffected). Offline
  fresh install needs drizzle-orm seeded in the local store; online path fine.
