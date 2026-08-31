# loop-f31 — print stylesheet (D121)

**Status: DONE**

## Shipped
A print stylesheet (`@media print` in `apps/web/src/app.css`, extending D61's
credential block) so a teacher can Ctrl-P the scoreboard, a problem statement
and the submissions list into clean paper. This is NOT D71 (server-rendered
PDFs); it is the on-screen page printed from the browser.

- Hides the glass nav (`.shell-nav`), overflow sheet, `.no-print`, and every
  interactive control (`form/.field/label/button/input/select/textarea`);
  `summary`/`details` kept so an opened editorial prints.
- Forces a LIGHT palette regardless of theme by redefining the colour/material
  tokens on `:root` inside the print block (source order beats the dark-theme
  triggers; only tokens tokens.css declares are named). `* { box-shadow:none;
  backdrop-filter:none }` strips the material.
- Tables survive page breaks: `thead{display:table-header-group}`,
  `tr{break-inside:avoid}`, and — the one real bug — the phone rule
  (`max-width:700px`) fires at A4 width (~680px), so `table{display:table
  !important;overflow:visible}` undoes it or columns clip.
- `@page{margin:12mm}` (no `size`, so paper choice stands). `.badge{color:#000}`
  (D67 glyph carries the verdict monochrome). Link URLs suppressed.
- A print-only header per page (`.print-only`, one i18n key `print.printedOn`
  in both catalogues) names contest/problem + date.

## Files
- `src/app.css` — print block + `.print-only` + `@page` + header-comment inventory
- `src/routes/{contests,problem,submissions}.tsx` — one `<div class="print-only">` each
- `src/i18n/{en,vi}.ts` — `print.printedOn`
- `test/app-css.spec.ts` — print-block assertions (nav hidden / `--fg:#000` /
  `--bg:#fff` / table-header-group / break-inside / table override / `.print-only`)
- `e2e/contest-day.spec.ts` — scoreboard under `emulateMedia('print')`, nav display:none
- `docs/DECISIONS.md` — D121

## Tests
Web typecheck/lint clean; `vitest run --no-file-parallelism` 571/571 pass;
`vite build` green. New CSS test mutation-checked (dropped `--fg:#000` → red).
e2e NOT run (live-stack, outside the required-green set; assertion added).

## Rulings
- e2e proof placed on the scoreboard (contest-day already visits it), matching
  the brief exactly.
- Printed date is render-time (no JS behaviour change).
- Submissions list prints only already-loaded rows (Load-more hidden); scoreboard
  DQ column prints as an empty cell — accepted.
- `contest.data` may be null on the scoreboard (viewer may see board, not detail);
  header degrades to title + date.
