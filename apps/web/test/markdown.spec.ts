import { describe, expect, it } from 'vitest';
import { renderStatement } from '../src/markdown.js';

// This file is the whole point of `renderStatement`: statements are stored
// as raw author-controlled Markdown and rendered into the DOM with
// `dangerouslySetInnerHTML` (see problem.tsx), so `renderStatement` is a
// security boundary, not a formatting helper. The last three tests below
// must be shown to fail against a version of `renderStatement` that skips
// `DOMPurify.sanitize` — see task-11-report.md for the observed failure
// output. An XSS test that passes without the sanitizer is testing
// nothing, and this project has shipped three tests-that-cannot-fail
// before (see the phase's global constraint 7).
describe('renderStatement', () => {
  it('demotes a statement heading so it cannot compete with the page h1', () => {
    // problem.tsx owns the page's single <h1>. A statement opening with
    // `# Title` would otherwise add a second one, which Chromium reported as
    // `getByRole('heading')` resolving to two elements.
    expect(renderStatement('# Title')).toContain('<h2>');
    expect(renderStatement('# Title')).not.toContain('<h1>');
    expect(renderStatement('## Sub')).toContain('<h3>');
    // No h7 exists, so the deepest level saturates rather than emitting one.
    expect(renderStatement('###### Deep')).toContain('<h6>');
  });

  it('renders markdown', () => {
    // `#` now renders as <h2>: statement headings are demoted so they
    // cannot compete with the page's own <h1>. See the demotion test above.
    expect(renderStatement('# Hi')).toContain('<h2');
  });

  it('renders inline maths', () => {
    expect(renderStatement('$x^2$')).toContain('katex');
  });

  it('strips a script tag', () => {
    expect(renderStatement('<script>alert(1)</script>')).not.toContain('<script');
  });

  it('strips an onerror handler', () => {
    expect(renderStatement('<img src=x onerror="alert(1)">')).not.toContain('onerror');
  });

  it('strips a javascript: href', () => {
    expect(renderStatement('[x](javascript:alert(1))')).not.toContain('javascript:');
  });

  // The three above are the payloads this file shipped with. These are the
  // ones a bug hunt actually threw at it — the shapes that get past a naive
  // sanitizer: SVG and MathML (DOMPurify parses both, and KaTeX's own output
  // is MathML, so neither namespace can simply be banned), the mXSS
  // `</noscript>` re-parse, DOM clobbering, and the two URL schemes that
  // look executable. Every one is neutralised; recorded here so the
  // clearance is a test rather than a claim in a report.
  it.each([
    ['an svg onload handler', '<svg onload="alert(1)"></svg>', 'onload'],
    ['an animate that rewrites an href', '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>', 'javascript:'],
    ['html smuggled through annotation-xml', '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>', '<script'],
    ['an iframe srcdoc', '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>', '<iframe'],
    ['an object with a javascript: data url', '<object data="javascript:alert(1)"></object>', '<object'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', '<meta'],
    ['a base tag that would repoint every relative link', '<base href="https://evil.example/">', '<base'],
    ['the noscript mXSS re-parse', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>', 'onerror'],
    // The b21 additions — the same boundary that renders a comment body
    // (problem.tsx routes it through `renderStatement` verbatim), thrown the
    // shapes a discussion invites: an HTML data: URL in a Markdown link, and
    // two event handlers on ordinary elements a comment might carry.
    ['an HTML data: URL in a Markdown link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)', 'data:text/html'],
    ['an ontoggle on details', '<details open ontoggle="alert(1)">x</details>', 'ontoggle'],
    ['an onpointerover handler', '<p onpointerover="alert(1)">x</p>', 'onpointerover'],
  ])('neutralises %s', (_name, source, forbidden) => {
    expect(renderStatement(source)).not.toContain(forbidden);
  });

  // KaTeX runs with its default `trust: false`, so `\href` is not a command it
  // will honour: `throwOnError: false` renders the source as an inert red
  // error, and the `javascript:` string survives only as escaped TEXT inside
  // the MathML node — never as a live `<a href>`. Asserted as the real
  // property (no executable link) rather than the raw substring, which the
  // harmless error text would trip. This is the sanitiser boundary a comment
  // body meets too.
  it('does not turn a KaTeX \\href into an executable link', () => {
    const html = renderStatement('$\\href{javascript:alert(1)}{click}$');
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  });

  it('does not let a form clobber document properties by name', () => {
    // `document.innerHTML` becoming an <input> breaks sanitizers that reach
    // for it later in the same document.
    expect(renderStatement('<form><input name="innerHTML"></form>')).not.toContain('name=');
  });

  it('renders a malformed formula in KaTeX\'s red, never as a crash', () => {
    // `throwOnError: false` plus the extension's own catch. A statement with
    // one bad formula must still render — the author needs to SEE which
    // formula is wrong, and every other reader needs the rest of the page.
    //
    // KaTeX flags the two shapes differently: a PARSE error becomes a
    // `katex-error` span carrying the message in its `title`, while an
    // unknown control sequence is rendered in place as its own literal text.
    // What both share, and what the reader actually perceives, is KaTeX's
    // error red — so that is what is asserted for all three.
    for (const bad of ['$\\frac{1}$', '$\\begin{matrix} 1$', '$\\nosuchmacro{x}$']) {
      const html = renderStatement(bad);
      expect(html, bad).toContain('#cc0000');
      expect(html, bad).not.toContain('<script');
    }
    // And a bad formula does not eat the prose around it.
    const mixed = renderStatement('Trước. $\\frac{1}$ Sau.');
    expect(mixed).toContain('Trước.');
    expect(mixed).toContain('Sau.');
    expect(mixed).toContain('katex-error');
  });

  /**
   * D136. Below 700px `app.css` turns a `<table>` into its own scroll
   * container, which makes CSS generate an anonymous — and therefore
   * unstylable — table box inside it that shrink-wraps to its content: a
   * constraints table's tinted header band then stops short of the well it
   * is painted in (95px short on `/help` at 390px, measured in Chromium).
   * Only a real wrapper restoring `display: table` fixes it, and a
   * statement's tables come from here, not from JSX.
   */
  it('wraps every rendered table so it fills its well on a phone', () => {
    const html = renderStatement('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(html).toContain('<div class="table-wrap" tabindex="0"><table>');
    expect(html).toContain('</table></div>');
    // The wrapper survives DOMPurify — both the class it is selected by and
    // the tabindex that makes an overflowing column keyboard-reachable.
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html.match(/table-wrap/g)).toHaveLength(1);
  });

  it('wraps each of several tables exactly once', () => {
    const html = renderStatement('| a |\n| - |\n| 1 |\n\nprose\n\n| b |\n| - |\n| 2 |\n');
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html.match(/table-wrap/g)).toHaveLength(2);
    expect(html).toContain('prose');
  });
});
