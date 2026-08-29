# F3 — ops fixes (M4–M8, M10 + the ops minors): report

**Status: DONE_WITH_CONCERNS.** In `scripts/{backup,restore}.sh`, `scripts/test/`, `deploy/*`, `docs/{runbook,DECISIONS}.md`.

## Shipped
- **M4** `restore.sh` resolves one project name (`COMPOSE_PROJECT_NAME`, else the
  deprecated `COMPOSE_PROJECT`, else `basename $PWD` as `compose-up.sh` derives it) and
  **exports** it, so the label lookup and every `podman-compose` call address the same
  stack. Refuses up front when the *resolved* postgres container is not running
  (`podman inspect {{.State.Running}}`, so it holds for a hand-passed `PG_CONTAINER`).
- **M5** `trap on_exit EXIT` — any failure after the writers were stopped restarts them,
  loudly, still exiting non-zero. **M6** `pg_restore` output captured; abort on non-zero
  **or** any error line outside the benign `already exists` class; prints the log and
  **disarms the restart**, so the writers stay stopped.
- **M7** `timeout ${MIGRATE_TIMEOUT}s podman-compose up --no-deps --force-recreate migrate`
  + the container-exit-code check, after the reload and before the writers restart; a
  failing migrate also leaves them stopped.
- **M8** `backup.sh`: `umask 077` first, `chmod 700 $DEST`, `chmod 600` per artefact, and
  every pre-existing `duckoj-*` in the destination tightened on each run.
- **M10** runbook **"Boot and reboot"**: both units' install lines, linger and why it is
  load-bearing, `SKIP_BUILD=1` and its "never picks up a code change → redeploy is
  `scripts/compose-up.sh` by hand" consequence, status/journal (why `active (exited)` is
  correct), `list-timers`, `journalctl -u duckoj-backup`, force-a-run. Backups/Restoring
  rewritten; "Nightly, unattended" now points here.
- **Minors:** m8 (`network-online.target` → `podman-user-wait-network-online.service`;
  former confirmed absent, latter present in the user manager), m9 (`Wants=` dropped,
  `After=` kept), m10 (`KEEP` validated up front), m11 (abandoned `*.partial` swept), m14
  ("watch the first real restore" caveat); m15 left as the known D17 cost.

## Proof — `scripts/test/restore.test.sh` (plain sh; no bats on this host)
Throwaway `postgres:16-alpine`, throwaway project `duckoj-f3test-$$`, stub `$COMPOSE`
logging its args and creating a real labelled exited-0 migrate container. **43 ok / 0
not ok — `PASS`.** Live stack untouched (same six `duckoj_*`), zero `f3test` leftovers.
```
dir=700 dump=600 pre-existing=600
compose call order: stop up start
FATAL: pg_restore failed (exit 1). pg_restore: error: could not read from input file
!!! RESTORE FAILED (exit 1). api judged ARE DELIBERATELY LEFT STOPPED.
!!! Restarting them now so the site does not stay down.      (bad-tar case)
```
**Red→green:** the harness against the pre-fix scripts → **31 of 43 failed**.
**Mutations:** dropping only `umask`/`chmod` → exactly the 3 M8 cases red (`dir=755
dump=664 pre-existing=644`); flipping M6's `RESTART_ON_EXIT=0` to 1 → exactly the 2 M6
cases red. **Gate:** `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`,
`-r test` (api 546/546), regen **no diff**, `vite build` — all 0.

## Rulings (D26 records them)
1. `final-review.md` post-dated my branch point: read from main, then ff'd (0 ahead).
2. **M5 vs M6** split by "can the running code be trusted against this DB":
   pg_restore/migrate failure → stay stopped; anything later → trap restarts.
3. `SERVICES=""` skips **all** compose calls, migrate included; `COMPOSE_PROJECT` kept as
   a read-only alias so the old documented invocation is correct, not catastrophic.
4. `scripts/test/` is outside the literal allowlist but authorised by dispatch; D26 is
   next free (main ends at D25) — collision risk if a sibling claims it too.

## Concerns
- **The live stop/start path is still unexercised** — proven only against a stub compose binary. Said so in the runbook.
- `scripts/e2e-{contest,problem}.ts` still read `COMPOSE_PROJECT`: out of allowlist and
  read-only, left alone. m8's unit swap is documented-correct but not reboot-tested, and
  shellcheck is absent, so `# shellcheck disable` comments are inherited, not verified.
