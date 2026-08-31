import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { adminCredentials, studentCredentials } from './credentials.js';
import { watchForBrokenRequests, type Allowance } from './watch.js';

/**
 * Contest day, end to end, on a 390px phone — and the two fixes F-37 shipped
 * for it (loop FE-6).
 *
 * The four FE loops that redesigned this app for a phone — D134's phase chip,
 * D135's day-aware countdown, D136's submission cards, D138's signed-in home,
 * D148's honest submit button — each measured one screen at a time, at rest,
 * against data that already existed. FE-5 walked the ROUTE through them for
 * the first time and found two holes; F-37 filled both, and could not walk
 * either. That is what this file is now for:
 *
 * - **D151.** `home.tsx` asked `GET /contests` unfiltered — page 1 of an
 *   **id**-ordered list, 25 rows of 125 — so the round a school created this
 *   morning was not in the answer at all. It now asks
 *   `?phase=active&mine=true`. The only test that can tell the fix from the
 *   bug is one whose round is BOTH running now AND off that first page, so
 *   this file **seeds one** (below) rather than walking whatever the stack
 *   happens to be running. FE-5's "it seeds nothing — the point" no longer
 *   holds: seeding nothing is precisely what made its front-page assertions
 *   pass against the broken code, via a month-long test round with id 3.
 * - **D152.** A socket that opened and never acked — or never opened at all —
 *   left the verdict panel blank while the judge graded. Two tests below cut
 *   the live channel in each of those two ways and require the verdict to
 *   arrive anyway, over the polling fallback, with the translated "updating
 *   slowly" line on screen while it does. `page.route` cannot touch a
 *   WebSocket upgrade; `page.routeWebSocket` is what intercepts one.
 *
 * **Meter-safe (D26):** registers nobody. The pupil and the organiser are the
 * accounts in the operator's secrets file, reached by login.
 */
const PHONE = { width: 390, height: 844 } as const;
test.use({ viewport: { ...PHONE } });
// NOT `mode: 'serial'`, which FE-5's version inherited from the older journey
// files. The three tests here share only the round `beforeAll` seeds; each
// signs in for itself and the two D152 walks submit outside any contest. Under
// `serial` a red in the first SKIPS the other two, and a mutation check that
// can only ever show one failure at a time is a worse instrument. The config's
// `workers: 1` already keeps them off each other's stack.

// A judged submission is a compile plus a sandboxed run, and D80's submit
// meter (1 per 10 s) can cost this journey two extra windows on a busy stack.
test.setTimeout(300_000);

const RUN = Date.now();
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const SAME_ORIGIN = { origin: ORIGIN } as const;

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

/** The round this file creates, and which the front page has to find. */
const ROUND_KEY = `fe6-phone-${RUN}`;
const ROUND_NAME = `Vòng điện thoại FE-6 ${RUN}`;
/**
 * Bounded on purpose. This round is built to out-sort every other running
 * contest on the stack (see `seedRound`), which means for as long as it is
 * running it is what every user's home panel names. Forty minutes is longer
 * than this file can possibly take and short enough that the operator's real
 * front page is its own again by the time anyone looks.
 */
const ROUND_MINUTES = 40;

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
/**
 * A cut live channel is the SUBJECT of two tests below, and Chromium reports
 * a refused upgrade on the console. Scoped to that one URL so any other
 * console error still fails the test.
 */
const WS_REFUSED = /WebSocket connection to '[^']*\/ws' failed/;

/** How far the document sticks out past the right edge of the phone. */
async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** A logged-in API context for one actor, cookies and `Origin` carried. */
async function actorContext(username: string, password: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { Origin: ORIGIN },
  });
  const res = await ctx.post('/api/v1/auth/login', {
    headers: SAME_ORIGIN,
    data: { usernameOrEmail: username, password },
  });
  expect(res.ok(), `login ${username}: ${String(res.status())}`).toBe(true);
  return ctx;
}

interface ContestRow {
  key: string;
  startTime: string;
}

/**
 * Create the round the front page has to find, and answer the one question
 * that separates D151's fix from D151's bug.
 *
 * Two properties, both deliberate and both load-bearing:
 *
 * 1. **A high id.** It is created seconds ago on a stack with 125 contests,
 *    so it is nowhere near page 1 of the id-ordered list the panel used to
 *    read. `beforeAll` records that first page and the journey asserts the
 *    absence, because "the panel names a running round" is true of the OLD
 *    code too — `thu-nghiem-1`, id 3, has been running for days.
 * 2. **The earliest start of any round this pupil may enter.** `pickContest`
 *    prefers the running contest that started first, so without this the
 *    panel would name some older round and the test would again be measuring
 *    the stack rather than the fix. The instant is read from the very query
 *    the panel issues, as the pupil, rather than guessed at.
 */
