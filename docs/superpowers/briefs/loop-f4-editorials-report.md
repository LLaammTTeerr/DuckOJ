# F4 — editorials (lời giải), per problem

Status: **DONE**. Rulings are **D43**. Migration **0021**.

## What shipped
`problems.editorial` + `problems.editorial_published_at`, both nullable, with
`problems_editorial_published_ck` making "published" imply "has text" — so
clearing the text has to unpublish it, in the database and not only in one
UPDATE. On the problem row, not a revision: republishing tests does not
invalidate an editorial.
- **D43**, in `resolveEditorial`, in the order decided: no text → refused; an
  **editor** (author/curator/admin) gets it, draft included; unpublished →
  refused; not in D35's own `contestHiddenProblemIds` set → served; sitting
  the contest but holding an **AC** (explicit `verdict = 'AC'`, not the `me`
  lateral's points ordering) → served; else refused till the clock runs out.
- **Never a leak.** `GET /problems/{code}` carries `editorial` +
  `editorialAvailable`; for a non-editor `null`/`false` is one answer to
  "absent", "draft" and "withheld". The exception is an editor's draft
  (`editorial` set, flag false), which the edit form seeds from.
- `GET /problems/{code}/editorial` (tag `Problems`) is built **on**
  `getVisible` — the two cannot drift, `problem_not_found` is decided first,
  then one `editorial_not_found` for every editorial refusal alike.
- `PATCH` takes `editorial` (`null` clears **and** unpublishes, same UPDATE)
  and `editorialPublished`; `true` against absent/whitespace text is 422
  `problem_editorial_empty`, and re-publishing never moves the date.
- Web (vi/en): a `<details>` on the problem page — a spoiler nobody should
  meet by scrolling — through the existing `renderStatement`; textarea, live
  preview and publish checkbox on the edit form, edit-only like `tags`. Read
  as `editorial ?? null`: a bundle can outrun its API, and
  `renderStatement(undefined)` would white-screen the page.
- `content/problems/tong-hai-so/editorial.md` (vi+en; the only one of the five
  demo problems) and a `[ -f ]`-guarded README step 7 PATCHing it published.
- Files: `db/{guarded.ts,migrations/0021_editorials.sql+meta}`, `contracts/
  problems.ts`+`openapi.json`+SDK, `api/{problem.access,problems.controller}
  .ts`, `web/{routes/problem*,i18n/*}`, `docs/DECISIONS.md`, `content/*`.

## Tests — red first, then mutation-checked
- `packages/db/test/editorials.spec.ts` (3); 1 mutation, restored: 0021's CHECK dropped.
- `apps/api/test/problem-editorial.spec.ts` (16; 13 red before the service
  existed — one per D43 clause, plus HTTP cases for the route's `@Public()`
  and its three 404 codes). 11 mutations, each restored: the editor branch,
  publish gate, contest mask and AC branch each dropped; AC ignoring the
  verdict; clearing keeping the publish date; republish bumping it; whitespace
  as text; availability forced true; the route never 404ing; the hidden set
  ignoring the contest's organiser.
- `apps/web/test/problem-editorial.spec.tsx` (7). 9 mutations, each restored:
  section always/never rendered · draft marker dropped · editorial as raw
  source · textarea/toggle never seeded · empty box omits the key · flag never
  sent · field on the create route. Three fixtures gained the two fields.
- Ritual green: typecheck + lint (both, incl. `:scripts`), `-r test` (674 api
  / 253 web / 34 db / 18 contracts), regen no diff, `vite build`.

## Concerns
1. **0021 sits beside a 0020 hole** reserved for a sibling task. Drizzle orders
   by the journal's `when`, not `idx`, so it applies alone — but whoever merges
   second needs the greater `when`. For the controller.
2. D43 inherits D35's softness: the contest's window, not a virtual one, and
   signing out defeats it — sharper here, an editorial being worth more to a
   signed-out reader than a tag.
3. `getEditorial` runs `getVisible` whole for one string; no Playwright run.
