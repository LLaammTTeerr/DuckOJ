# F12 — contest results export and certificates (D71)
**DONE_WITH_CONCERNS.** Branch `worktree-agent-a47e6d8ec92ad46a0`, not pushed:
`ead257f` API · `6f1dc80` tests · `6ebe009` web + D71 · `3bb63eb` test
hardening · `fe69808` CORS · plus this report and the `top`-bounds test.

## Shipped
Three routes on `ContestsController`, tag `Contests`, gated on
`canRunContest`; 501 without typst, always after the 404/403.
- `results.csv` — rank, username, display name, the competitor's own orgs,
  points/attempts/time per problem, total, penalty, `disqualified`, `virtual`;
  UTF-8 **BOM** + CRLF + RFC 4180 quoting + an apostrophe guard on user-typed
  fields Excel would run as a formula. Not cached, never through the renderer.
- `results.pdf` — landscape A4, page-numbered, repeating `table.header`, with
  `[DQ]`/`(ảo)` marks on the rows that keep their place.
- `certificates.pdf?top=N|username=…` — one A4 landscape "GIẤY CHỨNG NHẬN" /
  "CERTIFICATE OF ACHIEVEMENT" each; issuer = the contest's orgs (D56) else
  `DuckOJ`, dated by the contest's **end**.

Both PDFs cache 60 s on a hash of the document (D48's design). Web: two
organiser links (`canEdit && phase === 'finished'`), vi + en.
New: `statements/results{,.cache}.ts`, `contests/results-{csv,service}.ts`,
`authz/participant-orgs.ts`, `test/contest-results.spec.ts`. Edited: the
contests controller/module, `markdown-to-typst.ts` (export `escapeText`),
`app.setup.ts`, `contracts/src/contests.ts`, the regen pair, the contest route,
both catalogues, `DECISIONS.md`.

## Tests — 39 in `contest-results.spec.ts`
Pure builders; real typst compiling both documents, including ones made of
nothing but typst syntax typed into a display name; then the routes on
`testDbUrl()`, seeded with a clean live entrant in a school, a disqualified
live entrant and a virtual replay. Mutation checks, each red then restored:
drop the BOM (6 red) · drop the formula guard (1) · drop DQ rows from the CSV
(1) · `cell()` stops escaping (2) · certificate dated `new Date()` (1) ·
remove the `canRunContest` gate (3) · remove the certificate eligibility
filter (1) · remove the `top` bounds (1). Two of them exposed **assertions
passing for the wrong reason** (`3bb63eb`): the exclusion test matched
`awards-binh` against raw typst, but `escapeText` escapes `-`; and the
anonymous test credited the absent `@Public()` when `@CurrentActor()`'s own
fail-closed 401 was doing the work.
Ritual green on the final pass: api 792/792 (89 files), web 340/340, all other
packages green; typecheck + lint (+ `:scripts`) clean, regen leaves no diff,
`vite build` OK.

**Rulings:** all nine are in **D71**. The load-bearing one — the gate is the
PERSON, not the clock: these are the live unfrozen board, so "after
`end_time`, anyone" leaks what D22/D23 hide; "after the end" lives in the web.

## Concerns
- **Deviation:** `authz/**` is outside the touch list, but `org_members` is
  guarded and the runbook forbids reaching it elsewhere; added one additive
  free function in `org.visibility.ts`'s shape — no edit to
  `contest.access.ts`, no module registration.
- **Deviation:** `app.setup.ts`, two lines — `cors-exposed-headers.spec.ts`
  derives from source and failed on the new `X-*-Cache` headers.
- No web test for the links (`apps/web/test/**` outside the touch list).
- Full suites flake under load: three runs each failed a *different* set of
  first-in-file tests, every one green in isolation.
- `certificatesDocument` resolves the contest twice (`getVisible` for orgs);
  and a contracts mutation lied until `tsc -b` reran (the api resolves
  `@duckoj/contracts` through `dist/` — the runbook's known wart).
