# F21 — `packages/prepare`: the problem-preparation gate and publisher

**DONE.** One pipeline from a prepared directory to a live problem, as a library plus a
CLI: `corepack pnpm prepare <problem-dir>`. **Shipped:** `packages/prepare/src/`:
`load{,-polygon,-skills}.ts` (both layouts detected, normalised into one
`PreparedProblem`), `statement.ts`, `solution-meta.ts`, `classification.ts`, `flags.ts`,
`toolchain.ts` (g++, `timeout`, `ulimit -v`, testlib lookup), `judge.ts`, `validate.ts`
(the gate), `package.ts`, `publish.ts`, `stress.ts`, `cli.ts` — plus
`scripts/prepare.ts` and the root `prepare` script, `.gitignore` for
`prepare-report.json`, a pointer in `content/README.md`, `docs/guide/chuan-bi-de.md` (vi
+ en), **D90**.

**Tests — 54, green.** `detect.spec.ts` (28) layouts, both loaders, refusals,
classification, statement shapes, `@expect` blocks, points split · `validate.spec.ts`
(17) ready problem, missing/empty answer, checker that will not compile, model that
disagrees or will not compile, matrix hole, unknown group, no English section, nonsense
limit, blocking and resolved flags, a bad validator · `package.spec.ts` (5) incl. **hash
identity with `polygon:import` + `package:build`** · `stress.spec.ts` (4). Fixtures
`polygon-good`, `polygon-checker` (plain-C++ checker — CI needs no testlib or network)
and `skills-zoo`, each broken case a named mutation of one cloned to a temp dir.
Mutation checks (red→green, restored): dropping the empty-answer rule,
`verdictSatisfies` accepting any `OK`, `distributePoints` dropping the remainder,
`packageProblem` not cleaning its output — each turned exactly its own test red. Full
ritual green (typecheck ×2, lint ×2, `-r test`, regen no diff, web build).

**Live e2e** (localhost:8080, token for `duckadmin`): `prepare publish
content/problems/so-nguyen-to --code prep-20260830-222437 --publish --visibility public`:

    [x] statement Vietnamese + English · [x] limits 2000 ms / 262144 KB · [x] tests 12/12
    [x] manifest 12 test(s) in 3 group(s), checker standard · [ ] flags/checker/validator/matrix n/a
    [x] model reproduces all 12 answer(s); slowest run 110 ms vs a 2000 ms limit
    READY  package 388230da82a9…c111e6b0 (639 bytes) · created prep-20260830-222437
      patched statement + tags so-hoc, mo-phong · attached and published revision 1

Re-run unchanged: `revision 1 already carries package 388230da82a9` / `(unchanged
package, nothing attached)`. `GET` shows visibility public, difficulty 3, tags
`mo-phong, so-hoc`, 12 tests; the revision row reads `state: "published"`, `totalPoints:
100`. (`publishedVersion` comes back `null` there for EVERY problem on this stack —
pre-existing, not investigated.)

**Rulings (all argued in D90).** Publish via `POST /packages` + `/revisions`, NOT D87's
drafts despite drafts costing one scope to this path's two: `DraftFileName` is flat, so
`tests/01.in` and `checker/check.cpp` are inexpressible, and flattening changes the hash
— one directory, two hashes, the drift D87 exists to stop. · Idempotency is a hash
comparison against the revision list. · Only an unresolved HIGH `statement-ambiguity`
blocks; `"resolved": true` clears it. · A `.tex`-only directory is refused, naming the
files that fix it. · `wcmp`/`ncmp` → `{"kind":"standard"}`, other stock checkers vendored
as testlib sources (D40). · Subtask points split so the batch sums exactly;
`depends_on` and file IO refused. · TLE is wall-clock at 2×; a declared `ML` is
satisfied by an observed `RE` (`ulimit -v` cannot tell them apart). · A stress generator
is `<gen> <seed>` → one case on stdout. · The problem ROW's name comes from the
statement heading; the hashed manifest keeps `planImport`'s.

**Concerns.** `prepare` is an npm lifecycle name: `pnpm install` runs the root script, so
it exits 0 silently on zero args and checks argv *before* any `@duckoj/*` import (dist
does not exist at install time) — verified against `corepack pnpm install --offline`;
`--help` prints the usage. · Needs `packages/*/dist`, so run after a `-r typecheck` on a
fresh clone. · `apps/web/test/editor.spec.tsx` failed once under the parallel `-r test`,
then passed alone and on a full `@duckoj/web` re-run (482 tests): a flake, untouched
here. · No `apps/mcp` work; the library prints nothing and exports every step.