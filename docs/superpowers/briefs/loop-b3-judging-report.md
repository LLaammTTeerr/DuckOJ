# B3 — bug hunt: judging pipeline (2026-08-29 feature/bug loop)

Read submission-create → `grading_jobs` → claim/lease/retry → the DMOJ bridge →
`event-writer` → verdict display end to end against the `judge-server` reference,
and probed the live stack with a throwaway `bh3-*` account (a full verdict matrix
on `tong-hai-so`, plus an admin rejudge). **Seven findings, all fixed, a commit
each; D40 used; every test shown red first, four explicit mutants run.** Ritual
green: 16 packages, 1259 tests, regen with no diff, `vite build`.

## Fixed (repro → fix)

1. **`98b10af` D40 — every checker-based problem was ungradeable, and always had
   been.** `renderInitYml` wrote a `kind: 'source'` checker as a bare path
   (`checker: checker/check.cpp`) and dropped the manifest's `language` on the
   floor. `Problem.checker()` (`dmoj/problem.py:495-515`) treats any name with a
   dot as a **Python module path** and `exec(compile(...))`s the file — proven
   against the reference: `load_module_from_file` on a `check.cpp` raises
   `SyntaxError: invalid syntax (check.cpp, line 2)`, caught by neither the
   `except IOError` nor the `except AttributeError` around it. `bridged` +
   `args: {files, lang, type: testlib}` is the only shape that runs; both forms
   were re-resolved through judge-server's own `ConfigNode` branch to prove it.
   **Every Polygon import plans a source checker** (`parse.ts:177`), so the whole
   import path led to problems that could only ever answer IE.
2. **`4f4f1c4` — `batch-end` was in the packet union and handled by nothing**, so
   `entry.batch` only counted up. judge-server brackets each batch and yields
   loose cases outside any pair (`dmoj/judge.py:479-533`). Over the real wire a
   `batch(20)` + `loose(5)` run scored **5/20 instead of 25/25** — the loose case
   was filed under the batch and min()/max()'d into it. `batchCount` is separate
   from `batch` so the naive one-counter fix (which merges batch 2 onto batch 1)
   is pinned dead by its own test.
3. **`ef297d6` — the compile log reached students raw.** Live CE:
   `'\x1b[01m\x1b[K9fad4a92…8499cpp.cpp:\x1b[m\x1b[K In function …'` — gcc's
   colour escapes verbatim, addressed to the problem's 64-hex **package hash**
   (judged sends it as DMOJ's `problem-id`; judge-server names the compile unit
   `{problem_id}.{ext}`). `submit.tsx` renders that into a `<pre>`. Now stripped,
   rewritten to `solution.cpp`, CRLF normalised — warnings too.
4. **`8eee9c6` — a 1 MB submission answered `500 internal_error`.** The json
   parser rejects it before Nest sees it and throws an `http-errors`
   `PayloadTooLargeError`, not an `HttpException`, so `ProblemFilter` fell to its
   500 branch — which also logs at ERROR, so every oversized paste read as a
   server fault. The `413 payload_too_large` entry in the filter's own tables had
   never been reachable. Narrow fix: 4xx **and** `expose: true`, status only.
5. **`558fc4f` — final review's m7 closed.** The `submission_cases` INSERT was
   check-then-act while every `submissions` UPDATE was fenced; a stale insert
   landing after `requeueAll`'s delete re-created rows that `max(attempt)` then
   picked, showing the old verdicts beside a `queued` submission. Fence folded
   into the statement; pinned deterministically (check stubbed as passed,
   supersession applied in the gap), mutant killed.
6. **`ff5d04f` — `NaN <= 0` is false.** `time-limit` used `Number.isInteger`;
   `memory-limit` did not, so a missing/garbage value walked past its only guard
   and left `memoryKb: NaN` → `null` on disk, failing two steps later at upload.
   A byte count that is not a whole number of KB is now refused, not floored.
7. **`b022f72` — `oj watch` printed `CE` and stopped**, withholding the one field
   that explains a CE. Prints `compileOutput` on any terminal verdict now.

## Cleared, with evidence

- **Verdict matrix, live:** AC 100/100 · WA · TLE (3001 ms) · RTE (`segmentation
  fault`) · **OLE** · unicode source AC · empty 422 · 64 KB 201 / 64 KB+1 422 ·
  unknown language 404 · unknown problem 404 · unpublished problem 409
  `problem_not_submittable`. Short-circuit reports `skipped`, not a verdict.
- **Batch aggregation, live:** three groups worth 0/40/60 fold to exactly 100.
- **MLE is effectively unreachable on this judge** — not a mapping bug
  (`verdict.ts` is right and unit-tested), but DMOJ enforces the limit on address
  space, so an over-limit program dies first: `std::bad_alloc` → RTE at 131 MB
  under a 256 MB limit, and a 400 MB BSS segfaults at 4 KB RSS. Stated because
  the UI advertises MLE as a verdict.
- **Rejudge against a NEWER revision is correct.** `rejudgeProblem` targets the
  current *published* revision, `rejudgeSubmission` keeps the pinned one, and
  both move `submissions.revision_id` **and** `grading_jobs.revision_id`/
  `package_hash` together, in one transaction. Live admin rejudge of #73: 202,
  same job row, fresh cases, AC 100/100, `ratedContestKeys: []` (D21).

## Rulings / concerns

- **The live stack still runs all seven**: every checker-based and Polygon problem
  IEs there, and every oversized paste logs an operator-facing 500, until merge.
- **Judge disconnect mid-grade is slow, not wrong.** `bridge-server`'s
  `socket.on('close')` notifies the driver of nothing, so a crash mid-grade leaves
  the entry in `assignments`/`live` and the worker waiting out `gradingCeilingMs`
  (300 s–30 min) before the lease-lapse regrade. A prompt fix needs a
  driver→worker abandonment channel (`dispatch` has already resolved by then);
  architectural, left with this pointer.
- `JobStore.reclaimExpired()` is called by nothing outside tests — dead code.
- `rejudgeProblem` requeues *every* submission of a problem in one transaction,
  unbounded.
- `GET /packages/{hash}` answered 200 to a plain session cookie despite
  `@RequireScope('packages:read')` — summary only, no test data; handing to the
  auth area rather than chasing it here.
- The `contest-scoreboard-cache` "privileged board" test flaked once under full
  suite load (2 s TTL, D25) and passed alone and on re-run; untouched by this work.
- `bh3-61808` and its ~12 submissions remain; nothing stopped or rebuilt, no
  migration needed (D41/D42 unused).
