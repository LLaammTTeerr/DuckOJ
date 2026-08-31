# B-32 — disaster-recovery drill: the production backup did not restore

**Status: DONE_WITH_CONCERNS.** Drilled on a throwaway project (`b32drill`, current images, own
volumes), removed afterwards. Live `duckoj` read from, never written to.

## Headline — the newest nightly backup would not have restored onto the running stack
Not a corrupt dump, not a data collision; it reproduces on an empty, freshly migrated database.
`pg_restore --clean` emits `DROP TABLE IF EXISTS` with no `CASCADE`. The target is at today's schema
and the dump is older, so tables the dump has never heard of (`contest_seats`, `problem_comments` —
0038/0039, applied after 03:01) hold FKs onto `users`/`problems`/`contests`/`contest_participations`.
Those four drops failed and the reload collapsed on the survivors: `cannot drop table public.users
because other objects depend on it … constraint contest_seats_user_id_users_id_fk`, then `multiple
primary keys for table "users" are not allowed`; `errors ignored on restore: 32`, exit 1, writers down.
**Fixed (D130):** `restore.sh` drops `public`+`drizzle` and recreates `public` before the reload — a
restore means "this database becomes that backup", and the `migrate` step already there puts today's
schema back on top. Same dump after the fix: **0 error lines, exit 0, 15 s**, API serving 228 real
users / 18 problems / 376 submissions. That reset is destructive *before* pg_restore reads the file,
so a second fix rides along: `pg_restore -l` reads the TOC first, touching no database — drilled
with a 10 kB truncation: exit 1, **every row still in place**, writers stopped.

## The drill
`b32drill` up from current images (postgres/redis/migrate/api/judged, no caddy), seeded and given
bytes in the package volume; `backup.sh` → dump + tar, `700` dir / `600` files (D17/M8), TOC
readable. Disaster: `DROP DATABASE duckoj` + volume emptied, writers left running — then `restore.sh`
full path (stop → reset → reload → migrate → import → start): row fingerprint identical, 35/35
migrations, package bytes back, `/api/v1/languages` 200. Fault injection against real containers, not
stubs: truncated dump → exit 1, writers **stopped**, data intact; truncated tar → exit 125, trap
**restarted** them — D30 both ways. Then `duckoj-20260831-030126` → the headline.

**RTO/RPO measured:** backup (production nightly, its own journal) **<1 s** · `restore.sh` onto a
running stack **12 s** · + route answering 200 **15 s total** · drill downtime disaster→healthy
**34 s** · **RPO one night** — the 03:01 dump held 228/333 users, 376/714 submissions 12 h later.

## Second finding — live is missing a migration, permanently (D131)
Live has **34** applied migrations; the same image on a fresh database applies **35**. Missing:
`0025_dashboard_bounds` — four indexes, confirmed absent from `pg_indexes` on live. **Drizzle will
never apply it**: it runs only entries stamped newer than the newest already applied, and 0025 is
older than what live has — so `migrate exited 0` nightly, forever, over a gap nothing reports. Cost is
bounded (dashboard query speed, no wrong answers) but two schema populations now exist: fresh installs
have the indexes, live and anything restored from its backups do not. **Not fixed** — the remedy is
one idempotent `CREATE INDEX IF NOT EXISTS` migration and this loop was given no migration number.

## Tests
`scripts/test/restore.test.sh` — **49 ok / 0 not ok, PASS**. New case: a dump restored onto a *newer*
schema (`seat`, `contest_seats` in miniature). **Red→green:** the pre-fix script reds **12** — the 2
new ones directly plus 10 downstream, because once the drift exists every later restore in the
harness fails the same way. **Mutation:** dropping only the TOC pre-flight reds exactly "the good row
survived the aborted restore". `compose-up.test.sh`, `deploy.test.sh` green. No TS touched, so the
pnpm gate was not run (no `node_modules` here); the shell suites are the ritual.

## Rulings and concerns
- TOC failure sits on D30's *stopped* side, like a failed reload. Moving it ahead of the `stop` (so a
  corrupt dump costs no downtime) is a real improvement, **not taken**: it would rewrite D30's list.
- `compose-up.sh` uses `PROJECT=$(basename "$PWD")` and ignores `COMPOSE_PROJECT_NAME`, unlike
  backup/restore/deploy, so it cannot bring up a differently-named project (the drill sequenced
  compose by hand). Documented-correct, out of fix scope, **not fixed**.
- **A restore against the live stack is still unexercised**, and it now empties the schemas first:
  an aborted attempt is not a no-op unless it aborted at the TOC read.
- The drill DB held a real production dump — every `users` row. All `b32drill` containers, volumes
  and image tags removed, verified gone.
