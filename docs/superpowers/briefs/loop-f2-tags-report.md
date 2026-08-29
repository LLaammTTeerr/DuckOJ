# F2 — problem tags and difficulty, with filtering

Status: **DONE**. Rulings are **D35**. Migration **0018**.
## What shipped
`tags` (unguarded — a closed public vocabulary, on `languages`' precedent),
`problem_tags` (guarded — "which tags does THIS problem carry" is
actor-dependent) and `problems.difficulty` (nullable smallint, CHECK 1–10).
0018 seeds the 25 olympiad tags itself: `?tag=` slugs are API surface, and a
taxonomy needing a seeder run is one the first deploy ships without.
- `GET /tags` — `@Public()` + `problems:read`, by slug, unpaginated.
- `GET /problems` gains `tag` (repeatable, **ANDed**) and `difficultyMin`/
  `difficultyMax`; items carry expanded `tags[]` + `difficulty`, as does
  `GET /problems/{code}`. The AND counts against slugs **requested**, not
  resolved, so an unknown slug empties the page rather than widening it.
- `PATCH /problems/{code}` takes `tags` (slugs, whole-set replacement,
  unknown → 422 `problem_tag_unknown`) and `difficulty` (`null` clears).
- **D35**: tags and difficulty blank to `[]`/`null` for a viewer holding a
  participation in a contest running *now* that uses the problem, unless they
  organise it or are admin. The filter runs over that masked view — a hidden
  problem drops out of a filtered page entirely, or `?tag=` would answer what
  the blank chip row refused; an unfiltered page still lists it, blanked.
  `loadDetailById` is unmasked: a PATCH must echo what it wrote.
- Web (vi/en): difficulty column + linked chips on the list and problem page;
  a checkbox filter bar in the URL via `validateSearch`; tag checkboxes and a
  difficulty box on the edit form (edit-only, like `sourceAccess`).
  `tagName(locale, tag)` picks a field — tag words are data, not catalogue.
- `content/tags.json` + a README section and a step-6 `jq | PATCH`, unapplied.

## Files
`packages/db/src/schema/{tags,guarded,index}.ts` + `migrations/0018_tags.sql`;
`packages/contracts/src/{tags,problems,index}.ts` + `openapi.json` + the SDK;
`apps/api/src/{tags/*,app.module.ts,authz/problem.access.ts,problems/*.controller.ts}`;
`apps/web/src/{tags.ts,router.tsx,app.css,i18n/*,routes/{problems,problem,problem-edit}.tsx}`; `docs/DECISIONS.md`; `content/{tags.json,README.md}`.
## Tests — red first, then mutation-checked
- `packages/db/test/tags.spec.ts` (4). 3 mutations, each restored: CHECK
  dropped · seed INSERT dropped (3 red) · tag FK `restrict`→`cascade`.
- `apps/api/test/problem-tags.spec.ts` (15) — 14 red before the service
  existed — plus `tags-http.spec.ts` (3: repeated/single `?tag=`, a 422
  bound). 11 mutations, each restored: `HAVING count = requested` → `>= 1` ·
  no slug dedup · filtered page keeps hidden rows · `getVisible` stops masking
  · organiser exemption · admin bypass · `now() < end_time` · tag write merges
  · unknown slug ignored · `difficulty !== undefined` → truthy · order by id.
- `apps/web/test/problem-tags.spec.tsx` (12). 8 mutations, each restored:
  `parseDifficulty` unbounded · toggle replaces the set · filters out of the
  query key · tag never sent · empty box omits · `initialFilters` ignored ·
  `tagName` ignores locale · chips dropped.
- `problem-me-verdict.spec.ts`'s "one statement" case now measures a wide page
  against a narrow one: three per page, independent of row count. Web mocks
  answer `GET /tags`; three fixtures gained `tags`/`difficulty`.
- Ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`,
  `-r test` (633 api / 232 web / 31 db), regen no diff, `vite build`.

## Concerns
1. D35 keys on the contest's window, not a virtual one, so a virtual attempt
   after `end_time` sees the tags; signing out defeats the mask too. Both
   accepted — the vocabulary is public anyway.
2. Three statements per page now, all per-page and none per-row. No Playwright
   journey for the filter bar; `content/tags.json` is unapplied.
3. TanStack Router JSON-encodes the array in the URL (`?tag=["do-thi"]`), not
   the API's repeated spelling. `validateSearch` accepts both.
