# Navigation IA — UI loop 2 report

Branch `worktree-agent-ab958f1a741b2839f`, not pushed. Recorded as **D76**. Skill searches: `"bottom navigation tab bar"`
and `"navigation hierarchy"` `--domain ux` (sticky-nav clearance, keyboard nav, breadcrumbs; the priority-9 row "Bottom
nav ≤5, deep linking, predictable back" is what this implements). `--stack react` returned **no database match**.

## Shipped
- **`apps/web/src/nav.tsx`** (new) — `ShellNav` split out of `router.tsx`, which re-exports it so `test/i18n.spec.tsx` and
  `test/logout.spec.tsx` import from the same place; `LocaleToggle`/`SignOutButton` moved with it, comments intact.
- **Desktop (>700px)** — one glass bar, three named `role="group"`s: `Bài tập · Kỳ thi · Bài nộp · Tổ chức` | `Trợ giúp ·
  API` (+ `Quản trị` for an admin) | the account rail behind a hairline (bell, display name, settings, security, tokens,
  password, VI|EN, sign out). `<nav aria-label>` names the landmark.
- **Phone (≤700px)** — five tabs, SVG icon over word: problems, contests, submissions, the bell (a visitor gets `Đăng
  nhập` — a bell with no session is a dead tab), `Thêm`, which opens a glass sheet with the other nine items. Every route
  is one tap or two.
- **The sheet** — `role="dialog"` + `aria-modal`; the trigger carries `aria-haspopup/expanded/controls`; focus moves in on
  open and back to the trigger on close; Tab/Shift+Tab wrap; Escape (document-level, so a backdrop click cannot deafen it)
  and backdrop dismiss; every item closes it. A **sibling** of `.shell-nav`, not a child: the bar's `backdrop-filter` makes
  it the containing block for `position: fixed`. Slide-up via `var(--dur)`, flattened by the D67 reduced-motion token.
- **Two glass leaks fixed.** The bare `button` rule gave the phone's `Thêm` tab a raised chip (it read as permanently
  active beside four flat link tabs) and painted a **12px backdrop blur across the whole viewport** behind the sheet. Both
  flattened; the new `--scrim` token dims the page instead. The unread badge moved from `--rte` to `--fg`/`--bg`: D67 rule
  1 reserves hue for verdicts, and a red bell sits inches from a table painted in it.
- Seven `nav.*` keys appended to both catalogues (NFC); `nav.notifications` stays the spoken sentence with `{count}` and
  the badge is `aria-hidden`, so the count is not read twice. 44px targets throughout, `env(safe-area-inset-bottom)` on
  bar and sheet, the `aria-current="page"` raised pill in both shapes, no icon without its word, never emoji.

## Verification
`typecheck` · `lint` · `vite build` clean; **42 files / 412 tests green** (`vitest run --no-file-parallelism`), 14 new in
`test/nav.spec.tsx`: grouping, ≤5 tabs in both auth states, admin gating in bar and sheet, open/close/Escape/backdrop,
focus in-and-back, Tab wrap. The 7 collection failures on the first run are `@duckoj/contracts` unbuilt, not this change.
`test/poll-visibility.spec.tsx` now reads the bell's interval from `nav.tsx` (it moved), still sweeping `router.tsx` too.

**Which tree renders is `window.matchMedia`, not CSS** — a focus-trapped sheet is not a CSS state, and rendering both trees
would double every link in the accessibility tree. jsdom has no `matchMedia`, so it answers *desktop*: the pre-existing
suite exercises the bar it always did. 24 screenshots in the gitignored `apps/web/e2e/screenshots/` (`d76-*`) — 1280×800
and 390×844, light and dark, signed out and signed in; the signed-in pair fulfils `/auth/me` and `/notifications` **in the
browser**, so nothing was written to the live stack. `scrollWidth <= innerWidth` everywhere at 390px; sheet shots show 5 tabs.

## Concerns
1. **The e2e journeys were not run** (live stack, out of bounds). Every selector they use was read, preserved, and lives
   in the desktop tree — the only one Chromium's 1280×720 default renders; journey 6's 390px case asserts only a visible
   `nav.shell-nav` and no sideways scroll, both verified here.
2. **`help.tsx` still describes the old bar** ("Thanh điều hướng luôn có: … chuông thông báo `[ ]` …"), visible in
   `d76-12`. That file belongs to the concurrent agent; the copy needs a pass for the tab bar and the `Thêm` sheet.
3. **The signed-in desktop bar wraps to two rows at 1280px** (work+reference, then account) — deliberate, wrap over clip,
   but eight account items is the ceiling; a ninth wants a real popover.
4. **The account cluster groups, it does not collapse** (D76). A dropdown must first renegotiate the sign-out and
   display-name `toBeVisible()` assertions in `journey.spec.ts`/`smoke.spec.ts`, which encode the shared-school-machine
   rule that sign-out stays one click away.
