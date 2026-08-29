import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end journeys against the live stack — the whole arc a person walks,
 * not one screen at a time. `smoke.spec.ts` proves each page paints; this
 * proves they connect.
 *
 * Journey 1 only, for now: **register → signed in → the UI is Vietnamese by
 * default (D18) → EN switches it**. The remaining journeys of the P5 brief
 * (submit/verdict, contests, TOTP, phone viewport) belong to that task and
 * are not duplicated here.
 *
 * Registration goes through `/register`, the screen this task added. Until it
 * existed the only way to make an account was `POST /auth/register` by hand,
 * which is what `smoke.spec.ts` still does for its own setup — see the
 * fallback comment inside the test.
 */

/** Fails the test if the page logged an error or failed to fetch a subresource. */
function watchForBrokenRequests(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (msg) => {
    // Chromium emits a URL-less "Failed to load resource" for every non-2xx
    // response; the `response` handler below is the one that can filter
    // precisely, so this duplicate is dropped. (Same reasoning as
    // `smoke.spec.ts`, which owns the original.)
    if (msg.type() !== 'error') return;
    if (msg.text().startsWith('Failed to load resource')) return;
    errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() < 400) return;
    // A signed-out visitor's `GET /auth/me` answering 401 is the app working
    // as designed — every route issues it to decide whether to show a session.
    if (res.status() === 401 && res.url().includes('/auth/me')) return;
    errors.push(`${res.status()} ${res.url()}`);
  });
  return { errors };
}

// One live stack, one database, `workers: 1` — but declared serial anyway so
// a future journey added below cannot silently start sharing state with this
// one out of order.
test.describe.configure({ mode: 'serial' });

test('journey 1: register on the site, land signed in, and switch the UI to English', async ({
  page,
}) => {
  const username = `e2ereg${Date.now()}`;
  const displayName = `Journey ${Date.now()}`;
  const password = 'a-long-enough-password';

  const watch = watchForBrokenRequests(page);

  // The signed-out shell offers the way IN, not just the way back in.
  await page.goto('/problems');
  await page.locator('nav.shell-nav').getByRole('link', { name: /^Đăng ký$/ }).click();
  await expect(page).toHaveURL(/\/register$/);

  await page.locator('#username').fill(username);
  await page.locator('#email').fill(`${username}@example.com`);
  await page.locator('#displayName').fill(displayName);
  await page.locator('#password').fill(password);
  await page.locator('#confirm').fill(password);
  await page.getByRole('button', { name: /^Đăng ký$/ }).click();

  // Fallback, if this ever needs to run against a stack without the register
  // screen: the same account can be made with
  //   await page.request.post('/api/v1/auth/register', {
  //     data: { username, email: `${username}@example.com`, password, displayName },
  //   });
  // followed by the sign-in form at `/`. `smoke.spec.ts` still does exactly
  // that for its own setup. The UI path is the one under test here.

  // `POST /auth/register` mints no cookie — the page chains the sign-in
  // itself, so landing on `/` signed in is the assertion that the chain ran.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('nav.shell-nav').getByText(displayName)).toBeVisible();

  // Vietnamese is the default (D18), with no locale ever chosen here.
  await expect(page.locator('nav.shell-nav').getByRole('link', { name: 'Bài tập' })).toBeVisible();

  // …and the switch is a real switch, not a no-op.
  await page.locator('nav.shell-nav').getByRole('button', { name: 'EN' }).click();
  await expect(page.locator('nav.shell-nav').getByRole('link', { name: 'Problems' })).toBeVisible();

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});
