import { test, expect, type Page } from '@playwright/test';
import { adminCredentials, studentCredentials } from './credentials.js';

/**
 * Contest day on a phone.
 *
 * Everything here is a LAYOUT invariant measured in a real engine at
 * 390x844 — the width most Vietnamese pupils will meet this judge at. jsdom
 * cannot see any of it: it does not lay out, so a column pushed 120px off
 * the right edge and a nav that has silently grown a third row are both
 * invisible to a green unit suite. FE-1's audit found all three of these by
 * hand; this file is what stops them coming back.
 *
 * Signed in as the demo pupil rather than the admin: the submissions list is
 * about a student checking "did it pass?", and an admin sees a different
 * (wider) app.
 */
const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1280, height: 900 };

async function signIn(page: Page): Promise<void> {
  const who = studentCredentials();
  await page.goto('/');
  await page.locator('#identifier').fill(who.username);
  await page.locator('#password').fill(who.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
}

/**
 * The single most important cell on the whole app for a competitor: did the
 * attempt pass? At 390px it used to sit in column six of an eight-column
 * table inside a sideways scroller, ~470px from the left edge of a 390px
 * screen — present in the DOM, absent from the phone.
 */
test('a verdict is on screen without scrolling sideways, at 390px, light and dark', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize(PHONE);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/submissions', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Bài nộp', level: 1 }).waitFor();
    const badge = page.locator('main .badge').first();
    await badge.waitFor();

    const box = await badge.boundingBox();
    expect(box, `[${scheme}] no verdict badge rendered`).not.toBeNull();
    expect(
      box!.x + box!.width,
      `[${scheme}] the verdict badge ends ${String(Math.round(box!.x + box!.width))}px across a 390px screen`,
    ).toBeLessThanOrEqual(PHONE.width);
    expect(box!.x, `[${scheme}] the verdict badge starts off the left edge`).toBeGreaterThanOrEqual(0);

    // Nothing anywhere pushes the page sideways, and the list itself no
    // longer hides columns behind a swipe the reader has to discover.
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(over, `[${scheme}] the document overflows by ${String(over)}px`).toBeLessThanOrEqual(0);

    const hidden = await page.evaluate(() => {
      const table = document.querySelector('main table');
      const wrap = table?.closest('.grid-scroll') ?? null;
      return wrap === null ? 0 : wrap.scrollWidth - wrap.clientWidth;
    });
    expect(hidden, `[${scheme}] ${String(hidden)}px of the list is still behind a sideways swipe`).toBeLessThanOrEqual(0);
  }
});

/**
 * The problem code and the time are the other two cells a student reads, and
 * they must be legible rather than a one-character-per-line tower — which is
 * what an eight-column table does to `duong-di-ngan-nhat` in 60px.
 */
test('the problem code and the time stay legible at 390px', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize(PHONE);
  await page.goto('/submissions', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Bài nộp', level: 1 }).waitFor();

  const info = await page.evaluate(() => {
    const row = document.querySelector('main table tbody tr');
    if (row === null) return null;
    const problem = row.querySelector('a[href^="/problems/"]') as HTMLElement | null;
    const cells = [...row.querySelectorAll('td')].map((td) => {
      const r = td.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
    });
    return {
      problemW: problem === null ? null : Math.round(problem.getBoundingClientRect().width),
      problemH: problem === null ? null : Math.round(problem.getBoundingClientRect().height),
      cells,
    };
  });
  expect(info, 'no submissions to read').not.toBeNull();
  // Two lines of a 13px monospace face is ~40px; a tower of single letters is
  // 100px and up. This is the "did the code get room?" assertion.
  expect(info!.problemH, 'the problem code is stacked into a tower').toBeLessThanOrEqual(48);
  // Every cell ends inside the screen.
  for (const cell of info!.cells) {
    expect(cell.right, `a cell ends at ${String(cell.right)}px`).toBeLessThanOrEqual(PHONE.width);
  }
});

