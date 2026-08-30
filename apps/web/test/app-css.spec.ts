import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `app.css` as data, asserted with jsdom's own cascade.
 *
 * The stylesheet is the only place several real defects can live — a rule
 * that names a variable nothing defines, or a blanket `width: 100%` that
 * catches a control it was never meant for — and none of them are visible to
 * a component test, which renders markup jsdom never lays out. Injecting the
 * real file and reading `getComputedStyle` is the cheapest honest check:
 * jsdom does resolve the cascade and attribute selectors, it simply does not
 * do layout, so these assertions are about the DECLARED value, which is
 * exactly what the bugs below are.
 */
// Resolved from the cwd rather than `import.meta.url`: under the jsdom
// environment `import.meta.url` is an `http://localhost/` URL, not a `file:`
// one, so `fileURLToPath` throws. Both candidates are tried because vitest's
// cwd is the workspace root when the suite is run with `-r`.
const CSS_PATH = ['src/app.css', 'apps/web/src/app.css']
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate));
const CSS = readFileSync(CSS_PATH!, 'utf8');

function withStylesheet(html: string): HTMLElement {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.head.querySelectorAll('style').forEach((el) => {
    el.remove();
  });
  document.body.replaceChildren();
});

describe('app.css', () => {
  it('does not stretch a checkbox to the full width of its label', () => {
    // `input { width: 100% }` (the "--- forms ---" rule) is written for text
    // boxes, but it has no type filter, so it also caught every
    // `type="checkbox"` in the app. On the problem list's topic filter that
    // rendered twenty-five 100–156px-wide checkboxes, each one painted over
    // the label text beside it — measured on the live stack at both 1280px
    // and 390px, where it also pushed the page 64px wider than the viewport.
    const host = withStylesheet(
      '<fieldset><label><input type="checkbox" /> Đồ thị</label></fieldset>',
    );
    const box = host.querySelector('input[type="checkbox"]')!;
    expect(getComputedStyle(box).width).not.toBe('100%');
  });

  it('does not stretch a radio button either', () => {
    const host = withStylesheet('<fieldset><label><input type="radio" /> icpc</label></fieldset>');
    const box = host.querySelector('input[type="radio"]')!;
    expect(getComputedStyle(box).width).not.toBe('100%');
  });

  it('still stretches an ordinary text box', () => {
    // The guard on the fix: narrowing the rule must not stop the form fields
    // it was written for from filling their column.
    const host = withStylesheet('<input id="q" />');
    expect(getComputedStyle(host.querySelector('input')!).width).toBe('100%');
  });

  it('names no custom property that the stylesheet never defines', () => {
    // `.dq td { color: var(--muted, inherit) }` shipped naming a variable
    // that does not exist — the fallback always won, so the disqualified-row
    // styling was dead. Any future typo in a variable name is the same class
    // of silent no-op.
    const declared = new Set([...CSS.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
    const used = new Set([...CSS.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    const undefinedVars = [...used].filter((name) => !declared.has(name!));
    expect(undefinedVars).toEqual([]);
  });
});
