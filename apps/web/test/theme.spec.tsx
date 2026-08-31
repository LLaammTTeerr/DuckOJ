/**
 * D116 — the manual light / dark / system theme control.
 *
 * Four properties carry this file. The toggle SETS `data-theme` for an
 * explicit choice and CLEARS it for "system", persisting each to
 * `localStorage`; the pre-paint script in `index.html` reads that same key
 * before the bundle runs; and the dark palette is honoured under
 * `[data-theme="dark"]` as well as `prefers-color-scheme`, defined once so
 * the two can never drift.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

const { ThemeToggle, readStoredTheme, applyTheme, setTheme, THEME_STORAGE_KEY } = await import(
  '../src/theme.js'
);

function read(...candidates: string[]): string {
  const found = candidates
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => {
      try {
        readFileSync(candidate);
        return true;
      } catch {
        return false;
      }
    });
  return readFileSync(found!, 'utf8');
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  localStorage.removeItem(THEME_STORAGE_KEY);
});

describe('the theme store', () => {
  it('defaults to "system" and reads back a stored choice', () => {
    expect(readStoredTheme()).toBe('system');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(readStoredTheme()).toBe('dark');
  });

  it('ignores a value it does not recognise', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readStoredTheme()).toBe('system');
  });

  it('does not throw when storage itself throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage is blocked');
      },
    });
    try {
      expect(readStoredTheme()).toBe('system');
      expect(() => setTheme('dark')).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
    // The DOM still reflects the choice even though it could not be persisted.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applyTheme sets the attribute for a scheme and removes it for system', () => {
    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('ThemeToggle', () => {
  it('sets and persists an explicit choice, and clears both for system', async () => {
    render(<ThemeToggle />);
    // Vietnamese default (test/setup seeds the locale): Sáng / Tối / Hệ thống.
    await userEvent.click(screen.getByRole('button', { name: 'Tối' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Tối' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sáng' })).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(screen.getByRole('button', { name: 'Hệ thống' }));
    // System REMOVES the attribute — the absence is what hands the decision
    // back to prefers-color-scheme.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(screen.getByRole('button', { name: 'Hệ thống' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('names the group and marks the active choice with aria-pressed, not colour', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(<ThemeToggle />);
    expect(screen.getByRole('group', { name: 'Giao diện' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sáng' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the pre-paint applier in index.html', () => {
  const html = read('index.html', 'apps/web/index.html');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]!)
    .find((body) => body.includes('duckoj.theme'));

  it('is a blocking inline script in the document head', () => {
    // A deferred module runs AFTER the stylesheet paints the wash, so the
    // applier has to be an inline script, and it has to be in <head>.
    expect(script).toBeDefined();
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('src="/src/main.tsx"'));
  });

  it('applies a stored explicit choice before the bundle runs', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    new Function(script!)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('leaves the attribute off for "system" so the OS scheme decides', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    new Function(script!)();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('never throws when storage is blocked', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage is blocked');
      },
    });
    try {
      expect(() => new Function(script!)()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('the dark palette honours [data-theme="dark"]', () => {
  const tokens = read('src/design/tokens.css', 'apps/web/src/design/tokens.css');
  const app = read('src/app.css', 'apps/web/src/app.css');

  /** The declaration body of the first rule matching `header`. */
  function block(css: string, header: string): string {
    const start = css.indexOf(header);
    expect(start, `missing block: ${header}`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  }

  it('defines the material dark palette once, applied by both triggers', () => {
    // The value lives in exactly one place (the source alias)...
    expect(tokens).toContain('--dark-fg: #e7e9ee;');
    expect(tokens).toContain('--dark-panel: #171b22;');
    // ...and BOTH triggers alias the live token to it. This is the brief's
    // "contrast tokens exist under [data-theme=dark]".
    const attr = block(tokens, ":root:where([data-theme='dark'])");
    const media = block(tokens, ":root:where(:not([data-theme='light']))");
    for (const line of ['--fg: var(--dark-fg);', '--panel: var(--dark-panel);']) {
      expect(attr).toContain(line);
      expect(media).toContain(line);
    }
  });

  it('keeps the two material mapping bodies identical so they cannot drift', () => {
    // Compared as the set of declarations, not verbatim, because the media
    // block is nested one level deeper and so is indented one step further.
    const decls = (body: string): string[] =>
      body
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean);
    const attr = decls(block(tokens, ":root:where([data-theme='dark'])"));
    const media = decls(block(tokens, ":root:where(:not([data-theme='light']))"));
    expect(attr).toEqual(media);
  });

  it('honours the semantic scales (verdict, rank) under [data-theme="dark"] too', () => {
    // A forced-dark reader must get the dark verdict reds and the dark rank
    // ramp, not the light ones on a dark ground (the 2.7:1 failure D67 fixed).
    expect(app).toContain('--dark-rte: #ef6a5f;');
    const attr = block(app, ":root:where([data-theme='dark'])");
    expect(attr).toContain('--rte: var(--dark-rte);');
    expect(attr).toContain('--rank-newbie: var(--dark-rank-newbie);');
  });

  it('keeps the attribute triggers at :root specificity so the solid twin still wins', () => {
    // `:where()` is load-bearing: a bare [data-theme="dark"] would out-specify
    // the later reduced-transparency / @supports collapse blocks and keep
    // translucent glass for a forced-dark reader who reduced transparency.
    expect(tokens).toContain(":root:where([data-theme='dark'])");
    expect(tokens).toContain(":root:where(:not([data-theme='light']))");
    expect(tokens).not.toMatch(/:root\[data-theme='dark'\]\s*\{/);
  });
});