/**
 * The admin's bar is the WIDEST one this app renders — an extra `Quản trị`
 * pill in the resources cluster on top of everything a pupil carries — so it
 * is the one worth measuring. This is the only test here that signs in twice.
 */
test('the admin bar, the widest one, is also one row at 1280px', async ({ page }) => {
  const admin = adminCredentials();
  await page.goto('/');
  await page.locator('#identifier').fill(admin.username);
  await page.locator('#password').fill(admin.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('nav.shell-nav').getByRole('link', { name: 'Quản trị' })).toBeVisible();
  await page.setViewportSize(LAPTOP);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const tops = await page.evaluate(() => {
    const bar = document.querySelector('.nav-bar') as HTMLElement;
    return [...new Set([...bar.querySelectorAll('a, button')].map((el) => Math.round(el.getBoundingClientRect().top)))];
  });
  expect(tops.length, `the admin bar sits on ${String(tops.length)} lines: ${JSON.stringify(tops)}`).toBe(1);
});

/**
 * D76 gave the signed-in desktop bar three clusters on ONE row. Twelve
 * account-cluster items later it was three ROWS at 1280px — a 142px-tall
 * band of chrome above every screen, with "Đăng xuất" alone on the last
 * line. The bar is allowed to wrap on a narrow laptop; it is not allowed to
 * wrap on the width this app is actually used at.
 */
test('the signed-in desktop nav is one row at 1280px', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize(LAPTOP);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' }).waitFor();

  const rows = await page.evaluate(() => {
    const bar = document.querySelector('.nav-bar') as HTMLElement | null;
    if (bar === null) return null;
    const tops = new Set(
      [...bar.querySelectorAll('a, button')].map((el) =>
        Math.round(el.getBoundingClientRect().top),
      ),
    );
    return { distinctTops: [...tops].sort((a, b) => a - b), height: Math.round(bar.getBoundingClientRect().height) };
  });
  expect(rows, 'no .nav-bar on this page').not.toBeNull();
  expect(
    rows!.distinctTops.length,
    `the bar's items sit on ${String(rows!.distinctTops.length)} different lines: ${JSON.stringify(rows!.distinctTops)}`,
  ).toBe(1);
  expect(rows!.height, 'the bar is taller than one row of pills').toBeLessThanOrEqual(70);
});

/**
 * FE-1's finding 12. At <=700px `table { display: block }` makes the table
 * its own scroll container, but the anonymous table box CSS generates inside
 * that block shrink-wraps to its content — so a narrow table's tinted header
 * band stops short of the well it is painted in (95px short on /help at
 * 390px, measured). No CSS reaches an anonymous box; only a real wrapper
 * that restores `display: table` does.
 */
test('a narrow table fills its well at 390px rather than shrink-wrapping', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize(PHONE);
  for (const path of ['/help', '/me/progress']) {
    await page.goto(path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll('table')].map((tb) => {
        const head = tb.querySelector('tr');
        const headW = head === null ? 0 : head.getBoundingClientRect().width;
        return Math.round(tb.getBoundingClientRect().width - headW);
      }),
    );
    expect(short.length, `${path} rendered no tables`).toBeGreaterThan(0);
    for (const gap of short) {
      expect(gap, `${path}: a header band stops ${String(gap)}px short of its well`).toBeLessThanOrEqual(4);
    }
  }
});

/**
 * The signed-in landing page. It used to be two links and a sentence — on
 * contest day it said nothing about the contest. It must now answer "what is
 * happening to me right now" from data the app already has.
 */
test('the signed-in home answers what is happening now', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize(PHONE);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // The reader's own recent verdicts, as badges, on the front page.
  await expect(page.locator('main .home-panel')).not.toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Bài nộp gần đây' })).toBeVisible();
  await expect(page.locator('main .home-panel .badge').first()).toBeVisible();

  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(over, `the home page overflows by ${String(over)}px`).toBeLessThanOrEqual(0);
});
