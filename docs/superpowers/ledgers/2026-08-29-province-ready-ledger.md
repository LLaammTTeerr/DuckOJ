# Province-ready ledger — spec: docs/superpowers/specs/2026-08-29-province-ready.md

## Phase 0 — availability
- Found every container `Exited` since 2026-08-25 (host reboot; podman has no
  daemon so `restart:` policies never fire). Brought up via runbook order.
- Ruling: reboot-proofing = systemd USER unit (`deploy/duckoj.service`,
  wraps `scripts/compose-up.sh` with new `SKIP_BUILD=1`) + `loginctl
  enable-linger`. Installed, enabled, started: active (exited) 0/SUCCESS, all
  six containers healthy, tailscale URL 200. Cost if wrong: unit fails at
  boot → same outage as before, no worse.
- Phase 0: complete.

## Dispatch log
- 14:40 P1-A (main, opus): rejudge, disqualify, contest edit, login limit.
- 14:41 P1-B (worktree, opus): TOTP UI, formatPoints.
- 14:52 P3 (worktree, opus): backup/restore, judged concurrency, k6 script. k6 v2.2.0 installed to ~/.local/bin (directive authorises tooling).
- 14:53 P4 (worktree, opus): bootstrap-admin script, five Vietnamese demo problems.
- Queued: P1-C freeze (main, after P1-A), P2 i18n (worktree, after P1-B merge), P5 e2e + review.
- Ruling: parallel agents only in worktrees and only for DB-free work; DB-test tasks run on main one at a time (shared test Postgres would cross-contaminate).
- 15:12 P1-B DONE_WITH_CONCERNS on `worktree-agent-a35dec3c52fa8290b` (6ae754c): /account/security + formatPoints; QR encoder vendored (Nayuki, MIT, decode-verified 4/4). Ruling: keep vendored copy (no lockfile churn; verified). Merge into main after P1-A finishes.
- 15:13 P2 i18n dispatched (worktree, opus) on top of P1-B's branch.
- Host process restarted; all four agents killed. State found: P1-A rejudge committed (9eaa670), disqualify uncommitted; P4 two commits; P3 14 dirty files; P2 only the merge. All four resumed via their transcripts (not re-dispatched).
- P3 DONE_WITH_CONCERNS on `worktree-agent-a4d3c6ce2ceb84430` (c6361a1..100efce): backup/restore proven on throwaway pg; JUDGED_CONCURRENCY pool; k6 script (10-VU sanity p95 15ms). Concerns carried: restore's stop/start path unexercised; 2k-VU run still owed (Phase 5); D-number collisions (P3 D17, P4 D16/D17, P1-A D16) → renumber at merge.
- P4 DONE on `worktree-agent-a33ac2f450a6db5eb` (262f016, 4a5b989, 3d72a87): bootstrap:admin (+ password.hash.ts extraction), five Polygon-layout Vietnamese demo problems (small committed tests; generators expose LARGE_N). Ruling: accept small committed tests — the sandbox proves the pipeline, not solution speed.
- P2 DONE on `worktree-agent-a2605d0dc2213f4ad` (f5057e0, 8d94d10; includes P1-B): vi default / en toggle, 154 web tests green, English literals in JSX 34→0. IBM Plex Mono already has the vietnamese subset (D18).
- P1-A DONE_WITH_CONCERNS (9eaa670..5cd51a8): rejudge, disqualify, contest edit, login limit; 925 tests, 51/51 mutants.
- Merged P2(+P1-B), P3, P4 onto main; conflicts in contests.tsx/submission.tsx (keyed P1-A strings), DECISIONS renumbered D16 login, D17 backups, D18 i18n, D19 bootstrap, D20 demo content.
- Ruling D21: rejudge does NOT replayAll (would fold zeroed scores); returns `ratedContestKeys`. Web hint for it still owed (todo for P1-C/P5).
- Dispatched sonnet localizer for contest-edit.tsx / problem-edit rejudge block + 10 failing web tests (apps/web only).
- Localizer DONE (8c3d388): 170 web tests. Redeployed: web built, judged rebuilt (pool=2), api image build failed (test tree imports apps/judged) → Dockerfile typechecks src only; api rebuilt, rejudge route live.
- Pushed main for CI. Dispatched P1-C freeze (main, opus, D22) and live seeding agent (sonnet: duckadmin, five problems, hocsinh1 AC/WA, contest thu-nghiem-1).
- Seeding DONE (a856822): live has duckadmin (via register+SQL fallback — migrate image predates bootstrap-admin; rebuild migrate at next deploy), five public problems (12 tests each), hocsinh1 with 5×AC + 1×WA (ids 31–36), contest thu-nghiem-1 (icpc, 30 days). Secrets in .secrets/ (gitignored).
- CI on ef4c6fd (merged main): success.
- P1-C DONE_WITH_CONCERNS (cb06591..c355fdb): freeze window (D22), D21 web hint; 1046 tests, 29/29 mutants. Concern carried: freeze applies only at the scoreboard (`/contests/{key}/me`, `/submissions` still show late verdicts) — noted as a follow-up.
- Redeployed api/migrate/judged + web from c355fdb; scoreboard live. Pushed; CI polling. Dispatched P5 (opus) Playwright journeys against the live stack.
- Dispatched P1-D (worktree, opus, D23): freeze masking on /submissions, /contests/{key}/me, WebSocket — closes P1-C's concern.
- CI on c355fdb: success.
- P1-D DONE_WITH_CONCERNS on `worktree-agent-a134c0e2fe369bf19` (a5c86bd, 6a1f1e5): submission.freeze.ts one predicate two forms, masking not filtering, D23. Merge after P5. Carried: solved-count and source_access='solved' leaks during freeze (named in D23).
- P5 DONE_WITH_CONCERNS (34ab990..73e99c3): 6/6 journeys + 9 smoke green on live; fixed: no sign-out control, sign-out 401 stray request, visitor contest-page 401, phone table overflow, e2e locale. Concerns → P6.
- Merged P1-D; full ritual green; api rebuilt/recreated; pushed 65e27a3; CI polling. k6 2000-VU run started against live (5 min).
- Dispatched P6 (worktree, opus): registration page, submission→contest link, journey-1 via the page.
- k6 2000 VU / 5m30s on live: 319,727 reqs, ~970 req/s, 0.00% errors, p95 3.46 s (threshold 800 ms crossed). Single Node process on 16 cores → dispatched P7 (main, opus): measure, API_WORKERS cluster mode (or index if PG-bound), redeploy, rerun, load/RESULTS.md.
- CI on 65e27a3: success.
- P6 DONE_WITH_CONCERNS, merged (77b777b): /register page, contestKey/contestLabel on submissions (D24, renumbered). journey.spec kept P5's version — register-page walk for journey 1 owed to the final e2e pass. Web rebuilt (register page live); api redeploy waits for P7.
- P7 DONE_WITH_CONCERNS (54186e9..d369236): API_WORKERS cluster (default 4; 8 needs max_connections), per-route k6 tags, load/RESULTS.md. 2000 VU: 969→1715 req/s, p95 3.46→2.28 s, 0% errors. Next ceiling: scoreboard fold in JS per request → P8. Pushed d369236067830cafd28e228f5159a64bd8657866.
- Dispatched P8 (worktree, opus, D25): Redis scoreboard cache TTL 2 s + coalescing + invalidation. Dispatched P9 (main, opus): final e2e — register walk, contest link, freeze masking journeys.
- CI on d369236: success.
- P9 DONE_WITH_CONCERNS (77c9ef9): 8/8 journeys, 17/17 with smoke; no product bugs. Concern: source_access has no UI → dispatched P10 (main, sonnet, web-only).
- P10 DONE (3d39b51): sourceAccess select on problem edit; web rebuilt.
- P8 DONE_WITH_CONCERNS, merged (e609b08): Redis scoreboard cache TTL 2 s, D25; api tests 567 green; api rebuilt, header hit/miss verified live. k6 rerun started.
- k6 rerun with cache: 2391 req/s, p95 1.20 s (list 643 ms ✓, detail 1.22 s, scoreboard 1.89 s), 0 failed. Recorded in load/RESULTS.md. Ruling: threshold is a stress target; contest-day load (~400 req/s) is far inside.
- CI on 5d4e80b: success.
- Final review (final-review.md): B1 contest-edit cascade-wipes contest_submissions; B2 judged cancel broadcasts terminate with concurrency 2; B3 backup timer never installed; M1–M11. Cleared with evidence: route markers, cluster state, cache view separation, freeze masks, rejudge fence, XFF (Caddy strips untrusted).
- B3 fixed now: timer installed, first backup ran (dump 127 KB + store 386 KB), modes tightened to 700/600.
- Dispatched F1 (main, opus): B1, M1, M2 (D26), M3 (D27), M9, M11. F2 (worktree, opus): B2 targeted cancel + back-pressure (D28). F3 (worktree, opus): M4–M8, M10.
- Session limit (7pm reset) killed F1/F2/F3 mid-flight; all three resumed from transcripts.
- F3 DONE_WITH_CONCERNS on `worktree-agent-af048a93012b8300f` (a935753): restore.sh M4–M7, backup modes M8, runbook boot section M10, 43-case sh test. Its D26 → renumber D29 at merge (F1 owns D26/D27, F2 D28). Merge after F1 frees main.
