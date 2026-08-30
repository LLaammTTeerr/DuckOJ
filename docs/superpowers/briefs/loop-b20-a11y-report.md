# Loop b20 — accessibility + i18n

**Status:** DONE. Branch `worktree-agent-a93d9f4793acb9a35` (not pushed).
Web typecheck / lint / test (537) / `vite build` all green; axe e2e sweep
clean against a preview of this branch.

Each fix: test shown failing first → fix → one commit (the register focus
move was additionally revert-checked).

## Fixes shipped (7)

1. `3f6dcd1` — **[serious, WCAG 4.1.2]** Authoring test-data tab's per-case
   Input/Answer file inputs had no accessible name (the row `<label for>`
   points at the textarea). Added `aria-label` + 2 i18n keys.
2. `73a41bd` — **[serious, WCAG 4.1.3]** Submit VerdictPanel's async state and
   verdict sat in plain `<p>`s — a screen reader was never told the outcome.
   Wrapped both in one `role="status"`; the case grid stays outside it.
3. `6b732a3` — **[serious, WCAG 3.3.1]** Register form announced nothing and
   moved focus nowhere on a failed submit. Added a Focusable Error Summary
   (`role=alert`, `tabindex=-1`, focused on failure, links each bad field);
   inline errors kept. 2 i18n keys, `.error-summary` style, ruling **D110**.
4. `dd2d8f1` — **[moderate, WCAG 1.3.5]** Sign-in / register / recovery fields
   had no `autocomplete` while `/account/password` + TOTP already did. Added
   username / email / name / current- & new-password / one-time-code.
5. `40d3706` — **[moderate, WCAG 4.1.3]** Problem list re-runs as the reader
   types; an empty result silently swapped the table for a line. Made the
   empty state `role="status"`.
6. `05f7265` — **[minor, WCAG 4.1.3]** Recovery-code "Copied" confirmation was
   a visual-only span. Made it `role="status"`.
7. `e9d20b2` — **[minor, WCAG 1.4.1]** Similarity `.match` tint measures only
   ~1.25:1 (light) / ~1.71:1 (dark) vs its surround — matched regions were
   distinguished by colour alone. Added a dotted underline (tint untouched,
   per D77). Text-on-mark contrast measured 13.8 / 9.5:1 — never the problem.

`cf2d9fd` rescopes two rejudge specs to the re-rate note (the shared
VerdictPanel is now a live region); `43227c4` adds axe-core + the e2e sweep.

## Verification / cleared with evidence

- **axe-core sweep** (`e2e/a11y-axe.spec.ts`): 8 screens (/, register,
  problems, help, contests, security, settings, submit) × light/dark/phone,
  **zero serious/critical** against a `vite preview` of this branch.
- **`aria-current`** — TanStack `<Link>` emits it (`STATIC_ACTIVE_PROPS`).
- **CodeMirror** — contenteditable has `aria-label` + `id`; `indentWithTab`
  with Escape-then-Tab exit, so no keyboard trap (verified on the real page).
- **No untranslated JSX / attributes** — grep empty. **i18n parity** (25
  tests) runs and passes with the new keys.
- **reduced-motion / focus rings / 44px / glass twins** — guarded by
  `app-css.spec.ts`; global `:focus-visible`.

## Concerns

- e2e a11y spec needs `E2E_SECRETS_FILE` set to the main repo's
  `.secrets/duckadmin.txt` when run from this worktree (worktrees carry none).
- D110 added while D109 is absent (reserved by a concurrent agent).
