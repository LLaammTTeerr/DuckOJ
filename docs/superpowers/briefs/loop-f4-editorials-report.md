# F4 — editorials (lời giải), per problem

Status: **DONE**. Rulings are **D43**. Migration **0021**.

## What shipped
`problems.editorial` (text, nullable) + `problems.editorial_published_at`
(timestamptz, nullable), with `problems_editorial_published_ck` making
"published" imply "has text" — so clearing the text has to unpublish it, in
the database and not only in one UPDATE. On the problem row, not a revision:
an editorial explains the problem, and a republished test set does not
invalidate it.
- **D43 visibility**, resolved in `ProblemAccessService.resolveEditorial` in
  the order it is decided: no text → refused; an **editor** (author/curator/
  admin) gets the text draft included; unpublished → refused; not in D35's
  own `contestHiddenProblemIds` set → served; sitting the contest but holding
  an **AC** (explicit `verdict = 'AC'` existence check, not the `me` lateral's
  points ordering) → served; otherwise refused until the clock runs out.
- **Never a leak.** `GET /problems/{code}` carries `editorial` +
  `editorialAvailable`; for a non-editor `null`/`false` is one answer to
  "absent", "draft" and "withheld". The one exception is an editor's draft
  (`editorial` set, `editorialAvailable: false`) — which is exactly what the
  edit form's textarea and publish toggle seed from. A third
  `editorialPublishedAt` field would read more plainly but would itself need
  masking; ruled two fields, recorded in D43.
- `GET /problems/{code}/editorial` (tag `Problems`) is built **on**
  `getVisible`, so the two surfaces cannot drift and the problem's own
  `problem_not_found` is decided first; then one `editorial_not_found` for
  every editorial-level refusal alike.
- `PATCH` takes `editorial` (`null` clears **and** unpublishes, same UPDATE)
  and `editorialPublished`; `true` against absent/whitespace text is 422
  `problem_editorial_empty`; re-publishing does not move the date.
- Web (vi/en): a `<details>` on the problem page — a spoiler nobody should
  meet by scrolling — through the existing `renderStatement` (marked + KaTeX
  + DOMPurify); an editorial textarea, live preview and publish checkbox on
  the edit form, edit-only like `tags`/`difficulty`. `problem.editorial ?? null`
  defensively: a bundle can outrun its API, and `renderStatement(undefined)`
  would white-screen the page.
- `content/problems/tong-hai-so/editorial.md` (vi+en, the 32-bit trap) and a
  `[ -f ]`-guarded step 7 in `content/README.md` that PATCHes it published.
  Unapplied — nothing was run against the live stack.

## Files
`packages/db/src/schema/guarded.ts` + `migrations/0021_editorials.sql` (+meta);
`packages/contracts/src/problems.ts` + `openapi.json` + the SDK;
`apps/api/src/{authz/problem.access.ts,problems/problems.controller.ts}`;
`apps/web/src/{routes/{problem,problem-edit}.tsx,i18n/{vi,en}.ts}`;
`docs/DECISIONS.md`; `content/{README.md,problems/tong-hai-so/editorial.md}`.

## Tests — red first, then mutation-checked
- `packages/db/test/editorials.spec.ts` (3). 1 mutation, restored: the CHECK
  dropped from 0021 → red.
- `apps/api/test/problem-editorial.spec.ts` (16 — 13 red before the service
  existed, one branch per D43 clause plus an HTTP case for the route's
  `@Public()` + the three 404 codes). 11 mutations, each restored: editor
  branch dropped · publish gate dropped · contest mask dropped · AC branch
  dropped · AC ignores the verdict · clearing keeps the publish date ·
  republish bumps the date · whitespace counts as text · editor availability
  forced true · route never 404s · hidden set ignores the organiser.
- `apps/web/test/problem-editorial.spec.tsx` (7). 9 mutations, each restored:
  section always/never rendered · draft marker dropped · editorial printed as
  raw source · textarea never seeded · toggle never seeded · empty box omits
  the key · publish flag never sent · field shown on the create route.
- Three existing web fixtures gained the two fields.
- Ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`,
  `lint:scripts`, `-r test` (674 api / 253 web / 34 db / 18 contracts), regen
  leaves no diff, `vite build` clean.

## Concerns
1. **Migration numbering.** 0021 sits beside a 0020 hole reserved for a
   sibling task. Drizzle orders by the journal's `when`, not by a contiguous
   `idx`, so this applies cleanly on its own — but whoever merges second must
   check their `when` is greater than the other's, or a live database will
   skip one. Flagged for the controller, not fixed here.
2. D43 inherits every softness D35 named: the contest's window rather than a
   virtual one, and signing out defeats the mask. Accepted on the same
   grounds — and an editorial, unlike a tag, is worth more to the person who
   signed out, so this is the sharper edge of the two.
3. `getEditorial` runs the whole `getVisible` query to answer one string.
   Correctness over a round trip: one definition of who may read an editorial
   is worth more than the query it saves.
4. No Playwright journey for the disclosure, and `editorial.md` exists for
   one of the five demo problems.
