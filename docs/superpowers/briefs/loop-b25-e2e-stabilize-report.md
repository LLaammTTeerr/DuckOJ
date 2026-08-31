# Loop B-25 — e2e stabilization report

Playwright e2e suite was RED (8 failed / 9 did-not-run / 24 passed) against
the live stack (http://localhost:8080, current main). Every failure was TEST
staleness from features that shipped correctly. No product code changed; no
real product bug found.

## Final counts

- **e2e: 41 passed, 0 failed, 0 skipped** (`pnpm --filter @duckoj/web exec playwright test`)
- web typecheck: green (after `pnpm -r typecheck` built the workspace `dist/`)
- web lint: green
- web vitest `--no-file-parallelism`: 570 passed (56 files)
- web build (`vite build`): green

## Fixes (all in `apps/web/e2e/`, test-only)

1. **a11y-axe.spec.ts — axe injection vs CSP (D120).** `page.addScriptTag`
   injects an inline `<script>` the live `script-src 'self' 'sha256-…'` CSP
   refuses. Replaced with reading `axe.min.js` from disk and running it via
   `page.evaluate(AXE_SOURCE)` — CDP Runtime.evaluate runs in an isolated
   world the page CSP does not police (the shape `@axe-core/playwright` uses;
   that package is not in the lockfile, so hand-rolled). Guarded on
   `'axe' in window` so a re-navigation re-installs it. App CSP untouched.
2. **journey.spec.ts — mismatch text matches 2 elements.** D110 now renders
   "Hai mật khẩu không khớp nhau." in BOTH the `role="alert"` error summary
   and the field error. Scoped the assertion to
   `getByRole('alert').getByText(...)` so it names one element.
3. **authoring.spec.ts — file-input label collision.** B-20's file inputs
   carry aria-labels ("Tải tệp đầu vào cho test N") that substring-match
   `getByLabel('Đầu vào')`, so `.nth(1)` landed on a file input and `.fill()`
   failed. Added `{ exact: true }` to `getByLabel('Đầu vào'|'Đáp án')` (6
   sites) so only the textareas match; the file inputs are not targeted.

## Notes / concerns

- Workspace `dist/` was unbuilt in a fresh worktree; `@duckoj/contracts` /
  `@duckoj/glicko2` have no `build` script (built via `tsc -b` in each
  package's `typecheck`). Running `pnpm -r typecheck` before `vite build` is
  required — bare `pnpm -r build` skips them and the web build fails to
  resolve `@duckoj/contracts`. Not a code change; a build-order note.
- Registration meter (30/IP/hour, D26) not hit; suite reuses accounts.
