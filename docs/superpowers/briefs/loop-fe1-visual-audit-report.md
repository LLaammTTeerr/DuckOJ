# loop fe1 — full visual audit of the live app

Swept **43 screens × 3 widths (1280 / 768 / 390) × light+dark = 258 configs**, signed
out, as `hocsinh1` and as `duckadmin`, screenshotting each into the gitignored
`apps/web/e2e/screenshots/audit/` and running a CSP-safe axe-core sweep (`page.evaluate`,
never `addScriptTag`) plus a `documentElement.scrollWidth > innerWidth` check per config.
Frozen-scoreboard state was manufactured (throwaway `fe1-freeze-*` contest, one AC by
`hocsinh1`) because every seeded freeze contest had ended. No throwaway accounts needed.
Fixes were verified against `vite preview` on :4321 — **the live bundle was never rebuilt.**

## Findings (prioritised)

| # | Screen / viewport / theme | What is wrong | Fix | State |
|---|---|---|---|---|
| 1 | `/problems`, 768px, both | Page scrolls **sideways by 170–193px**: nav, heading and every row slide under the thumb together. The table-scroll rule is `max-width:700px`, so the tablet band is unguarded. Also spills 15px past its own page sheet on desktop | the three wide tables sit in `.grid-scroll` | **fixed** |
| 2 | `/contests`, all | The one **running** round reads exactly like the 24 finished ones — phase is a plain word in column 5, and at 390px that column is off the right edge. The one question the list is asked on contest day | phase chip in the name cell, glyph + weight, column dropped (**D134**) | **fixed** |
| 3 | contest header, 390px | Month-long contest reads **`Kết thúc sau 671:53:57`** — a three-digit hour nobody converts to "four weeks" | `formatCountdownParts`, day-aware keys (**D135**) | **fixed** |
| 4 | `/problems/:code`, all | Memory limit printed raw: **`262144 KB`**, while the row the reader clicked from says `256 MB` | reuse `formatMemoryMb` | **fixed** |
| 5 | org page, 390px **dark** | Roster import ships a bare `<input type=file>`: **a white "Choose File" box in a dark page, in English** | the editor's picker, renamed `.file-pick` | **fixed** |
| 6 | `/submissions/:id` + `/admin`, 390px | axe **serious `scrollable-region-focusable`**: the source `<pre>` and two admin tables scroll but are not tab stops — the content off the right edge is unreachable without a mouse | `tabIndex`/`.grid-scroll`; axe spec extended to both screens | **fixed** |
| 7 | `/submissions`, all | Filter boxes labelled **`#`, `@`, `%`** — the real wording lived only in `aria-label` | real `<label for>` captions | **fixed** |
| 8 | `/submissions`, empty | "Không tìm thấy bài nộp nào." and nothing else — cannot distinguish "nothing submitted" from "filter matched nothing", offers neither way out | two sentences, one action each | **fixed** |
| 9 | every screen, 1280px signed in | Desktop nav **wraps to three rows**, "Đăng xuất" alone on row 3 — five account screens are promoted to the top bar | left | |
| 10 | `/` signed in | Home is two links and a paragraph; on contest day it says nothing about the contest | left | |
| 11 | `/submissions`, 390px | The **verdict** column is off the right edge; a student checking "did it pass?" must discover the swipe | left | |
| 12 | `/help`, narrow tables ≤700px | A table narrower than its well shrink-wraps, so the tinted header band stops ~95px short of the well's right edge | left | |

**Left, with reasons.** 9 and 10 are D76-level redesigns of the nav and the landing page,
not polish — both need a product call about what belongs on a top bar and a home page.
11: the honest fix is a sticky verdict column, but verdict is a *middle* column (points
and time follow it), so `position:sticky;right:0` would pin it *over* the columns
scrolling beneath — making it work means reordering columns, a separate product call.
The `.grid-scroll` wrapper at least makes it keyboard-reachable and names the region
("cuộn ngang để xem hết các cột"). 12 is inherent to `display:block` on a `<table>`: I
measured three candidate CSS remedies (`min-width` on row groups, `width:max-content`,
`overflow-x:clip`) in Chromium and none works — the only correct fix is a wrapper per
table, and wrapping all 41 tables is outside "polish".

**Checked and dismissed** (measured, not real): link/button vertical misalignment in
action rows (`delta: 0` on three screens); a missing `<th>` on the contest problem table
(the `<th />` is there; the apparent gap was the shrink-wrap of finding 12).

## Gate

`typecheck` clean · `lint` clean · `vitest run --no-file-parallelism` **616 passed
(58 files)** · `vite build` ok · e2e touched, against the preview build:
`a11y-axe.spec.ts` + `a11y-surfaces.spec.ts` **13 passed**. `smoke.spec.ts` **9 passed**
against the live stack — it cannot run against `vite preview` (its `page.request` writes
are refused `403 csrf_origin`, the preview port not being in the API's origin allowlist,
which is server config this loop must not touch); instead every locator the untouched
specs use on the changed screens was re-checked against the preview build directly and
all nine resolve. Every fix was mutation-checked (rule/line reverted, red observed,
restored); the D134 glyph invariant and the 768px overflow invariant are new committed
tests, in `app-css.spec.ts` and `a11y-surfaces.spec.ts` respectively.

The audit harness (`e2e/_audit.spec.ts`) was deliberately **not** committed: a
258-config sweep is a collector, not an assertion, and as a permanent spec it would be a
flake generator that the gate then has to run live every time.
