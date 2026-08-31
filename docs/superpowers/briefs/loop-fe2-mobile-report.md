# loop fe2 — contest day on a phone

FE-1's three "left with reasons" items, all three fixed and all three measured in
Chromium at 390×844 and 1280×900, light **and** dark, before and after. Verified
against `vite preview` on :4321 — **the live bundle was never rebuilt.** Rulings:
**D136** (phone cards + table wrappers), **D137** (nav overflow), **D138** (signed-in home).

## 1 — the verdict was 470px across a 390px screen (D136)

`/submissions` put the one cell a student opens the list for in column six of eight
inside a sideways scroller, and `duong-di-ngan-nhat` came out as a tower of single
letters in a 60px cell. Below D76's 700px breakpoint each `<tr>` is now a grid whose
areas are named after the columns. **The markup does not change**: one `data-col` per
`<td>`, the `<table>` stays a `<table>`, captions are `attr(data-label)`
pseudo-content taken from the same translated `<th>` the desktop prints — so
`test/submissions.spec.tsx` needed **zero edits** and, measured, Chromium keeps every
row/cell role under `display: grid` on a `<tr>`. Verdict badge now ends at **352px**.

`a11y-surfaces.spec.ts` loses its "the wrapper carries the overflow" assertion for
`/submissions` — that was the bug written down as a requirement. The problem list and
the scoreboard keep it. **The scoreboard needs no cards**: measured at 390px its rank,
participant, score and cumtime cells all end inside the viewport (26–373px) and only
the per-problem columns scroll, which is what the tab stop is for.

## 2 — the bar was three rows at 1280px (D137)

1376px of pills in 928px of room. The five account PAGES and the theme choice moved
behind `Thêm` (the phone sheet's own word); the bell, the display name, the language
switch (D18) and `Đăng xuất` stayed, exactly as the journeys assert them. A
disclosure, not a `role="menu"`. Plus 8px off each `.nav-bar` pill's padding — the
first attempt wrote `.nav-bar a`, which ties with `.shell-nav a` declared later and
so never applied at all; found by running the new spec as `duckadmin`. Now **52px
tall, one row, for a pupil and for an admin**.

## 3 — narrow-table shrink-wrap ≤700px (D136)

**Real, and my card work does not retire it.** Reproduced to FE-1's exact number:
`/help` at 390px paints its header band 95px short. Cause: `table { display: block }`
makes CSS generate an *anonymous* table box that shrink-wraps and that no selector
can reach — which is why FE-1's three CSS-only candidates all failed. `.table-wrap`
restores `display: table`, applied at the **Markdown pipeline** (one change covering
every statement and guide table) plus the four progress and two org tables. Not 41.

## 4 — the signed-in home (D138)

Leads with the running (or next) round carrying D134's chip and D135's countdown as
the same components, then the reader's own last five verdicts as `.badge`es. No new
endpoint. A visitor's browser is asked for nothing and the signed-out page is
unchanged.

## Gate

`typecheck` clean · `lint` clean (src test e2e) · `vitest run --no-file-parallelism`
**626 passed (59 files)** · `vite build` ok · e2e against the preview build:
`mobile.spec.ts` + `a11y-surfaces.spec.ts` + `a11y-axe.spec.ts` **20 passed**. A
CSP-safe axe sweep over `/`, `/submissions`, `/help`, `/me/progress` at 390 and the
bar at 1280 **with the menu open**, light and dark: **zero serious/critical**. Every
fix mutation-checked (five: card class, wrappers, menu, padding specificity, a
grid-area rule) — red observed, restored.

**Concern.** `smoke`/`journey`/`features`/`contest-day` seed through `page.request`,
which the API refuses `403 csrf_origin` from the preview port, and against the live
stack they would exercise the OLD bundle. So the one touched line in
`features.spec.ts` (feature 11 now opens `Thêm` before clicking `Tiến độ`) is verified
only by a locator sweep I ran against preview — every locator those four specs use on
a changed screen, re-checked and resolving, as a pupil and as an admin. It runs live
only after deploy. Two smaller ones: a display name over 160px now truncates on the
desktop bar (whole in the DOM, so e2e-safe); and hiding the empty contest cell drops
a phone row from 8 cells to 7 in the a11y tree — deliberate, axe clean.
