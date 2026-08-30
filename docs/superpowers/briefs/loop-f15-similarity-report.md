# F15 — contest source-similarity report, chống gian lận (D77)

**DONE_WITH_CONCERNS.** On `main`, not pushed: `423ad13` package · `a5c31f3`
migration 0028 · `6a8daec` API + contracts + SDK · `e46f19b` web + D77 ·
`60315bb` two fixes the full suite found · this report.

## Shipped
**`packages/similarity`** — pure, no dependencies. Language-aware tokenisation
(C/C++/Python/Java: comments and whitespace erased, identifiers → `V`, literals
→ `N`/`S`, keywords and operators verbatim, every token keeping its offsets),
k-gram hashing (k=5, `Math.imul` FNV so order counts), winnowing (window 4,
rightmost on tie), compared by Jaccard **and** containment, plus `matchedSpans`.
`languageFamily` reads the free-text `languages.key`; `null` means skip.

**API** — `similarity_runs` (guarded; 0028). `ContestSimilarityService` in
`authz/` on `ContestClarificationsService`' precedent (five guarded tables read,
a sixth written). Three routes on `ContestsController`, tag `Contests`, each
`loadVisible` → `canRunContest` → 403 `contest_forbidden`: `POST`/`GET
/contests/{key}/similarity`, `GET …/{a}/{b}?problem=`. The run row commits
first; the work runs in-process under `pg_advisory_xact_lock(LOCK, contest_id)`,
problem by problem so one problem's sources are resident at a time. 409
`similarity_running`; 422 `similarity_too_large` (>3000, with the number);
500 pairs/problem truncated with a flag.

**Web** — "Kiểm tra trùng lặp" for `canEdit`: threshold box, run button, D77's
caution beside the table, pairs by shared fraction, polled at 2 s only while
`running`. The comparison is its own route: two `<pre>` columns, matches as
`<mark class="match">` over a new `--mark` token that tints the glass inset in
both schemes; sources are React children, never markup. vi + en, 20 keys each.

## Tests — 43 package + 23 api + 13 web
Golden pairs measured: identical 1.00 · renamed 1.00 · reordered 0.99/0.93 ·
padded 1.00/0.92 · unrelated **0.064/0.025**, in three languages. **19 mutation
checks, each red then restored** — identifiers not normalised (14 red) ·
comments kept · commutative combine · leftmost-on-tie · containment over the
larger set · empty fingerprints scoring 1 · spans unmerged · `canRunContest`
gate removed · virtuals compared · AC not preferred · pair cap removed · pair
view serving an unreported pair · threshold ignored · participant cap removed ·
`canEdit` gate removed · threshold posted as a string · span clamping removed ·
matches unmarked · the Dockerfile COPY line dropped. Two tests **passed for the
wrong reason** and were rewritten: the order test compared streams differing in
content, not order (xor survived it); the clamping test used ranges that
reassemble even unclamped — the real case is out-of-order spans, which unclamped
emit the code TWICE. Ritual green: typecheck + lint (+ `:scripts`), **api
884/884 (99 files)**, web 441/441, similarity 43/43, every other package; regen
leaves no diff; `vite build` OK. The suite earned its keep twice —
`apps/api/Dockerfile`'s hand-maintained deps stage never learned the new package
(green suite, broken image), and `dockerfile-manifest.spec.ts` was judging
`.claude/worktrees/**` against THIS tree's graph, so any new package turned 26
stale worktrees red. Both fixed in `60315bb`. One run flaked 58 tests over five
untouched files, green in isolation and on the next full run (F12's load flake).

## Rulings — all eleven written out in D77
**A report is a magnifying glass, never a verdict**: nothing disqualifies,
notifies, or reaches a competitor's screen. **D27 is reused, not weakened** —
its exempt set is exactly `canRunContest`. Then: containment (not Jaccard) is
what the threshold tests, because padding is the first disguise; live
participations only, disqualified rows kept; one language family only.

## Concerns
- **A crash mid-run leaves `status: 'running'` forever**; that contest's button
  then 409s with no way back but one `UPDATE`. No reaper built.
- The advisory lock is held for the whole comparison in one transaction
  (`RatingService`'s precedent) — per contest, but a 3000-entrant run holds a
  connection for its duration.
- C++ **raw strings** are not modelled; one containing a quote shifts that
  file's tokens. Degrades toward "unrelated", never a false accusation.
- No Playwright coverage of the new route; the web tests mock the SDK.
- The `dist/` wart again: `tsc -b` before the web typechecks a new contract.
