# F-36 — 0041 repairs the migration production never applied (D131 → D133)

**Status: DONE.** Migration 0041, plus a guard that lives where the defect does.

## What shipped
- `packages/db/migrations/0041_dashboard_bounds_repair.sql` — 0025's four indexes, verbatim
  (partial predicates, `DESC NULLS LAST`) with `IF NOT EXISTS`, plus an idempotent
  back-stamp of 0025's `(hash, created_at)` row into `drizzle.__drizzle_migrations`
  (guarded by `WHERE NOT EXISTS … created_at = 1788078255700`). Journal idx 41, `when`
  1788165000000 — strictly newer than every entry; `merge-decisions.py --journal` reports
  "36 entries, monotonic" and rewrote nothing. `0041_snapshot.json` is 0040's, re-chained.
- `packages/db/src/migrate.ts` — after `migrate()`, every journal `when` must appear in
  the ledger or `runMigrations` throws `MigrationDriftError` naming the tags. Directional
  (extra ledger rows are fine — a restored backup, a re-chained `when`);
  `DUCKOJ_ALLOW_MIGRATION_DRIFT=1` downgrades it to a warning. Also drops the
  "already exists, skipping" NOTICEs idempotent DDL raises (six per run otherwise).
- `packages/db/test/migration-journal.spec.ts` — the production shape, reproduced; D133.

## The finding that shaped it
**The guard the brief asked for already existed and passed the whole time.** That spec
has asserted strict `when` monotonicity, journal↔`.sql`↔snapshot bijection, an intact
snapshot chain and a fresh database applying every entry since F-4 — while production was
missing 0025, and it had to pass: the tree was never wrong. 0025 was authored early, merged
late, deployed never. **No property of the repository can distinguish that state**; only a
given database's ledger can — so the check went into `runMigrations`. The back-stamp is what
makes it survivable: without it production's ledger stays one row short forever and the
check would fail every future deploy.

## Proof, on throwaway Postgres (podman, `--no-file-parallelism`)
- **(a) fresh** — all 36 apply, ledger count 36, the four indexes present.
- **(b) production simulated** — the real migrations folder copied minus 0025 and 0041,
  applied by *drizzle's own migrator*: 34 rows, newest stamp 0040's, zero indexes, and
  0025's stamp provably older than the newest applied. Then `runMigrations`: four indexes
  created, 0025 back-stamped, count 36.
- **(c) re-run** — stamps and indexes identical, a no-op. Deleting 0025's ledger row then
  makes the next run throw rather than exit 0 — the guard, on a healthy database.
- **Red→green** — removing 0041's journal entry reds (b) with `MigrationDriftError: …
  0025_dashboard_bounds (when=1788078255700)`, the live defect exactly; removing only the
  back-stamp reds it too. Both restored, green. Suites: db 62, api 1147 (serial), judged
  130, web 604 — one `logout.spec.tsx` load-flake, green isolated, no database involved.

## For the operator
`scripts/deploy.sh api` **is sufficient**: `packages/db/migrations` changed, so the migrate
step runs, 0041 creates the four indexes and heals the ledger to 36, and the new check
verifies it in the same run. New failure mode, deliberately: drift now exits non-zero and
`deploy.sh` recreates nothing — `DUCKOJ_ALLOW_MIGRATION_DRIFT=1` is the way past it.

## Concerns
- The check's first live run is safe because B-32 compared the ledgers: every entry but
  0025 matches live by timestamp (D131). 0028/0029/0035 carry `merge-decisions.py`'s
  `+1000` re-chain signature, so that rewrite predates their deploy — without the drill's
  comparison this check could have blocked the very deploy that ships it.
- **New sharp edge:** if a future merge conflict makes `merge-decisions.py --journal`
  re-chain the `when` of a migration production already applied, that new stamp is absent
  from the ledger and the deploy dies — correct in principle (journal and ledger really do
  disagree), but a merge unrelated to schema can now stop a deploy. Remedy: hand-reconcile
  the ledger row, or `DUCKOJ_ALLOW_MIGRATION_DRIFT=1`.
- `apps/api` must run `--no-file-parallelism`; under full-parallel load it times out.
