import { Marked, type Tokens, type TokenizerAndRendererExtension } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
// `katex.renderToString` emits both a hidden MathML copy (for
// accessibility/copy-paste) and the visible HTML rendering; this stylesheet
// is what actually hides the MathML one. Without it every formula would
// render twice in a real browser — wrong content, not just unstyled
// content. jsdom's tests can't see this (they only assert the output
// contains "katex"), so this import has no test coverage of its own —
// confirmed instead by `vite build` emitting the KaTeX CSS and font assets
// (see apps/web's build output), not by rendering the page.
import 'katex/dist/katex.min.css';

// Problem statements are stored as raw, author-controlled Markdown (spec
// §3.4) and rendered client-side into the DOM via
// `dangerouslySetInnerHTML` — see problem.tsx. That makes this module a
// security boundary, not a formatting helper: any HTML that survives to its
// return value runs in the viewer's browser. `DOMPurify.sanitize` MUST run
// last, after both Markdown and maths have already produced their HTML —
// sanitizing the raw Markdown *first* and then rendering it would strip
// nothing (Markdown source rarely contains literal `<script>` tags in a
// form DOMPurify's HTML parser would even recognise) and then hand the
// unsanitized rendered HTML straight to the DOM, re-introducing everything
// a naive ordering looks like it removed. See test/markdown.spec.ts, whose
// three XSS cases are the actual point of this file.

// A single non-greedy inline `$...$` span, one line only (no `$$` block
// maths — statements are short problem text, not papers). Matched before
// marked's other inline rules via the extension below.
const INLINE_MATH = /^\$([^$\n]+)\$/;

interface MathToken extends Tokens.Generic {
  type: 'inlineMath';
  text: string;
}

const mathExtension: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    return src.indexOf('$');
  },
  tokenizer(src) {
    const match = INLINE_MATH.exec(src);
    if (!match) return undefined;
    return {
      type: 'inlineMath',
      raw: match[0],
      text: match[1]!.trim(),
    } satisfies MathToken;
  },
  renderer(token) {
    const { text } = token as MathToken;
    try {
      // `throwOnError: false` still returns markup for the parts KaTeX
      // could parse and renders the rest as KaTeX's own inline error
      // span — never lets a malformed formula take down the whole
      // statement.
      return katex.renderToString(text, { throwOnError: false });
    } catch {
      // Belt and braces: renderToString can still throw for inputs
      // `throwOnError: false` doesn't cover (e.g. genuinely broken
      // internal state), so fall back to the escaped source rather than
      // letting one bad formula fail the entire statement render.
      return text;
    }
  },
};

/**
 * Statement headings are demoted one level: `#` renders as `<h2>`, not `<h1>`.
 *
 * The problem page already owns the page's single `<h1>` (the problem's name
 * and code, see problem.tsx). A statement that opens with `# Title` — which is
 * a completely ordinary way to write one — would otherwise put a SECOND `<h1>`
 * on the page, breaking the heading hierarchy that screen readers navigate by
 * and making the document outline claim two top-level sections.
 *
 * Found by the Playwright suite on its first honest run: Chromium reported
 * `getByRole('heading')` resolving to two elements. No jsdom test could have
 * caught it — the markup is identical either way, and only a real accessibility
 * tree makes the conflict visible. `h6` stays `h6` because there is no `h7`.
 */
const markdown = new Marked({
  extensions: [mathExtension],
  renderer: {
    heading({ tokens, depth }) {
      const level = Math.min(depth + 1, 6);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
  },
});

/**
 * Renders a problem statement's raw Markdown (with inline `$...$` maths) to
 * sanitized HTML, safe to hand to `dangerouslySetInnerHTML`. See the module
 * doc comment above for why the sanitize step must run last.
 */
export function renderStatement(source: string): string {
  const html = markdown.parse(source, { async: false });
  return DOMPurify.sanitize(html);
}
