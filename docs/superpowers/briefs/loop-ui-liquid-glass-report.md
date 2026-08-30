# Liquid Glass — UI loop report

Branch `worktree-agent-a8df150b174b74784`, 4 commits, not pushed. System recorded as **D67**.
Skill searches: `--design-system` (a landing-page pattern — unused); `--domain style "glassmorphism apple
liquid glass"` → the `liquid-glass` row, whose four checks (chrome/controls only, content on its own layer,
reduced transparency, reduced motion) are all met; `--domain ux` for targets and focus-not-obscured.

## Shipped
- **`apps/web/src/design/tokens.css`** (new) — the MATERIAL: neutrals, four glass depths (bar/sheet/
  raised/inset), radii, blur, shadows, spacing, motion, two font stacks. `app.css` `@import`s it and
  keeps the two SEMANTIC scales (verdict hues, D46 rank ramp) beside the rules that paint them.
- **`app.css` rebuilt on it**: floating glass nav (sticky top on desktop, fixed bottom + safe area on the
  phone), page sheets, raised panels, tables/code as inset wells, glass buttons/fields/chips, banners,
  admin stat tiles, case grid, print reset.
- **`index.html`** `viewport-fit=cover` (without it `env(safe-area-inset-bottom)` is 0 and the phone
  bar sits under the home indicator); **`vite.config.ts`** `/api` proxy so `vite preview` can be
  reviewed against the live stack without deploying.
- **Zero JSX changed.** `.panel`/`.muted`/`.field` were already emitted with no rule behind them; giving
  them meanings is what made a CSS-only design possible — no conflict surface with the concurrent work.

## Verification
`typecheck` · `lint` · `vite build` clean; `vitest run` **37 files / 342 tests green** (sequential; two
earlier parallel runs each timed out a *different* pair of async component tests under load from another
agent — each passes in isolation, and none of them loads a stylesheet). Browser-verified via CDP
`setEmulatedMedia`: under `prefers-reduced-transparency: reduce` the nav computes an opaque background,
`blur(0px) saturate(1)`, `--dur: .01ms` and `border-bottom-width: 1px` (the property `e2e/smoke.spec.ts`
asserts). `scrollWidth <= innerWidth` on all 9 screens × 390px × both schemes: no overflow.

## Contrast (22 text colours × 6 surfaces × 4 wash grounds; worst case)
| | light | dark |
| --- | --- | --- |
| worst of ALL pairings | **4.53:1** (`--tle` on sheet) | **4.53:1** (`--mle` on raised) |
| `--fg` | 16.6–18.0 | 12.0–14.5 |
| `--dim` (nav, labels, `.muted`) | 7.2–7.8 | 7.3–8.8 |
| verdicts | 4.53–6.7 | 4.53–7.0 |
| rank ramp (ten bands) | 5.5–9.0 | 5.8–12.0 |

Reaching it moved only the material (light sheet 0.72→0.79, dark raised 0.74→0.82 and darker, wash alphas
down), never a hue. `.badge`/`.case` gained an inset backing so a verdict's contrast belongs to the
component, not to the page behind it. **One correction:** dark `--rte` had been left at the light palette's
`#cf222e` since the dark scheme was written — 2.7–3.3:1 on every dark surface, a runtime-error verdict
nobody could see; now `#ef6a5f`, 4.8:1. `.case.skip` was a 1.6:1 `--faint` fill and now recedes
structurally (dashed hairline, no well) at 5.2/4.5:1.

## Screenshots
`apps/web/e2e/screenshots/` (gitignored), 74 files — `{before,after}-NN-<screen>-{desktop,phone}-{light,
dark}.png` over home+sign-in, register, problem list, statement, submissions, contest+clarifications,
scoreboard, admin, security, plus `fallback-solid-*`. Before = the live stack on :8080, after = `vite
preview` :4178 proxied to it; nothing was written to it, and no data was seeded.

## Concerns
1. **Twelve nav items scroll sideways in the phone bar.** Legible and thumb-sized, but a real bottom tab bar
   is ≤5; fixing it needs ShellNav JSX (an overflow sheet), untouched while problem-set routes land in
   `router.tsx`. Same reason: **admin sub-panels are `<>` fragments**, so they get headings, not cards.
2. **Translucency's floor:** over a backdrop the app does not draw, `--dim` falls to 2.3:1 — if an image
   ever goes behind this glass, the whole table must be re-measured, and D67 says so.
3. `prefers-reduced-transparency` is not universal; `@supports not (backdrop-filter)` covers the old
   browsers, but one with backdrop-filter and no support for that query ignores the OS setting.
4. The e2e journeys were not run (live stack, out of bounds); selectors were read and preserved, and the
   two with computed-style teeth (nav border-bottom, `main` ≤1000px) were browser-verified.
