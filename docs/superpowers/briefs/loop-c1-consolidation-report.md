# c1 — consolidation pass (CI, re-baseline, fresh-DB, residual sweep)

**Status: DONE.** Branch `worktree-agent-a0af9f57b76c25fe5`, nothing pushed.
Rulings **D106–D108**. Read ~30 loop reports; the residual sweep is
essentially complete (B-9/B-13/B-19/F-13/F-14 closed nearly every named item),
so most of this pass closes them with a ruling so they stop being
re-discovered (the B-19 lesson).

## 1. CI is now deterministic (finding #1) — D106
`pnpm -r test` ran packages concurrent with vitest file-parallelism; it flakes
on a loaded runner because `apps/api`'s 121 spec files each start their own
Testcontainers Postgres. Fix, CI-only, local dev untouched:
- `test:ci` = `pnpm -r --workspace-concurrency=1 test -- --no-file-parallelism`
  (forwarding verified onto every package's `vitest run`) — one container at a
  time; CI's Test step calls it. `timeout-minutes` 25 → 60 (serial is slower).
- `test:boot` = build `apps/api` + run `app.boot.spec` (B-15) against `dist/` —
  new CI step catching a DI break like the Aug-30 outage in ~7 s.
- **Proven green locally: `test:ci` exit 0, 962 s, 20/20 packages, 0 failed
  (api 1071, web 526); `test:boot` 6/6.**

## 2. Load re-baseline — load/RESULTS.md, 2026-08-31, deployed `9bb8291`
- **500-VU reads (clean A/B vs B12):** aggregate p95 **397 ms ✓**, 1734 req/s,
  0 failed; every route under 800 ms and 2–13% faster than B12.
- **2000-VU headline (one-shot):** **1623 req/s**, p95 **1.73 s**, 535,593
  reqs, 0 failed, vus hit 2000; per-route p95 down 10–30% vs B12 (bar still
  crossed on heavy routes = documented 4-worker ceiling).
- **Soak (200 subs, 20 `c1-soak-*`, 40/min):** 200/200 AC, **39.4/min**, queue
  peak **2**, TTV **p50 1.1 s / p95 1.5 s**, 0 s drain — B12's 12% deficit /
  24 s p50 gone (same single judge).
- **Meter (D80):** read k6 is reads-only so D80 can't touch it (0 fails);
  live-probed POST twice → **201 then 429 `submission_rate_limited`** (what
  throttles the soak, hence 20 accounts).

## 3. Fresh-DB integrity — D107
Throwaway `postgres:16-alpine`: `migrate` applied all **33** files (journal idx
0000–0038, deliberate gaps 0020/0030–0034) clean → 40 tables; `drizzle-kit
generate` → **No schema changes**, no new file; `contest-formats` goldens
**byte-identical** (27/27). Boot spec is the app-layer fresh-deploy proof.

## 4. Residuals — D108 indexes the standing ones
**Fixed:** `apps/web/e2e/journey.spec.ts` journey 8 `source_access` PATCH now
sends `Origin` (B-14 named it; D82 403s it otherwise) — verified by inspection
(e2e needs live stack + Playwright; excluded from vitest).
**Verified already-closed (were re-listed):** `admin.totpNote` (F14),
`editorialShow`, `draft.store` `.`/`..` (D87), gateway readyState, `broadcast`
ORDER BY+limit (F13), `GET /packages/{hash}` `@RequireScope`, submissions `:id`
Zod (NaN→422). **D108** indexes the standing choices with no prior ruling —
unbounded reads, metering gaps, D35 mask softness, B-15 harness fidelity,
judge/Redis/XFF ops bounds, web/UX bounds, D99 team races — each with origin.

**Verify ritual (all green):** typecheck (+scripts), lint (+scripts), `test:ci`
exit 0 (962 s), regen no diff, `vite build` clean, `graphify update .`.

## Concerns
1. Soak's jump over B12 is per-grade cost (warm build + quiet host), not more
   judges (still one judge); a bigger room still wants F11's second.
2. Local `test:ci` proof needed a corepack pnpm shim on PATH (script's nested
   `pnpm -r` isn't on PATH here); CI has pnpm via `pnpm/action-setup`.
3. journey.spec fix not runnable here (needs live stack); mirrors the file's
   afterAll + B-14. Left on live stack: 20 `c1-soak-*` + 1 probe, 202 AC subs.
