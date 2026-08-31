/**
 * D147's dirty guard, against the REAL router.
 *
 * Every unit test of `useDirtyGuard` mocks `@tanstack/react-router`, so all of
 * them prove is that the hook passes the options it means to. Whether
 * TanStack actually calls `shouldBlockFn` on a `<Link>` click, whether the
 * `window.confirm` inside it is honoured, and — the one that would be a real
 * regression — whether the guard blocks the navigation a SUCCESSFUL SAVE
 * makes, are facts about the router and can only be measured in a browser.
 *
 * The save's POST is answered by `page.route`, not by the API: that keeps this
 * file free of writes, so it runs against `vite preview` and against the live
 * stack unchanged (D82 refuses a cookie-authenticated write whose `Origin` is
 * the preview port). FE-3's states.spec pattern.
 */
import { expect, test, type Page } from '@playwright/test';

/** A setter, so `/contests/new` renders its form rather than a sign-in. */
const ADMIN = {
  id: 1,
  username: 'duckadmin',
  displayName: 'Quản trị',
  globalRole: 'admin',
  email: 'a@b.c',
  emailVerified: true,
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

async function asSetter(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ADMIN) }),
  );
  // The org picker asks for these; an empty page is a valid answer and keeps
  // the form's own state the only thing under test.
  await page.route('**/api/v1/orgs?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
}

async function openDirtyForm(page: Page): Promise<void> {
  await page.goto('/contests/new');
  const name = page.locator('#name');
  await name.waitFor();
  await name.fill('Vòng tỉnh 2026');
}

test.describe('an unsaved contest is not lost to a click', () => {
  test('leaving is a question: declining stays, accepting goes', async ({ page }) => {
    await asSetter(page);
    await openDirtyForm(page);

    // Declined — the setter meant to keep typing.
    let asked = 0;
    const decline = (dialog: { dismiss: () => Promise<void> }): void => {
      asked += 1;
      void dialog.dismiss();
    };
    page.on('dialog', decline);
    await page.getByRole('link', { name: 'Hủy' }).click();
    await expect(page.locator('#name')).toHaveValue('Vòng tỉnh 2026');
    expect(asked, 'the guard never asked before throwing the work away').toBe(1);
    expect(new URL(page.url()).pathname).toBe('/contests/new');

    // Accepted — they really do want to leave.
    page.off('dialog', decline);
    page.on('dialog', (dialog) => void dialog.accept());
    await page.getByRole('link', { name: 'Hủy' }).click();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/Kỳ thi mới/);
    expect(new URL(page.url()).pathname).toBe('/contests');
  });

  test('an untouched form asks nothing', async ({ page }) => {
    await asSetter(page);
    await page.goto('/contests/new');
    await page.locator('#name').waitFor();

    let asked = 0;
    page.on('dialog', (dialog) => {
      asked += 1;
      void dialog.accept();
    });
    await page.getByRole('link', { name: 'Hủy' }).click();
    expect(new URL(page.url()).pathname).toBe('/contests');
    expect(asked, 'a form nobody typed into prompted on the way out').toBe(0);
  });

  test('a SAVE is never blocked by the guard protecting what it just saved', async ({ page }) => {
    await asSetter(page);
    // The POST is answered here, so nothing is written and the browser still
    // makes a real request through the app's own client.
    await page.route('**/api/v1/contests', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ key: 'vong-tinh-2026' }),
      });
    });
    // …and the contest page it lands on.
    await page.route('**/api/v1/contests/vong-tinh-2026', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"stub"}' }),
    );

    await openDirtyForm(page);
    await page.locator('#key').fill('vong-tinh-2026');
    await page.locator('#start').fill('2027-09-01T09:00');
    await page.locator('#end').fill('2027-09-01T14:00');

    // If `release()` did not disarm the guard synchronously, this prompt
    // would fire and the save's own navigation would be refused.
    let asked = 0;
    page.on('dialog', (dialog) => {
      asked += 1;
      void dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Tạo kỳ thi' }).click();

    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .toBe('/contests/vong-tinh-2026');
    expect(asked, 'the guard challenged the navigation that saved the work').toBe(0);
  });
});
