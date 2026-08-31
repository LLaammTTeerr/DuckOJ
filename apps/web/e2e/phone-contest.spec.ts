import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { studentCredentials } from './credentials.js';
import { watchForBrokenRequests, type Allowance } from './watch.js';

/**
 * Contest day, end to end, on a 390px phone (loop FE-5).
 *
 * The four FE loops that redesigned this app for a phone — D134's phase chip,
 * D135's day-aware countdown, D136's submission cards, D138's signed-in home,
 * D148's honest submit button — each measured one screen at a time, at rest,
 * against data that already existed. Nothing walked the whole thing: sign in
 * ON the phone, find the round on the front page, open it, submit a program,
 * watch the verdict arrive without leaving the page, read it back off the
 * list. Every screen was proved; the ROUTE through them was not, and the
 * route is what a competitor does.
 *
 * It could not be walked before this loop. It needs cookie-authenticated
 * writes (the join, the submit) and it needs the verdict socket, and against
 * a `vite preview` build the API refused the first with `403 csrf_origin`
 * while vite's SPA fallback swallowed the second — D150, both now closed. So
 * this file runs against EITHER target, and is one of the reasons the preview
 * target had to be made to work.
 *
 * **It seeds nothing.** Not laziness — the point. The round it walks is the
 * one `home.tsx`'s `pickContest` actually names on this stack, reached by
 * clicking the link a pupil sees, rather than one manufactured to be found.
 * A contest created for the occasion would not be on the front page at all
 * (see the report's finding on `GET /contests` paging), so seeding one would
 * have meant walking a path no pupil can walk. **Meter-safe (D26):** it
 * registers nobody, and the pupil is the demo account in the operator's
 * secrets file, reached by login.
 */
const PHONE = { width: 390, height: 844 } as const;
test.use({ viewport: { ...PHONE } });
test.describe.configure({ mode: 'serial' });

// A judged submission is a compile plus a sandboxed run, and D80's submit
// meter (1 per 10 s) can cost this journey two extra windows on a busy stack.
test.setTimeout(300_000);

/**
 * The problem this journey submits against — the seeded demo round's first,
 * and the source is the model solution ON DISK, never a copy typed here: a
 * solution that drifted from the one shipped in `content/` would make this
 * prove something about a program nobody ships. (`journey.spec.ts` reads the
 * same file for the same reason.)
 */
const PROBLEM = 'tong-hai-so';
const AC_SOURCE = readFileSync(
  resolve(process.cwd(), `../../content/problems/${PROBLEM}/solution.cpp`),
  'utf8',
);

/** `GET /contests/{key}/me` 404s until the viewer has joined — by design. */
const NOT_JOINED: Allowance = { status: 404, url: /\/contests\/[^/]+\/me/ };
/** D80 meters submissions at 1 per 10 s; the refused attempt is a real 429. */
const SUBMIT_METERED: Allowance = { status: 429, url: '/api/v1/submissions' };
// D120 — the live stack's Caddyfile predates the CSP hash for index.html's
// pre-paint theme script, so every page there logs one violation. Tolerated
// by its exact text, nothing else. A preview build is served by vite, which
// sets no CSP at all, so this never fires there.
const CSP_THEME_BLOCKED =
  /Executing inline script violates the following Content Security Policy/;

/** How far the document sticks out past the right edge of the phone. */
async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/**
 * Sign in at 390px — which is not the same act as signing in at 1280px and
 * then narrowing the window, the shape every other phone spec here uses. The
 * phone shell has no "Đăng xuất" on the bar at all (D76 puts it behind
 * `Thêm`), so the proof that the session took has to be something the phone
 * actually shows: the signed-in home, which the signed-out one does not have.
 */
async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kỳ thi của bạn' })).toBeVisible();
}

