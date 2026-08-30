# B4 — bug hunt: web UI (2026-08-29 feature/bug loop)

Playwright over all 30 routes × {vi, en} × {1280, 390×844} × {anon, `bh4-probe1`, duckadmin}
— console errors, failed requests, overflow, `<html lang>`, screenshots, bad-param deep links
— then read every route file. Five commits of fixes (red first, then re-mutated) and six
findings cleared, verified end to end by serving the worktree's own `dist` on :8099 with
`/api` proxied to the live stack (the live one untouched). Ritual green: typecheck, lint,
**281 tests**, `vite build`. No D-entry: D44–D45 stay unused, nothing here was a ruling.

## Fixed (live repro → fix)

1. **`abfacdb` — every checkbox rendered as a 100–156px bar across its own label.**
   `app.css`'s `input { width: 100% }` has no type filter, so it caught `checkbox`/`radio`.
   F2's topic filter measured `100x13`/`156x13`/`52x13` over the words beside it (unreadable
   at 1280px, screenshotted) and pushed the document to `scrollWidth 454` in a 390px viewport
   → after, `13x13` and `390`. Also the tag picker, contest `rated`, token scopes. Rode
   along: a width for `fieldset input[type=number]`, and **m22** (`.dq td` named an
   undeclared `--muted`). `test/app-css.spec.ts` reads the real cascade in jsdom.
2. **`8a306ed` + `27646b8` — every not-found deep link spun "Đang tải…" for 7.4 s and asked
   four times.** Read screens threw a bare `new Error(detail)`, so TanStack Query's default
   `retry: 3` treated a 404 as transient: `/users/NOPE` at 404@114ms, 1119, 3129, 7135.
   `src/api-error.ts` keeps the status on the throw and `src/query.ts` never repeats a 4xx,
   still retrying 5xx and network failures → 92/102/96ms, and `/contests/NOPE` 7412ms →
   115ms once the second commit took the nine queryFns the first missed. `contest-edit` and
   `problem-revisions` had each reached for a local `retry: false` — one bug diagnosed twice,
   now one policy. **It shipped because all 23 web specs build their client with
   `retry: false`.**
3. **`180aaa6` — `/submissions/abc` requested id `NaN`.** The router builds
   `Number(params.id)`; live that meant `GET /submissions/NaN` (422, then 502 on retry) with
   TanStack's `["submission",null] data is undefined` as the page body. Now a not-found.
4. **`2bb3e60` — m18 + m19.** `translate` returned the catalogue hit unguarded, and three
   lookups build their key from a server value (`revState.${r.state}`, `visibility.*`,
   `sourceAccess.*`): an unknown enum rendered blank, and with vars `template.replace` threw
   mid-render. And the VI|EN toggle's `aria-label` sat on a bare `<span>` (role `generic`,
   unnameable) so it was dropped — `role="group"` now, plus the dead keys
   `nav.language{Vi,En}` as the buttons' labels.
5. **`b7fedff` — mark-all-read had no busy flag, no catch, no error line.** Two clicks were
   two POSTs; a network failure (openapi-fetch rethrows those) was an unhandled rejection.

## Cleared, with evidence

- **XSS** (`384ef84`): svg `onload`, `<animate>` href rewrite, `annotation-xml` smuggling,
  `iframe srcdoc`, `object`, meta refresh, `<base>`, the `</noscript>` mXSS and DOM
  clobbering are all neutralised and now pinned; 12 of 16 go red without `DOMPurify`.
  KaTeX errors render red without eating the prose; usernames and display names are
  React text, never raw HTML.
- **Bell unread after read**: 1 → 0 on the shared `['notifications']` entry. **Locale /
  `<html lang>`**: right on all 30 routes, both locales, survives reload. **Pagination
  cursors**: filters live in the queryKey, so a filter change starts a fresh query.
  **WebSocket reconnect**: covered by `submission-socket.spec.tsx`, not re-proved live since
  restarting the API was out of bounds. **m20**: already fixed by B-1.

## Rulings and concerns

- **m21 left unfixed**: the scroller is the `<table>` itself, so `tabindex="0"` goes on every
  table on every screen and adds a dead tab stop on desktop — a wrapper refactor, not a bug
  fix, but a real WCAG 2.1.1 gap. Likewise: the authoring forms render to a signed-out
  visitor, refused only on save.
- **API, out of area:** `GET /api/v1/submissions/NaN` answered 422, then **502** on retry —
  an unparseable path parameter should not reach a gateway error.
