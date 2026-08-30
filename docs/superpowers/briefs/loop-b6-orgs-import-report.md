# B6 — bug hunt: orgs, notifications, problem authoring/import, `oj` (2026-08-29 loop)

Read every file in the area, then attacked what the reading suggested nobody had: **races
against reads taken outside the transaction that acts on them**, and **inputs nobody
cross-checked against anything**. Seven commits, each red-first and re-mutated. D53 is the one
ruling; no migration, 0022 unused. Live stack probed read-only, never restarted. Ritual green:
typecheck, lint, **1379 tests**, contracts/SDK regen no-diff, `vite build`.

## Fixed (repro → fix)

1. **`ed361b8` — an organization could be left with ZERO owners.** `removeMember` and
   `setMemberRole` read the target's role on one connection, then took
   `pg_advisory_xact_lock` on another — and `assertNotLastOwner` branches on that stale role,
   so a target read as `member` skips the check entirely. Promote that member to owner and
   remove the previous owner while the call waits at the lock (two ordinary requests): the
   delete lands on the only owner, guard never run. Red on both paths, **`expected 0 to be
   >= 1` owners** — the test takes the same lock first, so the call is provably parked rather
   than racing on luck. Now the role is re-read inside the lock.
2. **`16f89f7` — one published clarification notified the room twice (D31).** `answer()`
   computed `firstAnswer`/`wasPublished` from a read taken *outside* its transaction, so two
   organisers publishing at once (or one double-submitted form) both saw an unanswered private
   row, both called it the transition, both broadcast. Red: `expected [ {id:4}, {id:6} ] to
   have a length of 1`. Now `SELECT … FOR UPDATE` inside it — `decideRequest`'s shape.
3. **`c1ad032` — a 6 KB upload could take the API process down (D53).** `zstdDecompressSync`
   was uncapped in both readers; measured, 200 MB of zeroes compress to **6,419 bytes**, so
   `PACKAGE_UPLOAD_MAX_BYTES` (256 MiB) bounded what arrives and nothing about what is
   allocated from it — and `readArchiveEntry` runs the same path from `attachRevision`. Now
   `MAX_UNPACKED_BYTES` = 1 GiB via `maxOutputLength`, refusing *before* allocating.
4. **`19c490b` — a manifest could name files the package does not contain.** `attachRevision`
   had the manifest and the real `package_files` list in hand (it uses both for the collision
   check) and never compared them; `buildPackage` compared only `manifest.tests` and **never
   `checker.path` at all** — while every Polygon import plans a source checker. Red: the
   incomplete package attached as `{ version: 1 }`. One shared `findMissingPackageFiles` now.
5. **`20edb18` — `oj submit` took a flag's value as the problem code.**
   `rest.filter((a) => !a.startsWith('--'))` drops flag NAMES and keeps their VALUES:
   `oj submit --language py3 abc sol.py` submitted problem `py3` from a file `abc`. It survived
   because `main.ts` reads `process.argv` at import — extracted to `apps/oj/src/args.ts`.
6. **`7666dbe` — one dropped packet ended a watch.** Every failed poll went straight to
   `io.fail`, so `--watch` abandoned a submission that was grading fine, and an expired token
   said "could not read submission #7". Five consecutive failures are tolerated now; 401/403
   and 404 are final answers with their own words.
7. **`16e5325` — the importer's likeliest real failure was its only crash.** A file
   `problem.xml` names but the export lacks raised a bare `ENOENT`, which
   `scripts/polygon-import.ts` does not catch — an unhandled rejection and a `node:fs` stack
   trace instead of the documented `refused: …` / exit 2.

## Cleared, with evidence

`content/problems/day-con-tang` round-trips (12 tests, 100 points, groups 0/40/60). Zip-slip,
symlinks, non-regular entries, path collisions, hash mismatch, org visibility (404 never 403),
join idempotency, notification isolation, the fan-out and `bootstrap-admin` all hold.

## Rulings and concerns

- **`POST /packages` still accepts an incomplete manifest** — refused only at attach, so a
  package can be stored that can never be used. One line to add if wanted.
- **`parseArgs` now rejects unknown `--flags` on every `oj` command**, where the old code
  ignored them outside `submit`: deliberate, but a behaviour change beyond the bug.
- **`listMembers`/`rosterOf` are unpaginated**; **`broadcast`'s `.limit(NOTIFY_CAP)` has no
  `ORDER BY`**; **org-restricted contests do not exist** (backlog), so there was none to test.
