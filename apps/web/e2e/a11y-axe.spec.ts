import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { adminCredentials } from './credentials.js';

/**
 * An axe-core sweep over the key screens, in light and dark and at phone
 * width, failing on any serious/critical WCAG 2.0/2.1 A/AA violation.
 *
 * Why this exists alongside the jsdom suites: Testing Library asserts the
 * accessibility tree of ONE component the test already suspects. axe walks a
 * whole PAINTED page and finds the violation nobody thought to look for —
 * colour contrast that only a real composite reveals, a landmark missing
 * once the whole shell is assembled, an ARIA attribute that is legal in
 * isolation but wrong beside its neighbours. jsdom paints nothing, so it can
 * see none of it.
 *
 * It runs against `baseURL` like every other e2e spec (the live stack by
 * default; point `E2E_BASE_URL` at a `vite preview` to vet an unshipped
 * build). axe-core is injected from the package rather than a CDN so the run
 * needs no network of its own.
 */

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: string[];
}

/** Inject axe, run it, and return only the serious/critical violations. */
async function scan(page: Page): Promise<Violation[]> {
  await page.addScriptTag({ path: AXE_PATH });
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

const CONFIGS = [
  { name: 'desktop-light', colorScheme: 'light' as const, viewport: { width: 1280, height: 900 } },
  { name: 'desktop-dark', colorScheme: 'dark' as const, viewport: { width: 1280, height: 900 } },
  { name: 'phone-light', colorScheme: 'light' as const, viewport: { width: 390, height: 844 } },
];

const PUBLIC_SCREENS = ['/', '/register', '/problems', '/help', '/contests'];
const AUTH_SCREENS = ['/account/security', '/account/settings', '/submit?problem=aplusb'];

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
}

async function checkScreen(page: Page, path: string): Promise<void> {
  for (const cfg of CONFIGS) {
    await page.emulateMedia({ colorScheme: cfg.colorScheme });
    await page.setViewportSize(cfg.viewport);
    await page.goto(path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const violations = await scan(page);
    expect(
      violations,
      `${path} [${cfg.name}] serious/critical axe violations: ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  }
}

test.describe('axe accessibility sweep', () => {
  for (const path of PUBLIC_SCREENS) {
    test(`no serious/critical violations on ${path}`, async ({ page }) => {
      await checkScreen(page, path);
    });
  }

  test('no serious/critical violations on the authenticated screens', async ({ page }) => {
    const admin = adminCredentials();
    await signIn(page, admin.username, admin.password);
    for (const path of AUTH_SCREENS) await checkScreen(page, path);
  });
});
