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

  test('the retry that works puts the round on screen and takes the failure off it', async ({
    page,
  }) => {
    // The half `the retry button actually re-asks` does not reach: it counts
    // requests, which proves the button is wired and nothing about what the
    // reader ends up looking at. A retry that re-asks and then leaves the
    // alert standing over a blank page is the same dead end with an extra
    // click in it — and this is the screen a competitor is on at the bell.
    await signedIn(page);
    // Failing exactly ONE attempt would prove nothing: `retryTransientOnly`
    // already retries a 5xx three times on its own, so the page would recover
    // before the reader ever saw a button. The mock stays broken until the
    // click, which is what makes the click the thing under test.
    let mended = false;
    await page.route('**/api/v1/contests/probe-cup', async (route) => {
      if (mended) return route.continue();
      return route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: SERVER_ERROR,
      });
    });
    await page.goto('/contests/probe-cup');

    const retry = page.getByRole('button', { name: 'Thử lại' });
    await expect(retry).toBeVisible();
    mended = true;
    await retry.click();

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('the server speaks English; the reader is told in Vietnamese, and the English is demoted', async ({
    page,
  }) => {
    // D18 and D145 together. `problem.filter.ts` writes an English `detail`
    // on every failure, and printing it as THE message — which is what
    // `failure.detail ?? failure.code` did across this app — puts an English
    // sentence in a Vietnamese page as the only thing a pupil is told. The
    // rule is that the translated sentence LEADS and the server's own wording
    // survives underneath it, muted, so a teacher on the phone to an operator
    // can still read out what the server actually said.
    await signedIn(page);
    const ENGLISH = 'The upstream grader is not answering right now.';
    await page.route('**/api/v1/contests/**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: JSON.stringify({ ...JSON.parse(SERVER_ERROR), detail: ENGLISH }),
      }),
    );
    await page.goto('/contests/probe-cup');

    const alert = page.getByRole('alert');
    // The headline — the FIRST span, which is what the eye reads — is the
    // translated one, and it is not the English the server sent.
    await expect(alert.locator('span').first()).toHaveText(/^Máy chủ đang gặp sự cố/);
    // The English is present, but only as the muted second line, and named
    // as the server's words rather than the app's.
    await expect(alert.locator('span.muted').filter({ hasText: ENGLISH })).toHaveText(
      `Máy chủ báo: ${ENGLISH}`,
    );
    await expect(page.getByRole('button', { name: 'Thử lại' })).toBeVisible();
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
