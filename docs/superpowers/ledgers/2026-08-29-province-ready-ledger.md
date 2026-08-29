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
