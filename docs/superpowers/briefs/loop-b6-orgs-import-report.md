# B6 — bug hunt: orgs, notifications, problem authoring/import, `oj` (2026-08-29 loop)

Read every file in the area, then attacked the two things the reading suggested nobody
had: **races against reads taken outside the transaction that acts on them**, and
**inputs nobody cross-checked against anything**. Seven commits, each red-first and
re-mutated. One ruling, D53. No migration; 0022 not needed. Live stack probed
read-only (`GET /problems`, health) and never restarted.

## Fixed (repro → fix)

1. **`ed361b8` — an organization could be left with ZERO owners.** `removeMember` and
   `setMemberRole` read the target's role on one connection, then took
   `pg_advisory_xact_lock` on another — and `assertNotLastOwner` branches on that stale
   role, so a target read as `member` skips the check entirely. Promote that member to
   owner and remove the previous owner while the call waits at the lock (two ordinary
   requests) and the delete lands on the only owner with the guard never having run.
   `org-races.spec.ts` owns the window deterministically: a second connection takes the
   same advisory lock first, so the call under test is provably parked, then rewrites
   ownership with plain SQL before releasing. Red: **`expected 0 to be >= 1` owners**, on
   both paths. Fixed by re-reading the role inside the lock (`roleOf`, a free function so
   the wrong connection cannot be asked). The file's own comment calls this state "only a
   database edit repairs".
2. **`16f89f7` — one published clarification notified the room twice (D31).**
   `answer()` computed `firstAnswer`/`wasPublished` from a read taken *outside* its
   transaction, so two organisers publishing at once — or one double-submitted form —
   both saw an unanswered private row, both called it the transition, both broadcast.
   Red: `expected [ {id:4}, {id:6} ] to have a length of 1`. Now `SELECT … FOR UPDATE`
   inside the transaction, the shape `decideRequest` already used. D31 names this exact
   outcome as unrecoverable once it has happened.
3. **`c1ad032` — a 6 KB upload could take the API process down (D53).**
   `zstdDecompressSync` was uncapped in both readers; measured, 200 MB of zeroes compress
   to **6,419 bytes**, so `PACKAGE_UPLOAD_MAX_BYTES` (256 MiB) bounded what arrives and
   nothing about what is allocated from it. `readArchiveEntry` is on the same path from
   `attachRevision`, so a stored package could do it too. `MAX_UNPACKED_BYTES` = 1 GiB via
   `maxOutputLength`, which refuses *before* allocating; `PackagesService.upload` already
   turns that into `422 package_archive_invalid`. The cap is a parameter with that
   default, so the test proves the bound with a 64 KB archive.
4. **`19c490b` — a manifest could name files the package does not contain.**
   `attachRevision` had the manifest and the real `package_files` list in hand (it uses
   both for the collision check) and never compared them; `buildPackage` compared only
   `manifest.tests` and **never `checker.path` at all** — while every Polygon import plans
   a source checker. Red: the incomplete package attached as `{ version: 1 }`. Now one
   shared rule, `findMissingPackageFiles` in `@duckoj/package-format` beside
   `findPathCollision`, used by both. A package that cannot grade is refused with a
   message the setter can act on instead of an IE on a judge.
5. **`20edb18` — `oj submit` took a flag's value as the problem code.**
   `rest.filter((a) => !a.startsWith('--'))` drops flag NAMES and keeps their VALUES:
   `oj submit --language py3 abc sol.py` submitted problem `py3` from a file `abc`. The
   bug survived because `main.ts` reads `process.argv` at import, so no test could reach
   it — extracted to `apps/oj/src/args.ts` (a real parser, `--flag=value` too) and pinned.
6. **`7666dbe` — one dropped packet ended a watch.** Every failed poll went straight to
   `io.fail`, so `oj submit --watch` abandoned a submission that was grading fine and
   blamed the submission while doing it; an expired token said "could not read submission
   #7". Now five consecutive transient failures are tolerated, and 401/403 and 404 are
   final answers with their own words.
7. **`16e5325` — the importer's likeliest real failure was its only crash.** A file
   `problem.xml` names but the export lacks (truncated download, wrong
   `answer-path-pattern`) raised a bare `ENOENT`, which `scripts/polygon-import.ts` does
   not catch — unhandled rejection and a `node:fs` stack trace instead of the documented
   `refused: …` / exit 2. Now a `PolygonImportError` naming the path and the plan.

## Cleared, with evidence

- **Round-tripped `content/problems/day-con-tang`** through `polygon:import` → manifest →
  `renderInitYml`: 12 tests, 100 points, groups 0/40/60, batches correct.
- **Zip-slip, symlinks, non-regular entries, path collisions, hash mismatch** are all
  covered and correct (`packages.service.ts` deliberately re-walks rather than reusing
  `packDirectory`, which skips what it cannot classify). **Org visibility** (404 never
  403), **join idempotency**, **notification per-user isolation** and the **10 000-recipient
  single-INSERT fan-out** all hold. **`bootstrap-admin`** reads clean — idempotent,
  case-insensitive lookup, never resets a password.

## Rulings and concerns

- **D53** is the only new ruling: 1 GiB unpacked, refused before allocating. Nothing else
  here was a product decision.
- **`POST /packages` still accepts an incomplete manifest** — it is only refused at attach.
  Defensible (the package is content-addressed storage) but it means a package can be
  stored that can never be used. One line to add if wanted.
- **`listMembers`/`rosterOf` return the whole roster unpaginated** — feature-shaped, not a
  bug, but a 10 000-member org is one very large response.
- **`broadcast`'s `.limit(NOTIFY_CAP)` has no `ORDER BY`**, so which 10 000 of a larger room
  hear an announcement is unspecified, and the truncation is silent.
- **Org-restricted contests do not exist** (still on the backlog), so there was no such
  visibility rule to test.
