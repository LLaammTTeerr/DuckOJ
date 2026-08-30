# F17 — a real code editor on the submit page
**DONE.** Web-only; no API, contract, migration or stack change.

## Shipped
- `src/editor/code-editor.tsx` — CodeMirror 6 by hand (line numbers, history,
  bracket matching, active line, `indentWithTab` at 4 spaces, wrap,
  `classHighlighter`); theme entirely from `design/tokens.css`, so dark mode
  and D67's solid twins are free; `Prec.highest` Mod-Enter → submit;
  `aria-label` + `id="source"` on the contenteditable; compartments for
  grammar and font size (a language switch costs no doc/history/cursor).
- `src/editor/lazy.tsx` — the ONLY importer of the editor; `React.lazy` + a
  same-size `Suspense` fallback. `src/editor/languages.ts` — prefix key→mode
  (`c*`→cpp with `cs*` carved out, `py*`, `java*`, else plain) + the three
  starters. `src/editor/drafts.ts` — `(problem, language)` keys under
  `duckoj.draft.v1`, 500 ms debounce, flush on unmount, `clear()` cancels the
  pending write, every access wrapped in try/catch.
- `src/routes/submit.tsx` — `SubmitForm` rewritten: file picker, font-size
  stepper, "Khôi phục bản nháp" notice, counter read off
  `CreateSubmissionRequest.source.maxLength` (65536 UTF-16 units) with the
  button disabled past it; `onSubmit` returns `boolean` (accepted?) so a
  refused submission keeps its draft.
- `app.css` — `--syn-*` scale (light+dark) on `tok-*`, editor chrome, 22rem
  desktop / 40vh at D76's 700px breakpoint; `i18n/{en,vi}.ts`: 9 keys each.

## Tests — 461 web unit tests green (`vitest run --no-file-parallelism`), 11 new in `test/editor.spec.tsx`; `test/setup.ts` stubs `ResizeObserver`, `Range` rects,
`scrollIntoView`, detached-tree `getSelection`. Red→green (mutate, run,
restore): `Prec.highest` dropped + keymap after `defaultKeymap` → Ctrl+Enter
red (`insertBlankLine` won); `clear()` stops cancelling the debounce → draft
resurrected; switch always re-templates → "switch keeps the code" red;
`blocked = props.busy` → 64 KiB+1 submittable; opening buffer ignores the
stored draft → restore red.
`test/submit.spec.tsx` + `e2e/journey.spec.ts` now drive the editor
(`EditorView.dispatch`; Playwright `.cm-content` `.fill()` — journey was the
only `#source` site). e2e NOT run: needs the live stack, which is off-limits.

## Bundle
`code-editor` chunk **505.27 kB (171.28 kB gzip)**, fetched only when a submit
form renders; entry 1,099.40 → 1,105.08 kB (gzip 332.90 → 334.52), measured
by building HEAD~2 and this tree side by side.

## Rulings (all in D84)
1. `LANGUAGES` stays hardcoded `['cpp17']` — `/languages` was read for key
   shape only; wiring it is a different task. 2. A language switch KEEPS the
   buffer; a draft or template lands only in an empty editor — this resolves
   the brief's own tension.
3. Draft cleared only on an ACCEPTED submit — hence `onSubmit: => boolean`.
4. No hidden `<textarea>` twin: a second copy of the buffer is a correctness
   hazard, not an accessibility win. 5. Size counted in UTF-16 code units,
   matching Zod, not bytes. Left out: no persisted editor settings, no
   autocompletion/search.
