# B13 — the six leftovers, closed

Six commits, each red-first and re-mutated. **D80/D81/D82** new, **D61 amended**. Migration 0030
reserved and **unused**: none needed schema — D80 rides `rate_events`, whose `purpose` is plain text
for exactly this reason.

**1. `0891909` — typst had no bound.** Author-controlled input to a Turing-complete typesetter,
reached for a whole contest at once by D48's booklet. 20 s / 32 MiB, injectable, `detached` +
process-GROUP kill: typst is one shell away from a tree, and `child.kill()` leaves a grandchild
running against an answered request. `#while true { }` is refused statically, so the reachable shape
is content generation — measured `#for i in range(3000000) [#i ]` at >6 s on the real binary.
Mutants: no timeout → resolves after 30 s; single-pid kill → the grandchild's marker file appears;
no cap → **JS heap OOM**.

**2. `f4f36a5` — a revoked judge kept its socket (D81).** `verifyJudge` runs once, at the handshake;
B11's mitigation ("its package fetches 401") is really every submission there failing rather than
grading. `BridgeServer` polls `admittedJudgeNames` every 5 s and closes + retires what the answer
omits. Poll, not NOTIFY: `judge_nodes` changes twice a year, and LISTEN buys reconnect logic and a
trigger migration to replace one indexed select. Fails **open** — a DB blip must not evict the
fleet. Four mutants red.

**3. `00f40f9` — Redis, both halves of B12's "recorded, not fixed".** The cache store's outage
boolean was cleared by the next success: right for up-or-down, wrong for the flapping `Stream isn't
writeable` B12 measured, where every failure follows one. Mutant: **10 warns for 10 failed
requests**; now one a minute. `maxmemory` deliberately NOT set — every key expires (B12: zero
without a TTL), and `allkeys-lru` would turn the first non-expiring key from visible growth into a
silent eviction. One boot `CONFIG GET`, one worker, one warning, new runbook section.

**4. `33cdec2` — cross-chunk emails; the brief's diagnosis was wrong.** Probed first: the server
**already** refuses a repeated address across chunks with a legible 422 and creates nothing
(`takenIdentities` reads `users`, where chunk one's accounts are). The real defect is the
**preview** — it creates nothing, so a whole-roster preview reads clean and the import then strands
half a class. Fixed where the file is split: `crossChunkDuplicate` scans both identity columns now.
Redis set / `rate_events` claim ledger / cap-exempt dryRun refused with reasons in D61 — the ledger
would break D61's own fix-a-row-and-preview-again flow.

**5. `3f071e9` — `POST /submissions` metered (D79 → D80).** 1/10 s (the double-clicked button) and
20/10 min (B12: 35.3 verdicts/min from one judge, so 2/min/person leaves 18 submitting
continuously). No admin exemption — a container costs the same whoever enqueued it. Keyed on the
USER, never the IP: a computer room is one address. `retryAfterSeconds` + `record`, never `allow`,
or a refused double-click extends its own cooldown forever. **The trap:** `record` sweeps rows older
than the window it is handed, so the burst window would erase the sustained count — mutant finds 1
row where 20 belong. Contract + SDK, web cooldown countdown (vi/en), `oj submit` prints the wait.

**6. `47237a5` — CSRF second layer (D82).** One guard ahead of `AuthGuard`: a cookie-bearing
POST/PATCH/DELETE must name an origin on `wsAllowedOrigins` (D70's list, reused). Negative
safe-method list; cookie presence, not validity; `Referer` reduced to its origin; bearer skipped.
Mutant: a hostile origin renames the user (200) and logs them out (204).

**Rulings.** Task 4's premise was stale — evidence recorded in D61 instead of building what it asked for. `app.harness.ts` stamps `Origin` when a test names neither header: `request.agent` is a browser simulation and browsers always send it, so the suite's 400-odd cookie writes exercise D82's admit path every run while `csrf-origin.spec.ts` opts out to own the refuse path. Eight tests that submitted repeatedly as one person now say so with `clearSubmissionMeter(db)` rather than getting a bypassed limiter. No per-route churn: D82's 403 is cross-cutting like 401 and registered nowhere.

**Verification.** Per-package, sequential (B11 documents `-r test` flakes under contention): **api 911, web 447, judged 123, db 49, contracts 39, oj 28**, every other package green. `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts` green; contracts/SDK regen no diff; `vite build` OK. The live stack was never touched — every finding was reachable from tests, so no `bh13-*` account was needed.

**Concerns.** `E2E_BASE_URL` is now load-bearing: the three `e2e-*.ts` and one Playwright teardown send `Origin`, so a base URL outside `PUBLIC_ORIGIN` / `WS_EXTRA_ORIGINS` 403s every write (runbook says so). D80's numbers come from one judge's throughput, not observed contestants — the first real contest should confirm or move them. The meter costs two `rate_events` selects per submission, indexed but on the hot write path and unmeasured under load. D81's poll is per `judged` process, so a second one polls independently.
