# Phase 7b — statement PDFs via typst: ledger

**Unparked by the user** ("install typst", 2026-08-22). typst 0.15.1
installed to `~/.local/bin` from the musl release tarball.

## What shipped

- `apps/api/src/statements/markdown-to-typst.ts` — pure lowering of the
  statement Markdown family (`markdown.ts`'s constructs: headings,
  bold/italic, inline+fenced code, lists, links, inline `$math$`) into a
  Typst document. **Translate what is known, show the rest as escaped
  literal text, never render something wrong** — worst case is visible
  raw Markdown, never dropped or corrupted content.
- Math goes through **mitex 0.2.7** (`#mi(...)`) — real LaTeX
  typesetting, not a hand-rolled LaTeX→Typst translator, which is a
  silent-corruption rabbit hole. mitex 0.2.5 is incompatible with typst
  0.15 (probed); 0.2.7 verified. The import is emitted only when a math
  span exists, so mathless statements never touch the network.
- `StatementRenderer` port (the `Mailer` pattern): `TypstStatementRenderer`
  spawns `TYPST_BIN compile - -` (stdin→stdout, no temp files);
  `NullStatementRenderer` answers 501 `statement_pdf_unavailable`.
- `GET /problems/{code}/statement.pdf` — contract-registered; web
  problem page links it as a plain `<a>`.
- Runbook section: enabling under compose, and the mitex first-compile
  network caveat.

## Rulings

- **R1 — visibility before capability.** `getVisible` runs before the
  renderer: a hidden problem 404s even on a 501 server, or the PDF route
  becomes an existence oracle the JSON route is not. Pinned by a
  mutation that swaps the order (1 fail).
- **R2 — `TYPST_BIN` is explicit config, never PATH-sniffed.** A deploy
  states whether it renders PDFs the same way it states whether it
  sends mail.
- **R3 — CI gates the lowering; the binary run gates locally.** CI has
  no typst; the real-compile tests `skipIf` the binary is absent. What
  CI cannot see is exactly the compile, which the local run proved
  (including the deliberately nasty statement: typst markup in text,
  `\frac` math, raw fences) end-to-end over HTTP to a `%PDF-` body.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| text escaping neutered | 4 fail |
| mitex imported always | 1 fail |
| math rendered as text | 1 fail |
| render before visibility | 1 fail |
| fence content escaped | 1 fail |
| web PDF link mis-URL | 1 fail |

Also: first HTTP-suite run failed on my own seed (missing NOT NULL
revision columns) — the failure was the fixture's, fixed against
`problem-writes.spec.ts`'s canonical seed.
