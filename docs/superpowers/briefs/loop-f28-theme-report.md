# Loop f28 — manual light/dark/system theme toggle

**Status: DONE.** Web typecheck + lint + test (560 pass) + build all green.

## What shipped

A three-way theme control — Sáng / Tối / Hệ thống (Light / Dark / System) —
that sets `data-theme="light"|"dark"` on `<html>`; System removes the
attribute and falls back to `prefers-color-scheme`. Per-DEVICE, in
`localStorage['duckoj.theme']` (try/catch on every access), never on the
server — the deliberate opposite of D57's per-account language/zone (recorded
as D116).

- **`apps/web/src/theme.tsx`** (new) — the store (`useSyncExternalStore`, no
  provider, so the nav control and the settings control agree instantly) plus
  the `ThemeToggle` (role="group" + aria-pressed, 44px, keyboard-reachable).
- **`index.html`** — a blocking inline pre-paint script reads the key and sets
  the attribute before the stylesheet paints the `--bg` wash, so no flash.
- **`tokens.css` / `app.css`** — the dark palette (material, and the
  verdict/syntax/rank scales) is now DEFINED ONCE as `--dark-*` source
  aliases; two thin trigger blocks — the OS media query and
  `:root:where([data-theme="dark"])` — alias the live tokens to them. Bodies
  are identical (guarded), so the D67/B-20 measured AA pairs hold in all three
  modes by construction. `:where()` keeps the attribute triggers at (0,1,0) so
  the solid-twin collapse blocks still win — a bare `[data-theme="dark"]`
  would keep translucent glass for a forced-dark + reduced-transparency reader.
- **nav.tsx** (desktop account cluster, both signed-in/out; phone Thêm sheet)
  and **routes/settings.tsx** each mount the toggle. **i18n** vi/en: 6 keys.

## Tests (`test/theme.spec.tsx`, 14) + mutation evidence

Store defaults/guards; toggle sets+persists and clears both for System;
aria-pressed; pre-paint script applies dark / leaves System off / never throws
on blocked storage; dark palette exists under `[data-theme="dark"]`, the two
mapping bodies are identical, `:where()` present. Mutation-checked: neutering
`applyTheme('system')`'s attribute removal turned it red, restore turned it
green. `test/setup.ts` clears `data-theme` + the key per test; `i18n.spec`
`DYNAMIC_KEY_PREFIXES` gained `theme.` (keys built as `theme.${option}`).

## Evidence & rulings

- Before/after screenshots (home, help, register × light/dark/system) in the
  gitignored `apps/web/e2e/screenshots/{before,after}/`; verified forced light
  overrides a dark OS and forced dark overrides a light OS.
- Ruling (D116): theme is per-device, not per-account, and is offered to
  signed-out visitors too (nav shows it in both branches).

## Concerns

- None blocking. Screenshots use `vite preview` with no API, so only shell +
  static screens are shown (enough to prove the theme); data-bearing screens
  need the live stack. Committed on the worktree branch; not pushed.