async function seedRound(admin: APIRequestContext, pupil: APIRequestContext): Promise<void> {
  const res = await pupil.get('/api/v1/contests', {
    params: { phase: 'active', mine: 'true', limit: 1 },
  });
  expect(res.ok(), `pupil active contests: ${String(res.status())}`).toBe(true);
  const first = ((await res.json()) as { items: ContestRow[] }).items[0];
  const now = Date.now();
  // One minute ahead of the earliest round the pupil can already enter — or,
  // on an empty stack, simply five minutes ago.
  const startTime = first ? Date.parse(first.startTime) - 60_000 : now - 5 * 60_000;

  const created = await admin.post('/api/v1/contests', {
    headers: SAME_ORIGIN,
    data: {
      key: ROUND_KEY,
      name: ROUND_NAME,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(now + ROUND_MINUTES * 60_000).toISOString(),
      format: 'icpc',
      visibility: 'public',
      problems: [{ code: PROBLEM, points: 100 }],
    },
  });
  expect(
    created.ok(),
    `create ${ROUND_KEY}: ${String(created.status())} ${await created.text()}`,
  ).toBe(true);
}

/** Page 1 of the UNFILTERED list — what `home.tsx` used to read (D151). */
let unfilteredFirstPage: string[] = [];

test.beforeAll(async () => {
  const admin = adminCredentials();
  const pupil = studentCredentials();
  const adminCtx = await actorContext(admin.username, admin.password);
  const pupilCtx = await actorContext(pupil.username, pupil.password);
  await seedRound(adminCtx, pupilCtx);

  // Read AFTER the round exists, and with no `limit` at all, so this is
  // byte-for-byte the request D138 shipped: `GET /contests`, 25 rows, id
  // order. The journey asserts the new round is not in it.
  const res = await pupilCtx.get('/api/v1/contests');
  expect(res.ok(), `unfiltered contests: ${String(res.status())}`).toBe(true);
  unfilteredFirstPage = ((await res.json()) as { items: ContestRow[] }).items.map((c) => c.key);

  await adminCtx.dispose();
  await pupilCtx.dispose();
});

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

  // ── D151: the front page answers "what is happening to me right now" ──
  //
  // The discriminator first, in plain sight: the round the panel is about to
  // name is NOT on page 1 of the id-ordered list. Before F-37 the panel read
  // exactly that page, so a round absent from it was invisible — which is the
  // state every round a school creates on the morning of its own contest is
  // in.
  expect(
    unfilteredFirstPage,
    'the seeded round is on page 1 of the unfiltered list — this run cannot tell D151 fixed from D151 broken',
  ).not.toContain(ROUND_KEY);

  await signIn(page, pupil.username, pupil.password);
  await page.goto('/', { waitUntil: 'networkidle' });

  const panel = page.locator('main .home-panel').first();
  const link = panel.locator('.home-contest a').first();
  await expect(link, 'the front page names no round at all').toBeVisible();
  // By the KEY, not merely "some running round": the href is the only thing
  // that says the panel found the round created a minute ago rather than one
  // the old unfiltered page already carried.
  await expect(
    link,
    'the front page names a different round than the one just created',
  ).toHaveAttribute('href', `/contests/${ROUND_KEY}`);
  await expect(link).toHaveText(ROUND_NAME);

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
  await expect(page.getByRole('heading', { name: ROUND_NAME, level: 1 })).toBeVisible();

  // The round the panel named has to be one the pupil can actually enter —
  // `mine=true` claims exactly that, and a claim the join button then refuses
  // would be worse than the bug it replaced.
  const join = page.getByRole('button', { name: 'Tham gia' });
  await expect(join, 'the round the front page named offers no way in').toBeVisible();
  await join.click();
  await expect(page.getByRole('status').filter({ hasText: 'Đang thi chính thức' })).toBeVisible();
  expect(await overflow(page), 'the contest page scrolls sideways at 390px').toBeLessThanOrEqual(0);

  // The contest's own problem table, on a phone. Found by the href and not by
  // the row's text, because the table prints the problem's TITLE ("Tổng hai
  // số") and the code lives only in the link — and because the href is the
  // thing that matters here: it has to carry the contest key, or the attempt
  // is practice and silently never counts.
  const submitLink = page.locator(
    `main table a[href="/submit?problem=${PROBLEM}&contest=${ROUND_KEY}"]`,
  );
  await expect(
    submitLink,
    `the round ${ROUND_KEY} offers no contest submit link for ${PROBLEM}`,
  ).toHaveCount(1);
  await submitLink.click();
  await expect(page).toHaveURL(new RegExp(`contest=${ROUND_KEY}`));

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
  // Nor D152's fallback line: with a working socket the ack lands well inside
  // the six-second deadline, so a "updating slowly" here would mean the live
  // channel is not carrying this stack's verdicts at all.
  await expect(page.getByText(/Đang cập nhật chậm/)).toHaveCount(0);
  await expect(badge.first()).toHaveText('AC', { timeout: 120_000 });

  // ── and back on the list, where the pupil checks it ──────────────────
  await page.goto('/submissions', { waitUntil: 'networkidle' });
  // By the contest LINK, not by the key as text: D-4d's rule is that a
  // contest submission names its contest as a hyperlink, and the visible
  // words are the round's name, not its key.
  const listRow = page
    .getByRole('row')
    .filter({ has: page.locator(`a[href="/contests/${ROUND_KEY}"]`) });
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

