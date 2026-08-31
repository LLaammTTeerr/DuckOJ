/**
 * Loading, failing and offline, in a real browser (D143–D145).
 *
 * These are the states a contest-day reader on school wifi actually meets,
 * and jsdom cannot see any of them: it does no layout, so it cannot tell that
 * the heading MOVED when the board arrived, and it paints no stylesheet, so
 * it cannot tell the offline banner is invisible.
 *
 * Deliberately driven entirely by `page.route` and plain navigations — no
 * `page.request` writes, no sign-in, no seeding. That is what lets this file
 * run against `vite preview` AND against the live stack unchanged: the API
 * refuses a cookie-authenticated write whose `Origin` is the preview port
 * (D82, `403 csrf_origin`), which is why the four journey specs cannot be run
 * before a deploy. Everything here is a read the mock answers itself.
 */
import { expect, test, type Page } from '@playwright/test';

/** A signed-in viewer, so the screens under test render their real shell. */
const ME = {
  id: 1,
  username: 'hocsinh1',
  displayName: 'Học sinh 1',
  globalRole: 'user',
  email: 'a@b.c',
  emailVerified: true,
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** The API's own failure shape (RFC 7807), as `problem.filter.ts` writes it. */
const SERVER_ERROR = JSON.stringify({
  type: 'about:blank',
  title: 'Internal Server Error',
  status: 500,
  code: 'internal_error',
});

async function signedIn(page: Page): Promise<void> {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }),
  );
}

test.describe('a read that failed', () => {
  test('a 500 on a contest does not say the contest does not exist', async ({ page }) => {
    // The bug this is here for: `apiError(result, fallback)` hands ONE
    // fallback to every status, and this screen's fallback is its not-found
    // sentence — so a broken API told a competitor at the bell that their
    // round is not there.
    await signedIn(page);
    await page.route('**/api/v1/contests/**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/problem+json', body: SERVER_ERROR }),
    );
    await page.goto('/contests/probe-cup');

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Máy chủ đang gặp sự cố');
    await expect(alert).not.toContainText('Không có kỳ thi này');
    // And a way to ask again, which no failing screen in this app had.
    await expect(page.getByRole('button', { name: 'Thử lại' })).toBeVisible();
  });

  test('the retry button actually re-asks', async ({ page }) => {
    await signedIn(page);
    let asked = 0;
    await page.route('**/api/v1/contests/probe-cup', (route) => {
      asked += 1;
      return route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: SERVER_ERROR,
      });
    });
    await page.goto('/contests/probe-cup');
    await expect(page.getByRole('button', { name: 'Thử lại' })).toBeVisible();
    const before = asked;
    await page.getByRole('button', { name: 'Thử lại' }).click();
    await expect.poll(() => asked).toBeGreaterThan(before);
  });
});

test.describe('a read that is still loading', () => {
  test('the scoreboard heading does not move when the board arrives', async ({ page }) => {
    // The measurement, not a proxy for it. Before D143 the whole page was
    // replaced by one grey "Đang tải…" line, so every pixel below it moved
    // when the answer landed — on the screen this app reloads most.
    await signedIn(page);
    let held: (() => void) | null = null;
    await page.route('**/api/v1/contests/*/scoreboard', async (route) => {
      if (held === null) {
        await new Promise<void>((resolve) => {
          held = resolve;
        });
      }
      await route.continue();
    });
    await page.goto('/contests/probe-cup/scoreboard');

    const heading = page.getByRole('heading', { name: 'Bảng điểm' });
    await expect(heading).toBeVisible();
    const whileLoading = await heading.boundingBox();
    // The rows are reserved, not absent.
    expect(await page.locator('.skeleton-row').count()).toBeGreaterThan(0);

    held!();
    await expect(page.locator('.skeleton-row')).toHaveCount(0);
    const whenLoaded = await heading.boundingBox();
    expect(whenLoaded?.y).toBe(whileLoading?.y);
  });
});

test.describe('the connection', () => {
  test('a lost connection is said out loud, above the page', async ({ page, context }) => {
    await signedIn(page);
    await page.goto('/contests');
    await expect(page.getByRole('heading', { name: 'Kỳ thi' })).toBeVisible();
    // Nothing to say while it is up.
    await expect(page.getByText('Mất kết nối.')).toHaveCount(0);

    await context.setOffline(true);
    const banner = page.getByText('Mất kết nối.');
    await expect(banner).toBeVisible();
    // Above the sheet, not buried in it: the reader must meet it before the
    // stale numbers it is about.
    const bannerBox = await banner.boundingBox();
    const sheetBox = await page.locator('main').boundingBox();
    expect(bannerBox!.y).toBeLessThan(sheetBox!.y);

    await context.setOffline(false);
    await expect(page.getByText('Mất kết nối.')).toHaveCount(0);
  });
});
