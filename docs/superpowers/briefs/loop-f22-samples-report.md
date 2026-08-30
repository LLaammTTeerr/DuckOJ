# F22 — structured samples: `ProblemDetail.samples`, read out of the package

`GET /problems/{code}` modelled no samples; every client scraped them out of the statement's table
(F20's concern). It now carries **`samples: [{ input, output, explanation, truncated }]`** — the
sample tests' own FILES from the published revision's package, byte for byte, capped at **12
samples / 8 KiB per file**, folded once per package and cached under its **hash**. Files: **new
`packages/statement-samples`** plus `packages/{package-format,polygon-import,prepare,contracts}`,
`apps/api/src/{packages/samples.ts,authz/problem.access.ts,problems/problem-drafts.service.ts}`,
`apps/mcp/src/{samples,tools}.ts`, `apps/oj/src` (`oj problems show <code>`), `apps/web/src/
{routes/problem{,-testdata}.tsx,testdata/pairing.ts,i18n/*,app.css}`, `docs/guide/mcp.md`, **D94**,
openapi + SDK, lockfile. **No migration — 0034 unused.**

## Rulings (argued in D94)
1. **D87's "points 0 in group 0" finds no samples in this repo's own problems.** Every
   `content/problems/*/problem.xml` writes `points="0" group="samples"`, which polygon-import
   numbers group **1**. The rule is now `isSampleTest`: *worth nothing, in a group worth nothing*
   — group 0 stands alone; a real batch qualifies only if the WHOLE batch scores 0, keeping
   `distributePoints`' zero-point member of a scored batch out. D87's literal rule would have
   shipped this dead. `from-revision` prefill fixed to match — it was handing back every imported
   problem's samples as graded cases.
2. **`samples[].explanation` is keyed by the sample's INPUT PATH**, optional, no schemaVersion
   bump. The reader derives files from `tests` and JOINS annotations on, never the reverse, so a
   manifest cannot nominate a jury answer as public.
3. **Cache key is the package hash, no invalidation call** (brief asked problem+revision,
   invalidated on publish) — `bookletCacheKey`'s precedent: a publish stops addressing the key
   rather than needing an invalidation a future publish path could forget. **Every failure answers
   `[]`**, the throw inside the fold so nothing bad is cached; `getStats`/`getEditorial` moved onto
   a private `loadVisible` so neither pays a round trip for samples it never renders.
4. **The hide rule normalises line endings + trailing whitespace before comparing** — a test file
   ends in `\n`, a table cell is trimmed prose, so a byte comparison never matches and the rule
   would be dead code. Same samples, order and notes required; the heading goes when the table was
   its whole body. Anything different stays, so a truncated set hides nothing.
5. **MCP scraper demoted, not deleted**, moved to `@duckoj/statement-samples` because the web needs
   the same reading and a second copy is how two consumers stop agreeing; an empty `samples` falls
   through to it too. `?? []` everywhere: this SDK routinely talks to an older API. **`prepare`'s
   `samples` check `skip`s a package with no samples** — the gate answers "does this package
   deliver what it declares"; failing "no worked example" fails every problem prepared so far.

## Tests — fifteen mutations, each restored green after
sample rule → "group 0 only" → 2 fail · → "points 0 only" → 2 · superRefine dropped → 1 ·
`readArchiveEntries` skips `resume()` → 2 (hang) · polygon ignores `isSample` → 1 · api
cap/truncate/half-sample → 3 · cache bypassed → 1 · fail-closed on a lost blob → 1 · mcp ignores
API samples → 2 · empty list wins → 3 · web renders without hiding → 1 · explanation on a
non-sample → 1 · strict byte compare → 3 · always drop the heading → 2 · prepare skips the answer
check → 1. Suites: package-format 54, statement-samples 12, polygon 19, prepare 57, mcp 77, oj 32,
web 501, contracts 39, api VERIFY_API. `pnpm -r typecheck`, `typecheck:scripts`, `pnpm -r lint`,
`lint:scripts`, contracts/SDK regen (no diff) and `vite build` — all green.

## Concerns
- **Live packages predate the annotation**: every published problem reads `explanation: null` until
  rebuilt. Their tables still match and are hidden, so nothing is lost.
- Samples render **below** the statement as the brief asked, so on a vi+en statement the examples
  now sit after the English section rather than mid-document. Worth revisiting.
- A statement whose vi AND en tables both duplicate loses both plus both headings; the structured
  section is then the only copy — tested and deliberate, but a real change in page shape.