test('a pupil on a phone: the round on the front page, a submit, a verdict, a readable list', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED, SUBMIT_METERED], [CSP_THEME_BLOCKED]);
  const pupil = studentCredentials();

  // ── the front page answers "what is happening to me right now" ───────
  await signIn(page, pupil.username, pupil.password);
  await page.goto('/', { waitUntil: 'networkidle' });

  const panel = page.locator('main .home-panel').first();
  const link = panel.locator('.home-contest a').first();
  await expect(link, 'the front page names no round at all').toBeVisible();
  const roundName = (await link.textContent())!.trim();
  const roundKey = (await link.getAttribute('href'))!.split('/').pop()!;

  // D134's chip, and the glyph that carries the distinction for a reader who
  // cannot see the colour — `.phase.running::before`, so it is content rather
  // than decoration and survives a monochrome print (D46/D77).
  const chip = panel.locator('.phase.running');
  await expect(chip, 'the round on the front page is not running').toHaveText('đang diễn ra');
  const glyph = await chip.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(glyph, 'the running chip has no glyph — colour alone').not.toBe('none');

  // D135's countdown. Asserted by SHAPE, never by value — the clock moves
  // while the test reads it — and the shape allows both branches: the bare
  // `HH:MM:SS` of contest day, and the day-aware form D135 added for the
  // long round ("671:53:57" was the three-digit hour nobody converts).
  const countdown = panel.locator('p.countdown');
  await expect(countdown).toHaveText(/^Kết thúc sau (\d+ ngày )?\d{1,3}:\d{2}:\d{2}$/);

  expect(await overflow(page), 'the front page scrolls sideways at 390px').toBeLessThanOrEqual(0);

  // ── into the round, on a thumb ───────────────────────────────────────
  await link.click();
  await expect(page.getByRole('heading', { name: roundName, level: 1 })).toBeVisible();

  // Joining is conditional because it is a fact about this account and not
  // about the app: the first run of this spec on a stack joins, every run
  // after it is already in. Either way the page has to SAY the pupil is
  // competing before a submission can count.
  const join = page.getByRole('button', { name: 'Tham gia' });
  if (await join.isVisible().catch(() => false)) await join.click();
  await expect(page.getByRole('status').filter({ hasText: 'Đang thi chính thức' })).toBeVisible();
  expect(await overflow(page), 'the contest page scrolls sideways at 390px').toBeLessThanOrEqual(0);

  // The contest's own problem table, on a phone. Found by the href and not by
  // the row's text, because the table prints the problem's TITLE ("Tổng hai
  // số") and the code lives only in the link — and because the href is the
  // thing that matters here: it has to carry the contest key, or the attempt
  // is practice and silently never counts.
  const submitLink = page.locator(
    `main table a[href="/submit?problem=${PROBLEM}&contest=${roundKey}"]`,
  );
  await expect(
    submitLink,
    `the round ${roundKey} offers no contest submit link for ${PROBLEM}`,
  ).toHaveCount(1);
  await submitLink.click();
  await expect(page).toHaveURL(new RegExp(`contest=${roundKey}`));

  // ── the editor, the button, and the verdict ──────────────────────────
  const editor = page.locator('.cm-content');
  await editor.waitFor({ state: 'visible' });
  await editor.fill(AC_SOURCE);
  expect(await overflow(page), 'the editor page scrolls sideways at 390px').toBeLessThanOrEqual(0);

  const badge = page.locator('main .badge');
  const cooldown = page.getByRole('alert').filter({ hasText: 'quá nhanh' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.getByRole('button', { name: 'Nộp bài', exact: true }).click();
    await expect(badge.or(cooldown).first()).toBeVisible({ timeout: 20_000 });
    if (await badge.first().isVisible()) break;
    await page.waitForTimeout(11_000);
  }
  // The app's own "the live feed is down, reload" line must never appear: the
  // verdict below has to arrive over the socket, on the page the pupil is
  // already looking at, with no navigation in between. This is the assertion
  // the `/ws` half of D150 exists for — without the preview proxy it fails
  // here, on a submission the judge has already finished.
  await expect(page.getByText(/Không nhận được cập nhật trực tiếp/)).toHaveCount(0);
  await expect(badge.first()).toHaveText('AC', { timeout: 120_000 });

  // ── and back on the list, where the pupil checks it ──────────────────
  await page.goto('/submissions', { waitUntil: 'networkidle' });
  // By the contest LINK, not by the key as text: D-4d's rule is that a
  // contest submission names its contest as a hyperlink, and the visible
  // words are the round's name, not its key.
  const listRow = page
    .getByRole('row')
    .filter({ has: page.locator(`a[href="/contests/${roundKey}"]`) });
  await expect(listRow, 'the contest submission is not on the list').not.toHaveCount(0);

  // D136's cards, on the variant FE-2 could not measure: a row WITH a contest
  // cell — eight cells rather than seven — which is the widest a submission
  // row gets and the only one a competitor reads under time.
  const rowBadge = listRow.first().locator('.badge').first();
  await expect(rowBadge).toHaveText('AC');
  const box = await rowBadge.boundingBox();
  expect(box, 'the verdict badge is not rendered').not.toBeNull();
  expect(
    box!.x + box!.width,
    `the verdict ends ${String(Math.round(box!.x + box!.width))}px across a ${String(PHONE.width)}px screen`,
  ).toBeLessThanOrEqual(PHONE.width);
  expect(box!.x, 'the verdict starts off the left edge').toBeGreaterThanOrEqual(0);

  expect(
    await overflow(page),
    'the submissions list scrolls sideways at 390px',
  ).toBeLessThanOrEqual(0);
  // Nor behind a swipe INSIDE the list, which is the same bug one level down.
  const hidden = await page.evaluate(() => {
    const table = document.querySelector('main table');
    const wrap = table?.closest('.grid-scroll') ?? null;
    return wrap === null ? 0 : wrap.scrollWidth - wrap.clientWidth;
  });
  expect(hidden, `${String(hidden)}px of the list is behind a sideways swipe`).toBeLessThanOrEqual(
    0,
  );

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});
