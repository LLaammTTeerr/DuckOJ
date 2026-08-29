# Task P3 — province-scale ops: backup/restore, judged concurrency, load smoke

Read `docs/superpowers/briefs/conventions.md` first. Touch only:
`scripts/backup.sh`, `scripts/restore.sh`, `deploy/**`, `docker-compose.yml`,
`apps/judged/**` (concurrency knob only), `load/**`, `docs/runbook.md`,
`docs/DECISIONS.md`. Container runtime is podman/podman-compose. You are in
a git worktree: do NOT start/stop the live compose stack (it is serving
users); test backup/restore against a throwaway `podman run postgres:16-alpine`
container you create and remove yourself.

## 1. Backup + restore
- `scripts/backup.sh [dest-dir]` — `pg_dump -Fc` of the compose postgres
  (via `podman exec` on the container labelled service=postgres, see
  `scripts/compose-up.sh`'s `container_for_service`) plus a tar of the
  `package_store` named volume (`podman volume export` or `podman run --rm -v`),
  timestamped, keeps the last 14 by default (`KEEP=` env). Prints sizes.
- `scripts/restore.sh <backup-prefix>` — refuses to run unless `CONFIRM=yes`;
  restores both into the running stack (stop api/judged first, restore,
  start them). Must be idempotent and print what it did.
- `deploy/duckoj-backup.service` + `deploy/duckoj-backup.timer` (systemd
  user units, nightly 03:00 Asia/Ho_Chi_Minh, `__REPO__` placeholder like
  `deploy/duckoj.service`), and install instructions in the runbook
  under a new "Backups" section. D17 in DECISIONS.md: retention 14 days
  local; off-host copy is the province IT's responsibility (state it).
- Prove it: create a throwaway postgres, load a tiny schema+row, run the
  dump path of backup.sh against it (parametrise the container name via env
  `PG_CONTAINER`), drop the row, restore, show the row is back. Put the
  transcript in your report.

## 2. Judged concurrency
- Find how many jobs `apps/judged` grades at once (`worker.ts` / claim loop).
  If it is one-at-a-time, add `JUDGED_CONCURRENCY` (default 2) running that
  many independent claim loops; each loop keeps the existing lease/fencing
  semantics. If it already exists, document it. Add to `docker-compose.yml`
  as `JUDGED_CONCURRENCY: ${JUDGED_CONCURRENCY:-2}` and to `.env.example`
  if one exists. Unit-test that N loops claim N distinct jobs.
- Note in the runbook that `judge` (the DMOJ sandbox) is the real ceiling and
  how to add a second `judge` container (a `judge-2` service copy with its
  own `JUDGE_TOKEN`? Check `packages/db` `judge_nodes` and
  `scripts/seed-problem.ts` for how nodes are registered and document the
  exact steps; do not build a second judge).

## 3. Load smoke (k6 is installed at ~/.local/bin/k6)
- `load/k6-contest-day.js`: ramps to 2000 VUs over 2 min, holds 3 min;
  mix: 70% GET /api/v1/problems + GET /api/v1/problems/{code} (public), 20%
  GET /api/v1/contests/{key}/scoreboard, 10% GET /api/v1/submissions.
  Parametrised by `BASE_URL`, `CONTEST_KEY`, `PROBLEM_CODE`. Thresholds:
  p95 < 800ms, error rate < 1%.
- `load/README.md` explaining how to run against the live stack and how to
  read the result. Do NOT run it against the live stack yourself; run a
  10-VU 20s sanity pass against `http://localhost:8080` only to prove the
  script parses and the endpoints answer 200, and paste the summary.

## Done means
Scripts executable, units present, judged tests green (`corepack pnpm --filter @duckoj/judged test`,
typecheck, lint), runbook updated, committed on your worktree branch.
Report to `docs/superpowers/briefs/p3-ops-report.md`.
