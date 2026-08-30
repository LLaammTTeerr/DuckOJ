# F15 — contest source-similarity report, chống gian lận (D77)

**DONE_WITH_CONCERNS.** On `main`, not pushed: `423ad13` package · `a5c31f3`
migration 0028 · `6a8daec` API + contracts + SDK · `e46f19b` web + D77 ·
`dab4f44` report · `60315bb` the two fixes the full suite found.

## Shipped
**`packages/similarity`** — pure, no dependencies. Language-aware tokenisation
(C/C++/Python/Java: comments and whitespace erased, identifiers → `V`,
literals → `N`/`S`, keywords and operators verbatim, every token carrying its
offsets in the source), k-gram hashing (k=5, `Math.imul` FNV so order counts),
winnowing (window 4, rightmost on tie), compared by Jaccard **and** by
containment, plus `matchedSpans`. `languageFamily` reads the site's free-text
`languages.key` and answers `null` — skip, never guess.

**API** — `similarity_runs` (guarded; 0028). `ContestSimilarityService` in
`authz/` on `ContestClarificationsService`' precedent (five guarded tables
read, a sixth written). Three routes on `ContestsController`, tag `Contests`,
each `loadVisible` → `canRunContest` → 403 `contest_forbidden`:
`POST`/`GET /contests/{key}/similarity`, `GET …/{a}/{b}?problem=`. The run row
commits first; the work runs in-process under `pg_advisory_xact_lock(LOCK,
contest_id)`, problem by problem so one problem's sources are resident at a
time. 409 `similarity_running`; 422 `similarity_too_large` (>3000, with the
number); 500 pairs/problem truncated with a flag.

**Web** — "Kiểm tra trùng lặp" for `canEdit`: threshold box, run button, D77's
caution beside the table, pairs by shared fraction, polled at 2 s only while
`running`. The comparison is its own route (`?a=&b=&problem=`): two `<pre>`
columns, matches as `<mark class="match">` over a new `--mark` token that tints
the glass inset in both schemes. Sources are React children, never markup.
vi + en, 20 keys each.

## Tests — 43 package + 23 api + 13 web
Golden pairs measured: identical 1.00 · renamed 1.00 · reordered 0.99/0.93 ·
padded 1.00/0.92 · unrelated **0.064/0.025**, in three languages. **18 mutation
checks, each red then restored.** Package: identifiers not normalised (14 red) ·
comments kept (2) · commutative combine (1) · leftmost-on-tie (1) · containment
over the larger set (1) · empty fingerprints scoring 1 (1) · spans unmerged (3).
API: `canRunContest` gate removed (1) · virtuals compared (4) · AC not preferred
(1) · pair cap removed (1) · pair view serving an unreported pair (1) ·
threshold ignored (6) · participant cap removed (1). Web: `canEdit` gate removed
(1) · threshold posted as a string (1) · span clamping removed (1) · matches
unmarked (1). Two tests were **passing for the wrong reason** and were
rewritten: the order test compared streams differing in content not order (xor
survived it), and the clamping test used ranges that reassemble even unclamped —
the real case is out-of-order spans, which unclamped emit the code TWICE.

Ritual green: `-r typecheck` + `typecheck:scripts` + `-r lint` + `lint:scripts`;
**api 884/884 (99 files)**, web 441/441, similarity 43/43, contracts 36/36,
db 48/48, judged 118/118, and every other package; regen leaves no diff;
`vite build` OK. The suite earned its keep twice: `apps/api/Dockerfile`'s
hand-maintained deps stage never learned the new package (a green suite, a
broken image — the wart the runbook names), and `dockerfile-manifest.spec.ts`
was walking `.claude/worktrees/**` and judging other branches' Dockerfiles
against THIS graph, so any new package turned 26 stale worktrees red. Both in
`60315bb`; the manifest fix mutation-checked. One run flaked 58 tests over five
files I never touched, all green in isolation and on the next full run —
F12's documented load flake.

## Rulings — all eleven in D77
The load-bearing one: **a report is a magnifying glass, never a verdict** —
nothing disqualifies, notifies, or reaches a competitor's screen, and the
caution is on the page. The second: **D27 is reused, not weakened** — its
exempt set is exactly `canRunContest`, so the pair view discloses nothing an
organiser could not open one submission at a time. Then: containment (not
Jaccard) is what the threshold tests, because padding is the first disguise;
live participations only, disqualified rows kept; one language family only;
the two caps refused differently because one is knowable before the work.

## Concerns
- **A crash mid-run leaves `status: 'running'` forever** and that contest's
  button then 409s with no way back but one `UPDATE`. The `.catch` covers a
  thrown error, not a killed process. No reaper built.
- The advisory lock is held for the whole comparison inside one transaction
  (`RatingService`'s precedent) — per contest, but a 3000-entrant run holds a
  connection for its duration.
- C++ **raw strings** are not modelled; one containing a quote shifts that
  file's tokens. Degrades toward "unrelated", never toward a false accusation.
- No Playwright coverage of the new route; the web tests mock the SDK.
- The `dist/` wart again: `tsc -b` must run before the web typechecks against
  a new contract.
