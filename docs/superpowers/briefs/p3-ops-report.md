# P3 — province-scale ops: report

**Status: DONE_WITH_CONCERNS.**

## Shipped
1. **Backup/restore.** `scripts/backup.sh` (pg_dump -Fc via `podman exec` + `podman volume export` of `package_store`, timestamped, `KEEP=14`, prints sizes) and `scripts/restore.sh` (`CONFIRM=yes` required, stops api/judged, `pg_restore --clean --if-exists`, volume import, restarts). Both find postgres by compose label as `compose-up.sh` does; artefacts are written `.partial` and renamed only on exit 0, so a truncated file never looks restorable. `deploy/duckoj-backup.{service,timer}`: user units, `__REPO__` placeholder, `OnCalendar=*-*-* 03:00:00 Asia/Ho_Chi_Minh` (validated via `systemd-analyze calendar`), `Persistent=true`. Runbook "Backups"; **D17**.
2. **Judged concurrency.** It was one-at-a-time. `JUDGED_CONCURRENCY` (zod int 1..16, default 2) → `startWorkerPool` spawns N unmodified `Worker`s as `judged-1#1..#N`; `main.ts` awaits the pool; compose + `.env.example` wired. `Worker` untouched — concurrency was already safe (`claim()` is `FOR UPDATE SKIP LOCKED`, heartbeat/complete fence on (job, attempt), `worker_id` is diagnostic only).
3. **Load smoke.** `load/k6-contest-day.js` (2000 VU / 2m ramp + 3m hold, 70/20/10, `BASE_URL`/`CONTEST_KEY`/`PROBLEM_CODE`, p95<800ms, error<1%, plus a per-leg `leg_errors` rate) + `load/README.md`. Full profile NOT run. Runbook also gains "Judging throughput" (judged vs judge ceiling, and exact judge-2 steps).

## Evidence
Backup/restore against a throwaway postgres + volume, both removed after. The live stack was never stopped, restarted, or written to — `podman ps` showed the same six containers up before and after:
```
backup     ==> Dumping 'duckoj' from duckoj-backup-proof; exporting duckoj-proof-store
           4.0K .dump / 4.0K .package_store.tar
destroy    DELETE 1 -> rows_left 0 ; volume emptied
no CONFIRM REFUSING: this overwrites the database. (exit 1)
restore    ==> Database restored ==> Package volume restored
verify      1 | Ha Giang    and    -rw-r--r-- 11 abc123.zip -> "pkg-abc123"
idempotent second restore -> count 1 (unchanged)
prune      KEEP=2 over 4 backups -> "Pruning 3", newest 2 left
```
Concurrency **red→green**: `test/worker-pool.spec.ts` red with `startWorkerPool is not a function`. **Mutation check**: pinned the pool to `{ length: 1 }` → the 3-in-flight test failed on its 5s wait (1 failed | 1 passed); restored → green. The test holds every dispatch open until N are in flight, so a single loop claiming N jobs in sequence cannot pass it.

k6 sanity, 10 VU / 20s against `http://localhost:8080`:
```
checks_succeeded: 100.00% 14550/14550   http_req_failed: 0.00% 0/14552
p(95)=15.04ms   ✓ p(95)<800   ✓ http_req_failed<0.01   ✓ leg_errors<0.01
```
**Gate:** `pnpm -r typecheck`, `typecheck:scripts`, `pnpm -r lint`, `lint:scripts`, `pnpm -r test` (exit 0; judged 71/71, api 452/452), contracts + SDK regen with **no diff**, `vite build` — all green.

## Rulings (no human available)
1. My worktree branch was **5 commits behind `main`** and had no `deploy/`, no `.env.example`, no briefs. Fast-forwarded (0 ahead, clean ff) before starting.
2. Committed on the **worktree branch**, not `main`: `conventions.md` says "current branch (main)", the dispatch says worktree branch — dispatch wins.
3. `GET /api/v1/submissions` is **401 unauthenticated**, so `SESSION_COOKIE` is optional: unset, the 10% leg is skipped, folded into problem browsing, and `setup()` warns loudly — thresholds stay honest rather than counting 401s as errors.
4. `CONTEST_KEY` defaults to `probe-cup`, an existing live contest; I did not create one through the live API for a cleaner fixture.
5. `container_for_service` is **duplicated** into both scripts rather than extracted to a shared lib: the allowlist names only backup.sh/restore.sh, and boot-critical `compose-up.sh` keeps having no dependencies of its own.
6. **D17, not D16** — DECISIONS.md ends at D15; the brief says D17, so D16 is presumably another implementer's. Used D17 verbatim; the gap is deliberate.
7. Added `/* global __ENV, console */` to the k6 script: `load/` is outside the lint gate (`pnpm -r lint` + `lint:scripts`) but is now clean under a broader `eslint .` without needing a config entry.

## Concerns
- **`JUDGED_CONCURRENCY=2` with one judge is a deeper queue, not throughput.** `DmojDriver.capabilities()` still says `concurrency: 1` and nothing consults it, so judged now broadcasts a second `submission-request` mid-grade. No correctness issue found; the only gain is that one slow grade stops blocking the queue head. **Not observed under real load** — I never submitted through the live judge.
- **`DmojDriver.live` is keyed by job id, not (job, attempt).** Its own class comment says this stops being a corner case once several judges run concurrently. Judged concurrency alone does not trigger it; adding `judge-2` would. Flagged in the judge-2 steps.
- The **second-judge procedure is documented, not tested** (per the brief). Its one non-obvious fact is verified: `judge_nodes` has a UNIQUE index on `token_hash`, so judge-2 needs a *different* token, and the documented `encode(sha256(...),'hex')` matches `hashJudgeToken` exactly.
- **`restore.sh`'s stop/start path is designed, not executed.** The proof ran it with `SERVICES=""` to stay off the live stack, so what is proven is the data path: pg_restore round-trip, volume import, CONFIRM gate, idempotence, pruning. `podman-compose stop api judged` → restore → `start` has never actually run. Same status as the judge-2 procedure. The first real restore should be watched, not trusted.
- **Nobody has run the 2000-VU profile against anything.** The sanity pass is three orders of magnitude below target — evidence of correctness, not of capacity. Said so in `load/README.md`.
- **Backups are single-site and unmonitored** (D17); nothing warns if the off-host copy stops happening.
- **The live stack restarted at 14:56 while I was working — not by me.** `duckoj.service` (the boot-time unit) ran `compose-up.sh` from the main checkout, coinciding with a host process restart. `RestartCount=0`, fresh containers, `working_dir=/home/lamter/Projects/duckoj`. I ran no compose/systemctl command at any point. Verified afterwards that my work has **not** reached production: live `duckoj_judged_1` has no `JUDGED_CONCURRENCY` in its env and never logged `starting worker pool`, i.e. it is still the single-loop image built from `main`. Everything here is committed to the worktree branch only, and nothing is deployed.
