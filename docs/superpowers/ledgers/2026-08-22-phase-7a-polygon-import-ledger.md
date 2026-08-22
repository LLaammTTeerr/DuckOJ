# Phase 7a — Polygon import: ledger

## What shipped

- `packages/polygon-import` — `planImport(problemXml)` (pure: XML text →
  manifest + copy plan + skipped list) and `importPolygon(src, dest)`
  (executes the plan, writes `manifest.json`).
- `scripts/polygon-import.ts` (`polygon:import`): extracted polygon dir →
  DuckOJ package dir, then the existing `package:build` path. Smoke-run
  end-to-end through the real `buildPackage` (hash produced).
- `fast-xml-parser` — first dependency of the package; entered the same
  way nodemailer did in 3f.

## Rulings

- **R1 — CLI, not an upload endpoint** (roadmap edited, first draft said
  endpoint): server-side zip ingestion is zip-slip/decompression-bomb
  surface, and the CLI output flows through `buildPackage` →
  `POST /packages`, which already validates. Recorded, not drifted.
- **R2 — refuse loudly what cannot be represented** (the freeze-window
  precedent): `<interactor>`, no `tests` testset, group
  `<dependencies>`, test-count ↔ `<tests>` disagreement — each a
  distinct `PolygonImportError`. Best-effort import of any of them
  silently changes judging or scoring semantics.
- **R3 — points default to 1 apiece, group names → 1..n by first
  appearance.** Polygon omits points on ICPC-style problems; equal
  weights read as all-or-nothing.
- **R4 — statements and solutions are skipped and *said so***, never
  copied into a content-addressed judge-facing archive.
- **R5 — checker language is `cpp17`**, verified against the languages
  seed rather than guessed.

## The honest caveat

**The fixture is synthetic** — it encodes a reading of the Polygon
format, not a Polygon export. The golden method that pins the contest
stack does not apply here; the first real package may falsify the
fixture, and the fixture is what must then move. Parse errors are
worded for exactly that debugging session.

## Findings

- Paths derived from `problem.xml` patterns are validated (no `..`, no
  absolute) *before* any copy — `buildPackage` would catch them later,
  but the importer copies first. Same rule, applied earlier.
- Two unit conversions carry the phase: `time-limit` is already ms;
  `memory-limit` is **bytes** → KB. The 268435456-bytes fixture must
  land as 262144, and the mutation that drops the ÷1024 fails 2 tests.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| bytes used as KB | 2 fail |
| pattern expansion 0-indexed | 4 fail |
| interactor accepted | 1 fail |
| group dependencies accepted | 1 fail |
| safe-path check dropped | 1 fail |
| declared points ignored | 1 fail |
