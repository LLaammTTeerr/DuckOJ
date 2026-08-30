# F6 fix — `booklet.pdf` 500 `statement_pdf_failed` (2026-08-30)

**Root cause.** `content/problems/day-con-tang/statement.md` wraps an inline
formula across a source line — `… Dãy con $a_{i_1}, a_{i_2},` /
`\ldots, a_{i_k}$ với …`. `splitInline` is line-bounded (`[^$\n]+`, deliberately:
exactly what marked does on the web), so that opening `$` never closes on its
line and the LaTeX behind it reaches the tokenizer **as prose**. There
`/^_([^_\n]+)_/` read the subscripts `_{i_` as italics and emitted bare Typst
emphasis delimiters glued to a word (`a_\{i_k\}`); typst decides open-vs-close
from the flanking characters and rejected it with `error: unclosed delimiter`.

**The brief's premise was wrong, in our favour.** `day-con-tang/statement.pdf`
was **also 500** live (curl, before touching anything) — only four of the five
singles were 200. Same lowering, same defect: the booklet was never uniquely
broken, and one fix lands on both routes.

**The fix — two layers, both mutation-checked**, in `markdown-to-typst.ts`:

- **Intraword `_` is not emphasis.** CommonMark, and marked, forbid it on either
  flank. The guard is Unicode-aware (`\p{L}\p{N}`): the corpus flanks `_` with
  `ử` as often as with `a`. Stops the crash *and* the misrendered subscript.
- **Emphasis emits `#strong[…]` / `#emph[…]`, never `*…*` / `_…_`.** Function
  calls have no flanking rule, so nothing this lowering emits can be left open —
  including `x**a**y`, which marked *does* read as strong.

**Left alone, on purpose.** A `$…$` wrapping a line still mis-pairs (`$ với $`
reaches mitex as math) — `apps/web/src/markdown.ts` does the same, and PDF ≠ web
is the worse bug; it compiles. mitex still 500s the whole document on malformed
LaTeX inside a balanced `$…$` (`\frac{`, a lone `}`, an unknown command), where
KaTeX degrades on the web (`throwOnError: false`); separate hazard, own loop.

**Tests.** `contest-booklet.spec.ts` +3: the verbatim `day-con-tang` paragraph,
the `#strong`/`#emph` emission, and the property the 500 broke — **every
`content/problems/*/statement.md` compiles alone AND in a vi and an en booklet**,
plus one booklet of all five, plus a synthetic statement of every typst-special
character with unbalanced `(`/`[`/`{`/`$`/`_` in prose. `statement-pdf.spec.ts`:
two emphasis assertions moved to the function form.
Mutants: guard reverted → paragraph case red; emission reverted → emphasis case
red; both reverted → the corpus property red with the exact live error.
Green: `booklet statement` 31/31, `pnpm -r typecheck`, `pnpm -r lint`. One commit, no migration.
