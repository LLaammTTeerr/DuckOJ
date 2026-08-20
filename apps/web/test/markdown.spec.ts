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
});
