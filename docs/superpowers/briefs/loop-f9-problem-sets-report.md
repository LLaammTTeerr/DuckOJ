# F9 — classroom problem sets (2026-08-29 feature/bug loop)

Six commits (db · contracts · api · web · docs · this correction), migration
**0026**, **D66**. Ritual: typecheck (incl. scripts), lint, regen no-diff, `vite
build`, `graphify update .`; **api 837 tests / 89 files, web 350 / 38**, each
suite run on its own (see Concerns). 29 mutants, all killed.

## Shipped
**Six routes under `/orgs/{slug}/sets`** (tag `Organizations`, `orgs:read` /
`orgs:write`, none `@Public`): list · one set · `…/progress` (JSON grid or
`?format=csv`) · POST · PATCH · DELETE. Guarded tables `problem_sets` (slug unique
per org, case-folded) and `problem_set_items` (`order`, `points` default 100).
`ProblemSetAccessService` asks `OrgAccessService` who may act — `loadVisibleWithRole`
(new), `loadForEdit` (now public).

**Web:** a "Bài tập về nhà" section on the org page (absent for anyone the API
answers an empty list; silent on failure, like `OrgContests`); a set page with the
pupil's on-time and late results as two columns and a submit link each; the
teacher's grid on its own route, CSV link straight at the API, inside the
`tabindex` scroll wrapper m21 asked for (`.grid-scroll`, sticky header); an
assign/edit form with a problem picker. vi/en.

## Rulings (all in D66)
- **Member-gated, blanked never signalled.** A non-member of a *visible* school
  gets an empty list and `problem_set_not_found` from every set, not a 403 — an
  item may name an `org` problem shared with that school alone.
- **`late` is an ENTRY on the cell, not a flag on it** (`{ onTime, late }`). The
  brief's `late: true` cannot hold the case homework is about — an on-time `WA`
  and an `AC` two days later. Inclusive deadline; `solvedAt` only on `AC`.
- **The grid applies D49's contest-window exclusion; the pupil's own page does not**
  (D23 never masks the submitter) — a pupil sees their score before their teacher.
- **The CSV is the whole roster**, a documented exception to D58 — a paged grid
  cannot go into a spreadsheet. A dated set gets a second `<code> (late)` column.
- **422 at write time** for a problem the school could not open, an unknown code
  or a repeat, keyed `problems[<n>].code`; one narrowed *afterwards* keeps its row,
  `visible: false`. **D35 has nothing to mask** — an item carries code, name, points.

## Tests
`apps/api/test/problem-sets.spec.ts` — 15 over HTTP; the last on `testDbUrl()` (a
racing slug needs two committed transactions). **18 mutants killed** — one per
ruling above, plus a global admin read as an outsider · an exclusive deadline · a
late side with no deadline · a silent duplicate · problem-id ordering · `solvedAt`
on a partial · a 500 on a racing slug · a CSV that stops at a page, loses its late
column, or arrives as JSON. `apps/web/test/problem-sets.spec.tsx` — 10, **11
killed**, including the scroller losing its `tabindex` or its name, the late column
disappearing, an unopenable problem still linked, the picker re-sorting the
teacher's order, and the section fetching while signed out. Two first-pass survivors
were fixed in the TESTS: an "expect nothing rendered" that passed before the answer
arrived, and a `<th>`-only mutation the cell assertions missed.

## Concerns
**The CSV is unbounded** — 5,000 members × 200 problems is one large, owner-only,
uncached response, never exercised past a handful of rows; nothing meters set
creation either. **The grid is one page in the web UI**: the screen says there is
more, with no "load more" button yet. **`problem_set_items` has no `ON DELETE` on
`problem_id`**, so deleting an assigned problem is now refused — deliberate, but a
new way for a delete to fail. **`pnpm -r test` runs the api and web suites
concurrently**, and two unrelated web specs (a different pair on each of two runs:
`logout`, `orgs`, `contest-freeze`) flake on `waitFor` under that contention; both
suites pass alone.
