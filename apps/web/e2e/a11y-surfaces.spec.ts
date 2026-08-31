import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { adminCredentials } from './credentials.js';

/**
 * A second axe sweep, over the WEB surfaces added AFTER B-20's a11y pass
 * (loop B-27): the contest header + live countdown (D118), the scoreboard and
 * the organiser monitor, a problem page with its discussion thread (F-26), and
 * the submissions list. B-20's `a11y-axe.spec.ts` covers the sign-in / list /
 * settings screens; this file covers the ones that shipped since, and — the
 * point the theme toggle (D116) made newly load-bearing — it exercises dark
 * BOTH ways: the OS media query (`emulateMedia`) AND the manual
 * `data-theme="dark"` attribute the toggle writes, which are two different CSS
 * triggers over the one `--dark-*` palette.
 *
 * axe is injected the CSP-safe way B-25 established: read from the package and
 * handed to `page.evaluate`, whose isolated world the live `script-src` CSP
 * does not police. Runs against `baseURL` (the live stack by default).
 */

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: string[];
}

async function scan(page: Page): Promise<Violation[]> {
  const present = await page.evaluate(() => 'axe' in window);
  if (!present) await page.evaluate(AXE_SOURCE);
  const violations = await page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const res = await axe.run(document, { runOnly: { type: 'tag', values: tags } });
    return res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
  }, WCAG_AA);
  return violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

// A running public contest and the seeded public problem, both live. The org
// carries a team, so its page shows the D99 team panel and the team has a
// TeamPage — both admin-visible.
const CONTEST = 'thu-nghiem-1';
const PROBLEM = 'aplusb';
const ORG = 'bh19-school-1';
const TEAM = 'bh19-doi';

// Each screen names an element that MUST be visible once it has really
// loaded, so an error/404 page (which is also axe-clean) cannot pass as a
// green sweep.
const SCREENS: Array<{ path: string; ready: (p: Page) => Promise<unknown> }> = [
  { path: `/contests/${CONTEST}`, ready: (p) => p.getByRole('timer').waitFor() },
  { path: `/contests/${CONTEST}/scoreboard`, ready: (p) => p.getByRole('heading', { name: 'Bảng điểm' }).waitFor() },
  { path: `/contests/${CONTEST}/monitor`, ready: (p) => p.getByRole('heading', { name: 'Theo dõi trực tiếp' }).waitFor() },
  { path: `/problems/${PROBLEM}`, ready: (p) => p.getByRole('heading', { name: 'Thảo luận' }).waitFor() },
  { path: '/submissions', ready: (p) => p.getByRole('heading', { name: 'Bài nộp', level: 1 }).waitFor() },
  { path: `/orgs/${ORG}`, ready: (p) => p.getByRole('heading', { name: 'Đội tuyển' }).waitFor() },
  { path: `/orgs/${ORG}/teams/${TEAM}`, ready: (p) => p.getByRole('heading', { name: 'Các kỳ thi đã dự' }).waitFor() },
];

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
}

const CONFIGS = [
  { name: 'desktop-light', colorScheme: 'light' as const, theme: null, viewport: { width: 1280, height: 900 } },
  { name: 'desktop-dark-os', colorScheme: 'dark' as const, theme: null, viewport: { width: 1280, height: 900 } },
  { name: 'desktop-dark-toggle', colorScheme: 'light' as const, theme: 'dark' as const, viewport: { width: 1280, height: 900 } },
  { name: 'phone-light', colorScheme: 'light' as const, theme: null, viewport: { width: 390, height: 844 } },
];

