# F6 — contest PDF booklet + problem statistics (2026-08-29 feature/bug loop)

Six commits, one migration (0022). Ritual green: **1430 tests / 166 files**, regen
with no diff, `vite build`. **D48** rules the booklet, **D49** the statistics;
sixteen mutants run, sixteen killed.

## A — the contest booklet (D48)

`GET /contests/{key}/booklet.pdf?lang=vi|en` — cover (name, window, per-problem
limits), then each problem behind a page break, headed `Bài A. …`, page numbered.
Web: "Tải đề (PDF)" on the contest page, `lang` from the reader's locale, shown
only once there is a problem list to print. ONE typst document, not one compile
per problem: `lowerBody` is factored out of `markdownToTypst`, numbering runs
across the whole booklet. Rulings:
- **`## English` was already the convention** in `content/problems/`, so D48
  codifies it: the first top-level `## English` / `## Tiếng Việt` splits, no marker
  prints the WHOLE statement either way, the splitter is fence-aware, and it drops
  the `---` above the heading, which escaped would print.
- **Pre-start is 404, not the scoreboard's 409**: visibility is the contest's
  problem LIST, and "exists but starts later" is the fact concealed. Decided
  before the renderer, so a typst-less server cannot 501 a contest it hides.
- **The key hashes the document, not the revision set** (the brief asked for the
  latter; a statement is a plain `problems` column, so a typo fix changes no
  revision id), so nothing invalidates it — an edit stops addressing the old key.

## B — problem statistics (D49)

`GET /problems/{code}/stats` (30 s, `X-Stats-Cache`) plus `solvedCount` /
`attemptedCount` on `ProblemSummary`. Web: a "Thống kê" section (own query, silent
on error) and a `solved / attempted` list column. Rulings:

- **A submission counts only once its participation window has closed** — the
  instant D27 releases its source, off a `participationEndsAtSql()` now shared
  with `frozenSubmissionsWhere` rather than transcribed twice. Uniform for EVERY
  viewer, admins included: that keeps the response viewer-independent and the one
  cache key sound. Corollary, accepted: mid-contest "first solver" can name the
  second person, correcting itself at the bell.
- **D35 masks it too** — a viewer sitting a running contest gets the shape an
  untouched problem returns, applied *after* the cache read so the mask is never
  what gets stored. Rate is AC submissions / total, `null` never `0`; fastest is
  one row per person (`DISTINCT ON`), linking a submission page that itself
  decides whether that viewer may open it.
- **Migration 0022** adds `submissions(problem_id, user_id, verdict)` — the case
  F5's "no index, deliberately" left open (an admin-only page then, the app's most
  public one now). EXPLAIN at 60 000 rows: bitmap index scan, 4.8 ms.
## Tests (red → green, then mutated) and concerns

`contest-booklet.spec.ts` (16, incl. a real-binary compile skipped without typst)
— 11 red first; 5 mutants killed: pre-start concealment dropped · fence-blind
splitter · trailing rule kept · break after not before · key without the hash.
`problem-stats.spec.ts` (9, `testDbUrl()`, full participation matrix) — 7 killed:
stats/counters ignoring the open window · distinct-on by id · first solver by time
· rate as solvers/attempters · D35 unmasked, twice. Web +5 tests, 4 killed.

**Concerns.** `pnpm -r test` flaked twice under load in *unrelated, untouched* web
specs (`contest-edit`, then `logout`), green on the third run and passing alone
twice each — jsdom under contention beside 78 testcontainer files. A fresh
worker's FIRST booklet/stats request never caches: the store's Redis connection is
lazy with `enableOfflineQueue: false`, so its first command fails while the socket
connects (both specs document it). Nothing stopped or rebuilt; not pushed.
