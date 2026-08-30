# Loop b20 — accessibility + i18n

**Status:** DONE. Branch `worktree-agent-a93d9f4793acb9a35` (not pushed).
Web typecheck / lint / test (536) / `vite build` all green.

Each fix: failing test → fix → mutation-checked (red when the fix is
reverted) → one commit.

## Fixes shipped (6)

1. `3f6dcd1` — **[serious, WCAG 4.1.2]** The authoring test-data tab's
   per-case Input/Answer file inputs had no accessible name (the row's
   `<label for>` points at the textarea). Added `aria-label` + 2 i18n keys.
2. `73a41bd` — **[serious, WCAG 4.1.3]** The submit VerdictPanel's state and
   verdict arrive async but sat in plain `<p>`s — a screen reader was never
   told the outcome. Wrapped both in one `role="status"`; the dense case grid
   stays outside it so a poll does not re-announce every cell.
3. `6b732a3` — **[serious, WCAG 3.3.1]** The register form announced nothing
   and moved focus nowhere on a failed submit. Added a Focusable Error
   Summary (`role=alert`, `tabindex=-1`, focused on failure, links to each
   bad field), keeping the inline errors. 2 i18n keys, `.error-summary` style,
   ruling **D110**.
4. `dd2d8f1` — **[moderate, WCAG 1.3.5]** Sign-in / register / recovery
   fields carried no `autocomplete` while `/account/password` and the TOTP
   steps already did — an inconsistency. Added username / email / name /
   current-password / new-password / one-time-code.
5. `40d3706` — **[moderate, WCAG 4.1.3]** The problem list re-runs as the
   reader types; an empty result silently swapped the table for a plain line.
   Made the empty state `role="status"`.
6. `05f7265` — **[minor, WCAG 4.1.3]** The recovery-code "Copied" confirmation
   was a visual-only span. Made it `role="status"`.

`cf2d9fd` (test-only) rescopes two rejudge specs that assumed the submission
page had a single status region, now that the shared VerdictPanel is a live
region — guarded behaviour unchanged.

## Cleared with evidence (no fix needed)

- **`aria-current` on nav** — TanStack Router `<Link>` emits it on active
  links (`STATIC_ACTIVE_PROPS` in link.js). D76 claim holds.
- **CodeMirror editor** — has `aria-label` + `id` on the contenteditable, and
  `indentWithTab` with an Escape-then-Tab exit, so no keyboard trap.
- **No untranslated JSX** — grep for literal text nodes / attribute strings
  came up empty (placeholders are slug examples).
- **i18n parity** — `test/i18n.spec.tsx` (25) runs and passes with the new
  keys (parity both directions + NFC + placeholder sets).
- **Reduced-motion / focus rings / 44px targets / glass solid-twins** —
  token-level, guarded by `test/app-css.spec.ts`; global `:focus-visible`.
- **Similarity marks (D77)** — text uses `--fg` (D67 headroom) and the
  semantic `<mark>` conveys the match non-visually; not color-only.

## Concerns

- **axe-core Playwright pass not run.** `corepack pnpm add -D axe-core` fails
  offline (`ERR_PNPM_NO_OFFLINE_META`); the pnpm store has no copy. The live
  stack also runs the shipped bundle, not this branch, so an axe sweep there
  would not exercise these fixes. All six were instead verified through the
  real accessibility tree (Testing Library role/label queries). Re-run axe
  with network access when available.
- D110 was added while D109 is absent (reserved by a concurrent agent).