async function checkScreen(page: Page, screen: { path: string; ready: (p: Page) => Promise<unknown> }): Promise<void> {
  for (const cfg of CONFIGS) {
    await page.emulateMedia({ colorScheme: cfg.colorScheme });
    await page.setViewportSize(cfg.viewport);
    await page.goto(screen.path, { waitUntil: 'networkidle' });
    // Set (or clear) the manual theme choice, then reload so index.html's
    // pre-paint script applies `data-theme` from it — the real toggle path,
    // rather than stacking one addInitScript per config on the page.
    await page.evaluate((theme) => {
      if (theme) localStorage.setItem('duckoj.theme', theme);
      else localStorage.removeItem('duckoj.theme');
    }, cfg.theme);
    await page.reload({ waitUntil: 'networkidle' });
    await screen.ready(page);
    await page.waitForTimeout(300);
    const violations = await scan(page);
    expect(
      violations,
      `${screen.path} [${cfg.name}] serious/critical axe violations: ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  }
}

test.describe('B-27 web-surfaces a11y sweep', () => {
  test('no serious/critical violations across the new surfaces (light + dark×2 + phone)', async ({ page }) => {
    const admin = adminCredentials();
    await signIn(page, admin.username, admin.password);
    for (const screen of SCREENS) await checkScreen(page, screen);
  });

  /**
   * The page itself must never scroll sideways — on ANY of the three widths
   * this app is designed for, not just the phone.
   *
   * The phone was already guarded (P5 journey 6) by the `max-width: 700px`
   * rule that turns a table into its own scroll container. Nothing guarded
   * the TABLET: at 768px — an iPad in portrait, which is what a school lab
   * has — `/problems` pushed the document 170px wider than the viewport, so
   * the nav, the heading and every other row slid under the thumb together
   * and the last column was simply gone. The three wide data tables now sit
   * in a `.grid-scroll` wrapper that scrolls ITSELF at every width, which is
   * also the only way the columns off the right edge are reachable from a
   * keyboard (WCAG 2.1.1 — a bare scroll container is not a tab stop).
   */
  test('no screen pushes the document sideways, at phone, tablet or laptop width', async ({ page }) => {
    const admin = adminCredentials();
    await signIn(page, admin.username, admin.password);
    const paths = ['/problems', '/submissions', `/contests/${CONTEST}/scoreboard`, `/contests/${CONTEST}`];
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of paths) {
        await page.goto(path, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
        const over = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(over, `${path} at ${width}px overflows the viewport by ${over}px`).toBeLessThanOrEqual(0);
      }
    }
  });

  /**
   * `/submissions` is deliberately NOT in this list any more (D136). It used
   * to be, and the assertion below — "the wrapper does carry the overflow" —
   * was the bug written down as a requirement: at 390px the verdict, the one
   * cell the list exists for, sat 470px across a 390px screen behind a swipe
   * nothing advertised. Its rows are cards on a phone now, so there IS no
   * overflow to carry; `mobile.spec.ts` asserts the replacement invariant
   * (the verdict on screen, the wrapper not scrolling at all). The problem
   * list and the scoreboard keep this contract because they cannot lose it:
   * the scoreboard grows a column per problem, so no phone layout makes a
   * twenty-problem board fit, and reaching those columns from a keyboard is
   * exactly what the tab stop is for.
   */
  test('the wide data tables are keyboard-reachable scroll regions', async ({ page }) => {
    const admin = adminCredentials();
    await signIn(page, admin.username, admin.password);
    for (const path of ['/problems', `/contests/${CONTEST}/scoreboard`]) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const info = await page.evaluate(() => {
        const table = document.querySelector('main table');
        const wrap = table?.closest('.grid-scroll') ?? null;
        return {
          wrapped: wrap !== null,
          tabIndex: wrap?.getAttribute('tabindex') ?? null,
          named: (wrap?.getAttribute('aria-label') ?? '').length > 0,
          // The wrapper, not the page, is what carries the sideways scroll.
          scrolls: wrap ? wrap.scrollWidth > wrap.clientWidth : false,
        };
      });
      expect(info.wrapped, `${path}: the data table has no scroll wrapper`).toBe(true);
      expect(info.tabIndex, `${path}: the scroll wrapper is not a tab stop`).toBe('0');
      expect(info.named, `${path}: the scroll region has no accessible name`).toBe(true);
      expect(info.scrolls, `${path}: the wrapper does not carry the overflow`).toBe(true);
    }
  });

  test('the OS-dark and the toggled-dark paths resolve to the same palette (D116)', async ({ page }) => {
    // Both triggers alias the ONE `--dark-*` source; if they ever diverged the
    // toggle could hand a reader a contrast the media-query path never had.
    await page.goto('/');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/', { waitUntil: 'networkidle' });
    const osBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());

    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => localStorage.setItem('duckoj.theme', 'dark'));
    await page.goto('/', { waitUntil: 'networkidle' });
    const toggleBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());

    expect(osBg).not.toBe('');
    expect(toggleBg).toBe(osBg);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  });

  test('print forces a light ground even when the reader chose dark (D121)', async ({ page }) => {
    const admin = adminCredentials();
    await signIn(page, admin.username, admin.password);
    // The dark toggle is what makes this non-trivial: the print block must beat
    // the `[data-theme="dark"]` trigger by source order, not just the media query.
    await page.addInitScript(() => localStorage.setItem('duckoj.theme', 'dark'));
    const printScreens = [
      { path: `/contests/${CONTEST}/scoreboard`, ready: (p: Page) => p.getByRole('heading', { name: 'Bảng điểm' }).waitFor() },
      { path: `/problems/${PROBLEM}`, ready: (p: Page) => p.getByRole('heading', { name: 'Thảo luận' }).waitFor() },
      { path: '/submissions', ready: (p: Page) => p.getByRole('heading', { name: 'Bài nộp', level: 1 }).waitFor() },
    ];
    for (const screen of printScreens) {
      await page.goto(screen.path, { waitUntil: 'networkidle' });
      await screen.ready(page);
      await page.emulateMedia({ media: 'print' });
      await page.waitForTimeout(200);
      const info = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const nav = document.querySelector('nav.shell-nav');
        return {
          bg: root.getPropertyValue('--bg').trim(),
          fg: root.getPropertyValue('--fg').trim(),
          dataTheme: document.documentElement.getAttribute('data-theme'),
          navDisplay: nav ? getComputedStyle(nav).display : 'no-nav',
        };
      });
      expect(info.dataTheme, `${screen.path} still has the dark choice set`).toBe('dark');
      expect(info.bg, `${screen.path} print ground`).toBe('#fff');
      expect(info.fg, `${screen.path} print ink`).toBe('#000');
      expect(info.navDisplay, `${screen.path} nav hidden in print`).toBe('none');
      await page.emulateMedia({ media: 'screen' });
    }
  });
});
