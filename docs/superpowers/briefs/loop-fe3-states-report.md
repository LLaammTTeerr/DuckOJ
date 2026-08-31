# loop fe3 — loading, empty, failing, offline

Swept 16 screens × {3s-delayed, 500, empty body, offline-after-load} with Playwright
`page.route` against `vite preview` on :4321 — **the live bundle was never rebuilt**
(only the worktree's own `dist`). Rulings **D140** (loading reserves space), **D141**
(the connection is visible), **D142** (a failure is named by its status). The three
collectors (`e2e/_states*.spec.ts`, `_look.spec.ts`, `_probe.spec.ts`) are deliberately
**not committed** — FE-1's precedent: a 64-config sweep is a collector, not an assertion.

## Inventory — ✗ is what a reader saw before this loop

| Screen | loading | empty | failing | offline |
|---|---|---|---|---|
| problems | ✗ table vanished, one grey line | ✗ one sentence for filter-empty AND nothing-published | ✓ named, no retry | ✗ nothing |
| problem | ✗ whole page → "Đang tải…" | — | ✗ **500 → "Không có bài tập này."** | ✗ |
| submit | ✓ form is static | — | ✓ | ✗ |
| submissions | ✗ | ✓ (FE-1) | ✓ named, no retry | ✗ |
| submission | ✗ | — | ✗ **500 → "Không có bài nộp này."** | ✗ + English `detail` |
| contests | ✗ | ✗ no next action | ✓ named, no retry | ✗ |
| contest | ✗ whole page | clar: "Chưa có gì." | ✗ **500 → "Không có kỳ thi này."** | ✗ |
| scoreboard | ✗ 720px of nothing, then the whole board | ✓ | ✗ notFound fallback, no retry | ✗ |
| monitor | ✗ | — | ✗ **16 s of 500s and it still said "Đang tải…"** | ✗ |
| orgs / org | ✗ | ✗ / — | ✗ **500 → "Không có tổ chức này."** | ✗ |
| org sets | ✗ | ✗ | ✗ **500 rendered as "Chưa có bài tập nào."** (B-8 swallow #11) | ✗ |
| admin | ✗ | — | ✗ error AND "Đang tải…" at once | ✗ |
| notifications | ✗ | ✗ "Chưa có gì." | ✓ | ✗ |
| progress | ✗ | ✓ | ✗ notFound fallback | ✗ + English `detail` |
| problem-edit / revisions / contest-new / contest-edit | ✓ | — | ✗ **six sites printed `error.code` AS the message** | ✗ |
| help | ✓ static | — | — | ✗ |

`clar` and `submit` are the only panels whose empty state already taught anything.

## Fixed (11)

1. **A 500 is not "it does not exist"** — contest, problem, submission, org page.
   `LoadError` picks the headline from `ApiError.status`; the caller's not-found
   sentence is kept for an actual 404 only.
2. **Every failed read offers `Thử lại`** — but only for status 0/5xx, `query.ts`'s own
   retry rule said for a human.
3. **A 401 is translated first** — "Đăng nhập để xem trang này." leads; the server's
   English `detail` stays as a muted second line (D18/`api-error.ts` kept). Needed
   `ApiError.detail` as its own field so the app's fallback is not reprinted as if the
   server had said it.
4. **A polling screen that fails stops saying "loading"** — TanStack's `fetchState()`
   clears `error` on every attempt while `data === undefined`; `useLastError` keeps it.
   Monitor and admin dashboard.
5. **Skeletons that reserve the space** — scoreboard, contests, problems, problem page.
   Measured, not asserted: the scoreboard `<h1>`'s `y` is identical loading vs loaded.
6. **An offline banner in the shell**, `role="status"`, above `<main>`, every screen.
7. **A vintage/stale line where a screen polls** — monitor (5 s) and the contest's
   clarification feed (30 s); quiet while healthy, a live region once 3 intervals late.
8. **`/problems` empty split** — filtered vs nothing-published, with the filters to
   clear (mirrors FE-1's `/submissions` fix); the clear here drops the search box too.
9. **Notification inbox** — "Chưa có gì." → what will arrive here, plus one link.
10. **Six raw `code` sites** → `CodeAlert`: a translated sentence plus the identifier in
    a `<code>`, which is what app.css's `[role="alert"] code` rule was always for.
11. **B-8 swallow #11** — `problem-sets.tsx`'s `data?.items ?? []`.

**Audit line:** every `api.GET` call site in `apps/web/src` now goes through `read()` or
checks `result.error` explicitly; no `?? []`/`?? null` on an unchecked response remains,
and no screen renders a bare `code`.

## Left

- **`/orgs` empty state.** A pupil looking at an empty school list has no next action
  this app can offer; a link to the guide would be furniture. Wording unchanged.
- **Skeletons on the other ~24 routes.** Forms and account pages nobody waits on.
- **`navigator.onLine` cannot see a captive portal** (reports `true`). A real liveness
  probe means a heartbeat request — a product call about traffic on contest day.
- **The socket's `contest-watched` refusal** still only shows as a suffix on the
  monitor's vintage line; not reworked.

## Gate

`typecheck` clean · `lint` clean (`src test e2e`) · `vitest run --no-file-parallelism`
**664 passed (61 files)**, up from FE-2's 626 · `vite build` ok · e2e against the
preview build, `states.spec.ts` + `a11y-axe` + `a11y-surfaces` + `mobile`:
**22 passed, 1 failed** — and that one, `a11y-surfaces`'s four-config axe sweep, fails
**identically against the unmodified live bundle on :8080**: a 60 s test-timeout inside
`axe.run`, not a violation and not mine. `states.spec.ts` alone: **4 passed**. A CSP-safe
axe sweep of my own over the failing contest page at 390 and 1280, light and dark:
**zero serious/critical, zero horizontal overflow**. Nine mutation checks (status headline,
retry gate, skeleton rows, offline banner, stale threshold, the empty split, the inbox
link, the swallow, and the scoreboard layout-shift measurement in Chromium) — red
observed, restored.

**Concern.** `smoke`/`journey`/`features`/`contest-day` still cannot run against
`vite preview` (D82 `403 csrf_origin` on their `page.request` seeding) and against the
live stack would exercise the OLD bundle — FE-2's concern, unchanged. None of them was
edited. `e2e/states.spec.ts` is deliberately built so it does not have that problem:
`page.route` only, no writes, so it runs against preview now and live after deploy.
