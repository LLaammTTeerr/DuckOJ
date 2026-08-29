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
