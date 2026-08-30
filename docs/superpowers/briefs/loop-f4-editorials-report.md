# F4 — editorials (lời giải), per problem

Status: **DONE**. Rulings are **D43**. Migration **0021**.

## What shipped
`problems.editorial` + `problems.editorial_published_at`, both nullable, with
`problems_editorial_published_ck` making "published" imply "has text" — so
clearing the text has to unpublish it, in the database and not only in one
UPDATE. On the problem row, not a revision: an editorial explains the
problem, and a republished test set does not invalidate it.
- **D43**, resolved in `ProblemAccessService.resolveEditorial` in the order it
  is decided: no text → refused; an **editor** (author/curator/admin) gets the
  text, draft included; unpublished → refused; not in D35's own
  `contestHiddenProblemIds` set → served; sitting the contest but holding an
  **AC** (explicit `verdict = 'AC'`, not the `me` lateral's points ordering) →
  served; otherwise refused until the clock runs out on the contest.
- **Never a leak.** `GET /problems/{code}` carries `editorial` +
  `editorialAvailable`; for a non-editor `null`/`false` is one answer to
  "absent", "draft" and "withheld". The single exception is an editor's draft
  (`editorial` set, `editorialAvailable: false`) — exactly what the edit
  form's textarea and publish toggle seed from. A third `editorialPublishedAt`
  would read more plainly but would itself need masking; ruled two fields.
- `GET /problems/{code}/editorial` (tag `Problems`) is built **on**
  `getVisible`, so the two surfaces cannot drift and the problem's own
  `problem_not_found` is decided first; then one `editorial_not_found` for
  every editorial-level refusal alike.
- `PATCH` takes `editorial` (`null` clears **and** unpublishes, same UPDATE)
  and `editorialPublished`; `true` against absent/whitespace text is 422
  `problem_editorial_empty`; re-publishing does not move the date.
- Web (vi/en): a `<details>` on the problem page — a spoiler nobody should
  meet by scrolling — through the existing `renderStatement` (marked + KaTeX
  + DOMPurify); textarea, live preview and publish checkbox on the edit form,
  edit-only like `tags`. `editorial ?? null` defensively: a bundle can outrun
  its API, and `renderStatement(undefined)` would white-screen the page.
- `content/problems/tong-hai-so/editorial.md` (vi+en) and a `[ -f ]`-guarded
  step 7 in `content/README.md` that PATCHes it published. Unapplied.

## Files
`packages/db/src/schema/guarded.ts` + `migrations/0021_editorials.sql` (+meta);
`packages/contracts/src/problems.ts` + `openapi.json` + the SDK;
`apps/api/src/{authz/problem.access.ts,problems/problems.controller.ts}`;
`apps/web/src/{routes/{problem,problem-edit}.tsx,i18n/{vi,en}.ts}`;
`docs/DECISIONS.md`; `content/{README.md,problems/tong-hai-so/editorial.md}`.

## Tests — red first, then mutation-checked
- `packages/db/test/editorials.spec.ts` (3). 1 mutation, restored: the CHECK
  dropped from 0021.
- `apps/api/test/problem-editorial.spec.ts` (16; 13 red before the service
  existed — one per D43 clause, plus an HTTP case for the route's `@Public()`
  and its three 404 codes). 11 mutations, each restored: editor branch dropped
  · publish gate dropped · contest mask dropped · AC branch dropped · AC
  ignores the verdict · clearing keeps the publish date · republish bumps the
  date · whitespace counts as text · editor availability forced true · route
  never 404s · hidden set ignores the organiser.
- `apps/web/test/problem-editorial.spec.tsx` (7). 9 mutations, each restored:
  section always/never rendered · draft marker dropped · editorial as raw
  source · textarea never seeded · toggle never seeded · empty box omits the
  key · publish flag never sent · field shown on the create route. Three
  existing web fixtures gained the two fields.
- Ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`,
  `lint:scripts`, `-r test` (674 api / 253 web / 34 db / 18 contracts), regen
  no diff, `vite build`.

## Concerns
1. **0021 sits beside a 0020 hole** reserved for a sibling task. Drizzle
   orders by the journal's `when`, not a contiguous `idx`, so this applies on
   its own — but whoever merges second must have the greater `when`, or a
   live database skips one. For the controller, not fixed here.
2. D43 inherits D35's softness: the contest's window, not a virtual one, and
   signing out defeats it. An editorial is worth more to the signed-out
   reader than a tag is, so this is the sharper edge of the two.
3. `getEditorial` runs `getVisible` whole to answer one string — one
   definition of who may read an editorial is worth the round trip.
4. No Playwright journey for the disclosure; one of five demo problems has an
   `editorial.md`.
