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
