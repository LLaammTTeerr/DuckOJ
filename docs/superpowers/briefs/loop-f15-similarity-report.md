# F15 — contest source-similarity report, chống gian lận (D77)

**Status pending the full API suite** (running at the time of writing;
`contest-similarity.spec.ts` is 23/23 and every other package is green).
Commits on `main`, not pushed: `423ad13` the package · `a5c31f3` migration
0028 · `6a8daec` API + contracts + SDK · `e46f19b` web + D77 · this report.

## Shipped

**`packages/similarity`** — pure, dependency-free. Language-aware tokenisation
for C / C++ / Python / Java: comments and whitespace erased, identifiers
normalised to `V`, literals to `N`/`S`, keywords and operators kept verbatim,
every token carrying its offsets in the original source. Then k-gram hashing
(k=5, `Math.imul` FNV so order matters) and winnowing (window 4, rightmost on
tie) into fingerprint sets, compared by Jaccard and by containment, plus
`matchedSpans` for the highlighting. `languageFamily` reads the site's free-text
`languages.key` (`cpp17`, `py3`) rather than an enum, and answers `null` — skip,
never guess — for anything it has no lexer for.

**API** — `similarity_runs` (guarded, migration 0028: contest, status,
threshold, requested_by, started/finished, `pairs` jsonb, error).
`ContestSimilarityService` in `authz/` on `ContestClarificationsService`'
precedent (it reads five guarded tables and writes a sixth). Three routes on
`ContestsController`, tag `Contests`, all gated `loadVisible` → `canRunContest`
→ 403 `contest_forbidden`: `POST/GET /contests/{key}/similarity` and
`GET …/{a}/{b}?problem=`. The run row is committed first; the work runs
in-process under `pg_advisory_xact_lock(SIMILARITY_LOCK, contest_id)`, problem
by problem so only one problem's sources are resident. 409 `similarity_running`,
422 `similarity_too_large` (>3000 participants, with the number), 500 pairs per
problem truncated with a flag.

**Web** — "Kiểm tra trùng lặp" for `canEdit`: threshold box, run button,
D77's caution printed beside the table, pairs sorted by shared fraction with
both scores, polled at 2 s only while `running`. The comparison is its own
route (`/contests/$key/similarity?a=&b=&problem=`): two `<pre>` columns in a
grid, matched regions as `<mark class="match">` over a new `--mark` token that
tints the glass inset in both schemes. Sources are React children, never
markup. vi + en (20 keys each).

## Tests — 43 package + 23 api + 13 web

Golden pairs measured, not guessed: identical 1.00, renamed 1.00, reordered
0.99/0.93, padded 1.00/0.92, unrelated **0.064/0.025** — in C++, Python and
Java. **18 mutation checks, each red then restored.** Package: identifiers not
normalised (14 red) · line comments kept (2) · commutative k-gram combine (1) ·
leftmost-on-tie (1) · containment over the larger set (1) · empty fingerprints
scoring 1 (1) · spans not merged (3). API: the `canRunContest` gate removed (1) ·
virtual participations compared (4) · AC no longer preferred (1) · pair cap
removed (1) · the pair view serving an unreported pair (1) · threshold ignored
(6) · participant cap removed (1). Web: the `canEdit` gate removed (1) ·
threshold posted as a string (1) · span clamping removed (1) · matched regions
not marked (1).

Two tests were **passing for the wrong reason** and were rewritten: the
order-sensitivity test compared two streams that differed in content rather
than in order (xor survived it), and the span-clamping test used ranges that
reassemble correctly even unclamped — the real case is out-of-order spans,
which unclamped emit the code TWICE.

Ritual: `-r typecheck` + `typecheck:scripts` + `-r lint` + `lint:scripts` all
green; every package but api green (`web 441/441`, `similarity 43/43`,
`contracts 36/36`, `db 48/48`, `judged 118/118`, …); regen leaves no diff;
`vite build` OK.

## Rulings — all eleven are in D77

The load-bearing one: **a report is a magnifying glass, not a verdict.**
Nothing disqualifies, notifies, or reaches a competitor's screen, and the
caution is printed on the page. The second: **D27 is reused, not weakened** —
its exempt set (submitter, creator, admin) is exactly `canRunContest`, so the
pair view discloses nothing an organiser could not already open one submission
at a time. Also: containment (not Jaccard) is what the threshold tests, because
padding is the first disguise; live participations only but disqualified rows
kept; comparison inside a language family only; the two caps refused
differently because one is knowable before the work and the other only after.

## Concerns

- **A crash mid-run leaves `status: 'running'` forever**, and that contest's
  button then answers 409 with no way back but editing the table. The
  `.catch` covers a thrown error, not a killed process. No reaper was built;
  an operator's fix is one `UPDATE`.
- **The advisory lock is held for the whole comparison**, inside one
  transaction, on `RatingService`'s precedent. Per contest, so it blocks only
  a second run of the same contest — but a 3000-participant run holds a
  connection for its duration.
- C++ **raw strings** (`R"d(…)d"`) are not modelled: one containing a quote
  shifts that file's remaining tokens. It degrades toward "these look
  unrelated", never toward a false accusation.
- No e2e/Playwright coverage of the new route; the web tests mock the SDK.
- The `dist/` wart bit again: the api resolves `@duckoj/similarity` and
  `@duckoj/contracts` through `dist/`, so `tsc -b` has to run before the web
  typechecks against a new contract.
