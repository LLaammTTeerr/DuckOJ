# loop f37 — the two bugs FE-5's phone journey left open

Both real, both invisible to every test that existed, and both the same shape: a screen answering a question nobody asked, and saying nothing when it cannot answer at all.

## 1. The front page could not see today's contest (D151)

`GET /contests` answered "everything, oldest **id** first" — *creation* order, 25 rows of 125 — so the round a school set up this morning was on the last page, at the one moment the home panel exists for.

- **`?phase=running|upcoming|active`** filters and reorders to `(start_time, id)`. `active` is the union and it is what home wants: a running round started in the past, an upcoming one starts in the future, so start-time order alone puts the round the reader is IN first — `pickContest`'s rule, arrived at by the `ORDER BY`. No `finished`; unfiltered is already everything. The reorder is scoped to the filter, so the unfiltered path is byte-identical for existing callers. A `phase` page carries a composite cursor (`<ms>_<id>`): two rounds starting at 08:00 on one Saturday is the normal case, and a single-column seek over a non-unique key repeats a row or loses one.
- **`?mine=true`** is `assertMayJoin` as a filter, branch for branch: participation held, no organizations at all, or membership of one. Admin passes all of it; anonymous gets an **empty page, never 401**. Clock is the database's `now()`.
- **Neither widens anything** — plain ANDs on `visibleContestsWhere`, and `toSummary` untouched, which is what keeps D35/D22 true rather than believed (`ContestSummary` carries no tag and no score).
- **The panel takes its own cache key.** D138 shared `contests.tsx`'s `['contests']` to warm the list; with a narrow question that inverts, and `/contests` paints 3 rounds out of 125 on its first render. **D151 supersedes that clause of D138.**

## 2. A socket that never opens was silent (D152)

`submit.liveUnavailable` fired only on an `error` FRAME — an upgrade that *succeeded* and a subscribe that was refused. A failed **upgrade** sends no frame at all, so the panel stayed blank while the judge graded. Six seconds without a `subscribed` ack → say so, poll `GET /submissions/{id}` every four until terminal. **ONE deadline per submission, not per attempt** — a refusing proxy loops connect→close faster than any per-attempt timer would fire, and that detail decides whether this works at all. New `submit.liveSlow` in both locales, `role="status"` (D144), gone once the verdict is up; `liveUnavailable` untouched, its "refresh" wording being a lie once the page refreshes itself.

## Tests

**RAN:** `-r typecheck` + `typecheck:scripts` · `-r lint` + `lint:scripts` · `vitest run --no-file-parallelism` **726 passed (65 files)**, +8 on FE-5 · contracts+SDK regen, no diff · `vite build` · `verify:csp`. All green.

**WRITTEN, NOT RUN:** `apps/api/test/contest-list-filters.spec.ts` — 6 container-backed tests (D106/D149; CI runs them serially). They compile and lint here, which is their only local check. The expensive one is deliberate: 30 finished rounds seeded first so they own the low ids, then today's, then "absent from the unfiltered first page, first on the filtered one". Nothing cheaper reproduces the bug.

**Mutations (web, red→green):** drop the home params → red · restore the shared key → red (asserted on the contest list's FIRST paint — a background refetch repairs the collision, so an `await` hides it) · remove the deadline arm → 5 red · re-arm per attempt → the connect→close-loop spec red.

## Rulings (no human available)

`phase` is an enum containing `active`, not a repeatable or comma-separated param (one OpenAPI enum, no transform) · `mine` is `'true'|'false'`, since a query string carries strings and `false` spelled out is legible in a URL · a cursor from the wrong grammar is 422 `invalid_cursor`, not a silent page 1 · home asks for 5 rather than 1, because server and client can disagree about "running" across a clock skew.

## Concerns

- **Thermal.** The full vitest run peaked **k10temp 94.1 °C**, over the 85 °C cap, on a suite that only gets longer. It was the one unavoidable run.
- **No e2e this loop** (run budget), so neither fix has been walked on a phone. `e2e/phone-contest.spec.ts` is what would prove the panel; `states.spec.ts` the fallback line.
- FE-5's stray trailing blank line in `docs/DECISIONS.md` folded into D151.
