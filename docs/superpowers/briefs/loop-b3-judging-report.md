# B3 — bug hunt: judging pipeline (2026-08-29 feature/bug loop)

Read submit → `grading_jobs` → claim/lease/retry → the DMOJ bridge → `event-writer`
→ verdict display against the `judge-server` reference, and probed the live stack
with a throwaway `bh3-*` account. Seven findings, all fixed, a commit each; D40
used; every test red first, four mutants run. Ritual green: 1259 tests, regen with
no diff, `vite build`.

## Fixed (repro → fix)

1. **`98b10af` D40 — every checker-based problem was ungradeable, and always had
   been.** `renderInitYml` wrote a `kind: 'source'` checker as a bare path and never
   read the manifest's `language`. `Problem.checker()` (`dmoj/problem.py:495-515`)
   reads any dotted name as a **Python module path** and `exec(compile(...))`s it —
   proven on the reference: `load_module_from_file` on a `check.cpp` raises
   `SyntaxError`, caught by neither the `except IOError` nor the `except
   AttributeError` around it. Re-resolved both forms through judge-server's own
   `ConfigNode` branch: only `bridged` + `args {files, lang, type: testlib}` runs.
   Every Polygon import plans a source checker (`parse.ts:177`) → only ever IE.
2. **`4f4f1c4` — `batch-end` was in the packet union and handled by nothing**, so
   `entry.batch` only counted up while judge-server yields loose cases outside any
   begin/end pair (`dmoj/judge.py:479-533`). Over the real wire `batch(20)` +
   `loose(5)` scored **5/20, not 25/25**. `batchCount` is separate from `batch`, so
   the naive one-counter fix (it merges batch 2 onto batch 1) dies by its own test.
3. **`ef297d6` — the compile log reached students raw:** gcc's colour escapes
   verbatim, addressed to the problem's 64-hex **package hash** (judged sends it as
   the `problem-id`; the judge names the compile unit `{problem_id}.{ext}`), which
   `submit.tsx` puts in a `<pre>`. Stripped, rewritten `solution.cpp`, CRLF
   normalised; warnings too.
4. **`8eee9c6` — a 1 MB submission answered `500 internal_error`.** The json parser
   rejects it before Nest and throws an `http-errors` error, not an `HttpException`,
   so `ProblemFilter` fell to its 500 branch — logged at ERROR, so an oversized
   paste read as a server fault while its own `413 payload_too_large` sat
   unreachable. Only 4xx **and** `expose: true` now, status alone.
5. **`558fc4f` — final review's m7 closed.** The `submission_cases` INSERT was
   check-then-act while every `submissions` UPDATE was fenced, so a stale insert
   after `requeueAll`'s delete re-created rows `max(attempt)` then picked — old
   verdicts beside a `queued` submission. Fence folded into the statement.
6. **`ff5d04f` — `NaN <= 0` is false.** `time-limit` used `Number.isInteger`,
   `memory-limit` did not: garbage walked past its only guard and left
   `memoryKb: NaN` → `null` on disk, failing two steps later at upload.
7. **`b022f72` — `oj watch` printed `CE` and stopped**, withholding the one field
   that explains a CE. It prints `compileOutput` on any terminal verdict now.

## Cleared, with evidence

- **Live matrix:** AC 100/100 · WA · TLE (3001 ms) · RTE · **OLE** · unicode AC ·
  empty 422 · 64 KB 201 / +1 422 · unknown language/problem 404 · unpublished 409.
  Short-circuited cases report `skipped`; groups worth 0/40/60 fold to exactly 100.
- **MLE is effectively unreachable here.** `verdict.ts` maps it right, but DMOJ
  limits address space, so an over-limit program dies first: `bad_alloc` → RTE at
  131 MB under 256 MB; a 400 MB BSS segfaults at 4 KB RSS. The UI advertises it.
- **Rejudge against a NEWER revision is correct:** `rejudgeProblem` takes the current
  *published* revision, `rejudgeSubmission` the pinned one, both moving
  `submissions.revision_id` **and** the job's `revision_id`/`package_hash` together.
  Live rejudge of #73: 202, same job row, fresh cases, AC, D21 honoured.

## Concerns

- **The live stack still runs all seven** until merge — checker/Polygon problems IE
  there, and oversized pastes log operator-facing 500s.
- **Judge disconnect mid-grade is slow, not wrong.** `bridge-server`'s
  `socket.on('close')` tells the driver nothing, so a crash pins the submission for
  `gradingCeilingMs` (300 s–30 min) before the lease-lapse regrade. A prompt fix
  needs a driver→worker abandonment channel (`dispatch` has already resolved);
  architectural, left with this pointer.
- `JobStore.reclaimExpired()` is called by nothing outside tests; `rejudgeProblem`
  requeues a problem's every submission in one unbounded transaction; `GET
  /packages/{hash}` answered 200 to a plain session despite its `packages:read`
  scope (summary only — handed to the auth area).
- `contest-scoreboard-cache`'s privileged-board test flaked once under full-suite
  load (2 s TTL, D25); passed alone and on re-run, untouched here. `bh3-61808` and
  ~12 submissions remain; nothing stopped or rebuilt; no migration (D41/D42 unused).
