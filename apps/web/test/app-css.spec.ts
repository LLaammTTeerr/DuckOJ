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
function read(...candidates: string[]): string {
  const found = candidates
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
  return readFileSync(found!, 'utf8');
}

const CSS = read('src/app.css', 'apps/web/src/app.css');
/**
 * The token layer (D67). `app.css` `@import`s it, and jsdom does not follow
 * that import — it never fetches a subresource for an injected <style> — so
 * the cascade assertions below run against `app.css` alone, exactly as
 * before. Only the "no undefined variable" check needs both files, because
 * that check is about the pair: tokens.css DECLARES, app.css CONSUMES, and a
 * typo on either side is the same silent no-op it always was.
 */
const TOKENS = read('src/design/tokens.css', 'apps/web/src/design/tokens.css');

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

  /**
   * The credential sheet (D61), asserted as TEXT rather than through
   * `getComputedStyle`.
   *
   * jsdom resolves the cascade but has no print medium — `@media print` rules
   * never match, so a computed-style assertion here would pass whatever the
   * block contained, including nothing. What can still be checked honestly is
   * that the block exists, that it is the one hiding the shell, and that the
   * table it formats is the one the import panel actually renders.
   */
  it('prints the credential table and hides everything around it', () => {
    const block = /@media print\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain('.shell-nav');
    expect(block).toContain('.no-print');
    expect(block).toContain('.print-credentials');
    // A password is read character by character off this sheet; wrapping it
    // onto a second line is how a pupil types the wrong one.
    expect(block).toContain('white-space: nowrap');
    // A class of forty is two pages, and the second is unreadable without
    // the header repeated.
    expect(block).toContain('display: table-header-group');
  });

  /**
   * The print stylesheet widened to the scoreboard, a problem statement and
   * the submissions list (D121). Same medium caveat as the credential test:
   * jsdom never matches `@media print`, so this reads the block as TEXT. The
   * regex captures the FIRST (and only) `@media print` block, which is the one
   * D121 extended — so both this and the credential test read one block.
   */
  it('prints clean ink on white on any page: hides the nav, forces a light ground, keeps tables whole', () => {
    const block = /@media print\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1];
    expect(block).toBeDefined();
    // The floating glass nav and the overflow sheet are gone from paper.
    expect(block).toContain('.shell-nav');
    expect(block).toContain('.nav-sheet-layer');
    expect(block).toContain('display: none !important');
    // A LIGHT ground regardless of theme: the core colour tokens are forced
    // to ink-on-white so a dark-mode reader does not print white on white.
    expect(block).toContain('--fg: #000');
    expect(block).toContain('--bg: #fff');
    // The printed header shows on paper only.
    expect(block).toContain('.print-only');
    // Tables survive a page break: the header row repeats and no row splits.
    expect(block).toContain('display: table-header-group');
    expect(block).toContain('break-inside: avoid');
    // The phone rule turns a <table> into a block scroller and fires at A4
    // width; it must be undone on paper or columns clip off the right edge.
    expect(block).toContain('display: table !important');
    // Off screen, `.print-only` is nothing (revealed only inside the block).
    expect(CSS).toMatch(/\.print-only\s*\{\s*display:\s*none;/);
  });

  it('names no custom property that the stylesheets never define', () => {
    // `.dq td { color: var(--muted, inherit) }` shipped naming a variable
    // that does not exist — the fallback always won, so the disqualified-row
    // styling was dead. Any future typo in a variable name is the same class
    // of silent no-op. Both files are read: D67 split the material tokens
    // into `design/tokens.css`, so "declared" and "used" now span the pair.
    const both = `${TOKENS}\n${CSS}`;
    const declared = new Set([...both.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
    const used = new Set([...both.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    const undefinedVars = [...used].filter((name) => !declared.has(name!));
    expect(undefinedVars).toEqual([]);
  });

  /**
   * The D67 material has to have a solid twin, and the twin has to be
   * declared once — in the token layer — rather than remembered by each
   * component rule. Two readers depend on it: someone who has asked their OS
   * to reduce transparency, and any browser that cannot composite a backdrop
   * filter at all. Both must get a fully opaque interface, not a half-glass
   * one. Asserted as text because jsdom matches neither at-rule.
   */
  it('collapses every glass token to a solid surface when transparency or backdrop-filter is unavailable', () => {
    const glassTokens = [...TOKENS.matchAll(/^\s*(--glass-(?:bar|sheet|raised))\s*:/gm)].map(
      (m) => m[1]!,
    );
    expect(glassTokens.length).toBeGreaterThan(0);

    for (const guard of [
      /@media \(prefers-reduced-transparency: reduce\)\s*\{([\s\S]*?)\n\}/,
      /@supports not \([\s\S]*?backdrop-filter[\s\S]*?\{([\s\S]*?)\n\}/,
    ]) {
      const block = guard.exec(TOKENS)?.[1];
      expect(block, `no fallback block for ${String(guard)}`).toBeDefined();
      for (const token of new Set(glassTokens)) {
        expect(block).toContain(`${token}: var(--panel);`);
      }
      // A blurred backdrop with an opaque tint is wasted compositing, and on
      // the reduced-transparency path it is also the effect that was refused.
      for (const blur of ['--blur-bar', '--blur-sheet', '--blur-chip']) {
        expect(block).toContain(`${blur}: 0px;`);
      }
    }
  });

  /**
   * Reduced motion has to reach every transition, which is only true if
   * every transition names a duration token rather than a literal.
   */
  it('flattens every motion duration under prefers-reduced-motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(TOKENS)?.[1];
    expect(block).toBeDefined();
    for (const token of ['--dur-fast', '--dur', '--dur-slow']) {
      expect(block).toContain(`${token}: 0.01ms;`);
    }
    // Any literal duration in a component rule is a transition the reduced
    // motion setting cannot reach.
    const literalDurations = [...CSS.matchAll(/transition[^;]*?(\d+m?s)\b/g)].map((m) => m[0]);
    expect(literalDurations).toEqual([]);
  });

  it('marks a similarity match with more than colour (WCAG 1.4.1)', () => {
    // D77's `.match` tint is deliberately subtle — measured, it differs from
    // the surrounding inset by ~1.25:1, well under the 3:1 a colour-only
    // distinction needs. The semantic <mark> carries it to a screen reader,
    // but a sighted low-vision or colour-blind reader had colour as the ONLY
    // cue. A non-colour cue (an underline) makes the region perceivable
    // without turning the columns into a highlighter pen.
    const host = withStylesheet('<pre class="side"><mark class="match">x</mark></pre>');
    const mark = host.querySelector('.match')!;
    expect(getComputedStyle(mark).textDecorationLine).toContain('underline');
  });

  it('gives every contest phase its own glyph, not just its own weight (D134)', () => {
    // The running chip is separated from the finished one by ink weight and
    // elevation, which a monochrome print flattens and a low-vision reader
    // may not resolve. The `::before` glyph is the cue that survives both, so
    // each of the three states must HAVE one, and no two may share it (D77 —
    // never signal by colour alone). jsdom does not resolve pseudo-element
    // content, so this reads the rule out of the stylesheet source.
    const glyphs = ['running', 'upcoming', 'finished'].map((phase) => {
      const rule = new RegExp(`\\.phase\\.${phase}::before\\s*\\{[^}]*content:\\s*'([^']+)'`).exec(CSS);
      expect(rule, `.phase.${phase}::before has no glyph`).not.toBeNull();
      return rule![1];
    });
    expect(new Set(glyphs).size, `two phases share a glyph: ${glyphs.join(' ')}`).toBe(3);
  });

  it('gives the live countdown tabular digits so it does not reflow each second (D118)', () => {
    // formatCountdown re-renders HH:MM:SS once a second; proportional digits
    // would change the line width every tick and jitter the header. jsdom's
    // computed-style layer does not resolve font-variant-numeric, so this
    // asserts the rule against the source directly.
    expect(CSS).toMatch(/\.countdown\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it('gives every submissions column a place in the phone card (D136)', () => {
    // The card layout is driven entirely by `data-col` on each `<td>`: the
    // markup names a column, the stylesheet gives it a grid area. A cell
    // whose name has no rule lands in `grid-auto-flow`'s next free slot —
    // silently, in the right THEME and the right language, so nothing but a
    // 390px screenshot would ever show it. This is the drift guard: every
    // name the component emits must be placed, and every area the grid
    // declares must be claimed by a name.
    const source = read('src/routes/submissions.tsx', 'apps/web/src/routes/submissions.tsx');
    const emitted = [...source.matchAll(/data-col="([a-z]+)"/g)].map((m) => m[1]!);
    expect(emitted.length, 'submissions.tsx emits no data-col at all').toBe(8);

    const placed = new Set(
      [...CSS.matchAll(/td\[data-col='([a-z]+)'\]\s*\{\s*grid-area/g)].map((m) => m[1]!),
    );
    for (const name of emitted) {
      expect(placed.has(name), `data-col="${name}" has no grid-area rule`).toBe(true);
    }

    // And the areas the template names are exactly those eight — a template
    // naming an area no cell claims collapses that track to nothing.
    const template = /grid-template-areas:\s*([^;]+);/.exec(CSS);
    expect(template, 'the card grid declares no template areas').not.toBeNull();
    const areas = new Set(template![1]!.match(/[a-z]+/g) ?? []);
    expect([...areas].sort()).toEqual([...new Set(emitted)].sort());
  });
});
