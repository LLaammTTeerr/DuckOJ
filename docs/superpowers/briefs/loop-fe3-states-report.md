# loop fe3 — loading, empty, failing, offline

16 screens × {3 s-delayed, 500, empty body, offline-after-load}, forced with Playwright
`page.route` against `vite preview` on :4321 — **the live bundle was never rebuilt**.
**D143** loading reserves space · **D144** the connection is visible · **D145** a failure
is named by its status. (The brief reserved D140–D142; another agent had taken them on
main, so these were renumbered — the first two commit messages still say the old ones.)
The four collectors (`e2e/_states*`, `_look`, `_probe`) are deliberately not committed.

## Inventory — ✗ is what a reader saw before this loop

| Screen | loading | empty | failing | offline |
|---|---|---|---|---|
| contest | ✗ whole page → "Đang tải…" | clar "Chưa có gì." | ✗ **500 → "Không có kỳ thi này."** | ✗ |
| problem | ✗ whole page | — | ✗ **500 → "Không có bài tập này."** | ✗ |
| submission | ✗ whole page | — | ✗ **500 → "Không có bài nộp này."** | ✗ English `detail` |
| org | ✗ whole page | — | ✗ **500 → "Không có tổ chức này."** | ✗ |
| org sets | ✗ | ✗ | ✗ **500 → "Chưa có bài tập nào."** (B-8 swallow #11) | ✗ |
| monitor | ✗ | — | ✗ **16 s of 500s, still "Đang tải…"** | ✗ |
| admin | ✗ | — | ✗ the error AND "Đang tải…" at once | ✗ |
| scoreboard | ✗ 720px of nothing, then the whole board | ✓ | ✗ notFound fallback | ✗ |
| problems | ✗ table vanished | ✗ filter-empty = nothing-published | ✓ named, no retry | ✗ |
| notifications | ✗ | ✗ "Chưa có gì." | ✓ | ✗ |
| progress | ✗ | ✓ | ✗ notFound fallback | ✗ English `detail` |
| authoring ×4 | ✓ | — | ✗ **six sites printed `error.code` AS the message** | ✗ |
| contests, submissions, submit, help | ✗ bare line | ✗/✓ | ✓ no retry | ✗ |

**No offline signal existed anywhere in `src/`** — `navigator.onLine` was never read.

## Fixed (11)

1. `LoadError` takes its headline from `ApiError.status`, so a 500 stops claiming the
   thing is missing; the caller's not-found sentence survives for an actual 404.
2. `Thử lại` on every failed read — only for status 0/5xx, which is `query.ts`'s rule.
3. A 401 is translated first; the server's English `detail` drops to a muted second line
   (D18 kept). Needed `ApiError.detail`, so this app's own fallback is not reprinted.
4. A polling screen that fails stops saying "loading": TanStack's `fetchState()` clears
   `error` on every attempt while `data === undefined` — `isError` has the same hole —
   so `useLastError` holds it. Monitor + admin dashboard.
5. Skeleton rows reserve the space: scoreboard, contests, problems, problem page.
6. An offline banner in the shell, `role="status"`, above `<main>`, on every screen.
7. A vintage line where a screen polls — monitor (5 s), contest clarifications (30 s);
   quiet while healthy, a live region once three intervals late.
8. `/problems` splits filter-empty from nothing-published (FE-1's `/submissions` fix);
   the clear offered there drops the search box too.
9. The notification inbox says what will arrive there, plus one link.
10. Six raw `code` sites → `CodeAlert`: a sentence plus the identifier in a `<code>`,
    which is what app.css's `[role="alert"] code` rule was always written for.
11. B-8 swallow #11 — `problem-sets.tsx`'s `data?.items ?? []`.

**Audit, re-run after the changes:** every `api.GET` in `apps/web/src` throws or checks
`result.error`; the one surviving `data ?? null` on a raw response is `me.ts`'s
`/auth/me`, where 401 is the answer. No screen renders a bare `code`.

**Left.** `/orgs`' empty state (a pupil has no next action there; a guide link would be
furniture) · skeletons on the other ~24 routes (forms nobody waits on) ·
`navigator.onLine` cannot see a captive portal, and a real probe means a heartbeat
request — a product call about contest-day traffic · the socket refusal is still a suffix.

## Gate

`typecheck` clean · `lint` clean (`src test e2e`) · `vitest run --no-file-parallelism`
**664 passed (61 files)**, from FE-2's 626 · `vite build` ok. E2E on the preview build,
`states` + `a11y-axe` + `a11y-surfaces` + `mobile`: **22 passed, 1 failed** — that one,
`a11y-surfaces`'s four-config axe sweep, fails **identically on the unmodified live
bundle at :8080** (a 60 s timeout inside `axe.run`; not a violation, not mine).
`states.spec.ts` alone **4 passed**; my own CSP-safe axe sweep of the failing contest
page at 390/1280 × light/dark: zero serious/critical, zero overflow. Nine mutation
checks — red observed, restored.

**Concern.** `smoke`/`journey`/`features`/`contest-day` still cannot run against
`vite preview` (D82 `403 csrf_origin` on their seeding) and against the live stack would
exercise the OLD bundle — FE-2's concern, unchanged; none was edited.
`e2e/states.spec.ts` avoids it by design: `page.route` only, no writes.
