# F5 — admin operations dashboard + real rank names (2026-08-29 feature/bug loop)

Six commits, no migration. Ritual green: **1362 tests / 162 files**, regen with no
diff, `vite build`. D6 superseded by **D46**, **D47** rules the dashboard; sixteen
mutants run and sixteen killed.
## A — operations dashboard (D47)

`GET /admin/dashboard` — session-only, admin-only, tag `Admin`: one snapshot, six
panels, one aggregate query each, nothing cached. `DashboardService` sits in `authz/`
(two panels read guarded tables) and answers `403 admin_forbidden`, not 404 — a fixed
path hides nothing. Web `/admin` gains an Operations section: stat tiles then a table
per panel, `refetchInterval: 15_000`, i18n vi/en, `.stats` reflowing to two phone
columns with no breakpoint. Rulings:

- **`grading_jobs` has no `running` state**, so the leased count splits on whether
  the lease is live; `expiredLeases` matches `reclaimExpiredLeases`'s WHERE exactly,
  because the button is labelled with it. Empty queue → `null`, never `0`.
- **Judges and workers are two panels and do not join**: a `judge_nodes` row is a
  DMOJ process on judged's bridge, `worker_id` is one of judged's claim loops, no
  column relates them. Liveness there (silent 90 s = offline), throughput here.
- **Refusals were not derivable, so they are recorded now**: `rate_events` holds
  one row per *attempt*, so a refusal writes a second under `refused:<purpose>` from
  `allow`, `consumeOnce` and `retryAfterSeconds` — which IS how login refuses. Plain
  text → no migration. Wart: login asks per key, so one refusal can mark twice.
- **`JUDGED_CONCURRENCY` reads `null` when the API was not told**; compose now feeds
  both containers the same variable, and unset says "not reported", never `1`.
- **`POST /admin/grading/reclaim` answers 200, not 202** (the UPDATE is done) and
  **bumps `attempt`** — `claim` already sweeps lapsed leases, so cutting a past-lease
  judge off instantly is the button's point. The statement moved to `@duckoj/db`, so
  judged's `reclaimExpired` (dead since written, B3) and the API share one copy.

## B — real rank names (D46, closing D6)

`rankBand()` → `{ key, nameVi, nameEn, min }`, thresholds unchanged so nobody's
title moved: Tân binh / Học viên / Chuyên gia / Cao thủ / Ứng viên kiện tướng /
Kiện tướng / Kiện tướng quốc tế / Đại kiện tướng / …quốc tế / …huyền thoại — both
locales on one data row (the D18 tag shape). The unused `color` hex is gone: the
**key is the CSS class** and `app.css` owns `--rank-<key>` in both palettes — the
one amendment to app.css rule 1, written into that file's header: a desaturated
ramp at half a verdict's chroma, on one row of one screen, never beside a verdict,
never colour alone.

## Tests (red → green, then mutated) and concerns

New `apps/api/test/admin-dashboard.spec.ts` (13, `testDbUrl()`) — 5 red first, then
7 mutants killed: `running` counting lapsed leases · `min`→`max` oldest wait ·
90→900 s silence · 1→2 h window · failures including WA · limit 20→25 · refusal
prefix off by one. `bands.spec.ts` 4 red (blank name → 2 red); `user.spec.tsx` 3 red
plus a spec reading `app.css` that refuses a band missing `.rank.<key>` or a dark var
(2 red); `job-store.spec.ts` 4 red (no attempt bump → fencing reds, no
`state='leased'` → finished-job reds); `rate-limit.spec.ts` 3 red; `admin.spec.tsx` +7
(dropped `refetchInterval` · dropped "moved nothing" · age always in seconds).

**No index added, deliberately**: the queue/worker panels aggregate all of
`grading_jobs` (grows forever, D11) and the failures panel filters `submissions`
unindexed — thousands of rows at province scale; upgrade path in D47.
`judge_nodes.capabilities` is still written by nothing, hence no per-node
concurrency. `retryAfterSeconds` now writes on its refusing branch: a read with a
side effect, documented at the site. The live stack reads `judgedConcurrency: null`
until the next deploy. Nothing stopped or rebuilt; worktree untouched; not pushed.