/**
 * D152, walked: cut the live channel and require the verdict anyway.
 *
 * **Why the judge has to be slowed down.** This stack grades A+B in about
 * four seconds and the fallback's deadline is six, so an unmodified run would
 * reach the verdict before the fallback ever engaged — `degrade()` no-ops
 * once the submission is terminal, and the "updating slowly" line unrenders
 * the moment the verdict lands. So `GET /submissions/{id}` is held at
 * `grading` (the real response, with two fields rewritten) until the line has
 * been SEEN, and then released: the verdict that finally arrives is the real
 * one, delivered by a real four-second poll over a channel that is genuinely
 * dead. Held only on the detail route — `POST /submissions` has no id in its
 * path and falls straight through.
 *
 * The two cuts are the two failures F-37's report distinguishes, and they are
 * not the same bug: an upgrade that never completes produces a
 * connect→close→reconnect loop faster than any per-attempt timer, while an
 * upgrade that completes and then says nothing produces no events at all. One
 * deadline per submission is what covers both.
 */
type Cut = 'refused' | 'silent';

async function walkFallback(page: Page, cut: Cut): Promise<void> {
  const watch = watchForBrokenRequests(
    page,
    [NOT_JOINED, SUBMIT_METERED],
    [CSP_THEME_BLOCKED, WS_REFUSED],
  );
  const pupil = studentCredentials();

  // Installed before any navigation: the shim that answers `new WebSocket()`
  // is an init script, and the page under test opens its socket the instant
  // a submission id exists.
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    // `refused`: closed at once, so every reconnect in the ladder dies the
    // same way and no ack ever arrives.
    // `silent`: accepted and never spoken to. Not calling `connectToServer`
    // is what leaves it hanging — Playwright answers the handshake itself
    // and nothing is ever forwarded to the gateway.
    if (cut === 'refused') ws.close({ code: 1011, reason: 'no upgrade' });
  });

  let holdVerdict = true;
  await page.route(/\/api\/v1\/submissions\/\d+(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    if (!holdVerdict) {
      await route.fulfill({ response });
      return;
    }
    const body = (await response.json()) as Record<string, unknown>;
    // A judge that is still working: a non-terminal state and no verdict.
    // Everything else is the server's own answer, so the panel renders the
    // real submission rather than a fixture. Rebuilt rather than passed as
    // `response` with overrides, so no `content-length` from the original
    // answer survives beside a body of a different size.
    await route.fulfill({
      status: response.status(),
      contentType: 'application/json',
      body: JSON.stringify({ ...body, state: 'grading', verdict: null, frozen: false }),
    });
  });

  await signIn(page, pupil.username, pupil.password);
  await page.goto(`/submit?problem=${PROBLEM}`);
  const editor = page.locator('.cm-content');
  await editor.waitFor({ state: 'visible' });
  await editor.fill(AC_SOURCE);

  const slow = page.getByText(/Đang cập nhật chậm/);
  const status = page.getByText(/^Trạng thái:/);
  const cooldown = page.getByRole('alert').filter({ hasText: 'quá nhanh' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.getByRole('button', { name: 'Nộp bài', exact: true }).click();
    await expect(status.or(cooldown).first()).toBeVisible({ timeout: 20_000 });
    if (await status.first().isVisible()) break;
    await page.waitForTimeout(11_000);
  }

  // The line a pupil must get when the channel is dead: it says the judging
  // is still happening and that the page is asking — not "refresh", which is
  // what `liveUnavailable` says and what D152 refused to reuse.
  await expect(slow, 'the dead live channel is silent — the panel just sits there').toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/Không nhận được cập nhật trực tiếp/)).toHaveCount(0);
  // Nothing has been graded yet as far as this page can tell, which is the
  // state the line is describing.
  await expect(page.locator('main .badge')).toHaveCount(0);

  // Let the real verdict through. Nothing else changes: no socket, no
  // navigation, no click — only the four-second poll the fallback started.
  holdVerdict = false;
  await expect(page.locator('main .badge').first()).toHaveText('AC', { timeout: 120_000 });
  // And the line goes away, because "updates are slow" describes nothing once
  // the answer is on the screen.
  await expect(slow).toHaveCount(0);

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
}

test('D152 — a /ws upgrade that never completes still gets the pupil their verdict', async ({
  page,
}) => {
  await walkFallback(page, 'refused');
});

test('D152 — a /ws socket that opens and never speaks still gets the pupil their verdict', async ({
  page,
}) => {
  await walkFallback(page, 'silent');
});
