import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  expect,
  request as playwrightRequest,
  test,
  type Browser,
  type Page,
} from '@playwright/test';
import { adminCredentials } from './credentials.js';
import { watchForBrokenRequests, type Allowance } from './watch.js';

/**
 * The FEATURE journeys (loop B-14) — everything the F-loop shipped between
 * clarifications and the progress page, walked in a real browser against the
 * live composed stack.
 *
 * `journey.spec.ts` covers the spine: register, submit, judge, contest,
 * freeze, two-factor. Nothing there touches the twelve features below, and
 * every one of their reports closes with the same concern in the same words
 * — "no Playwright journey", "never exercised against the live stack". This
 * file is that exercise. It is deliberately a SECOND file rather than more
 * cases in the first: the two are owned by different loops and merge
 * separately.
 *
 * Same contract as `journey.spec.ts`, and for the same reasons:
 *
 *   - **Serial.** One database, one stack, and later journeys measure what
 *     earlier ones created (the school in 7 is the school in 8 and 11).
 *   - **Zero console errors and zero broken subresources**, per page, through
 *     the shared `watchForBrokenRequests` — with expected 4xx passed in by
 *     route AND status, never blanket-muted.
 *   - **Vietnamese locators** (`playwright.config.ts` sets `vi-VN`, D18), with
 *     content — usernames, problem codes, verdicts — asserted verbatim.
 *   - **Unique names per run**, stamped with `RUN`, so a second run collides
 *     with nothing.
 *
 * Throwaway accounts are `bh14-*` and there are TWO of them, **minted by the
 * admin** since D200: this deployment's rung is `closed` and an anonymous
 * `POST /auth/register` is a 403 here. That also retires the meter arithmetic
 * this paragraph used to carry — D26's 30/IP/hour window bounds the cost of
 * an ANONYMOUS argon2id hash and a trusted registrar skips it entirely
 * (D200), so two is no longer a budget, merely what these walks need. Journey
 * 9 still re-uses the two journeys 4 and 5 mint, and everything that needs a
 * third pupil still uses the three the roster import mints — those come
 * through D61's own path, which never touched this endpoint at all.
 *
 * Two things on the stack are mutated and both are put back in `afterAll`:
 * the editorial journey publishes `tong-hai-so`'s editorial (there is none on
 * the deployment — `content/README.md`'s step 7 was never run), and nothing
 * else. Contests, schools and problem sets this file creates are new rows
 * with `RUN` in their keys; they are left behind exactly as `journey.spec.ts`
 * leaves its contests behind.
 */
test.describe.configure({ mode: 'serial' });

// A judged submission is a compile plus twelve tests through a real sandbox,
// and the results journey waits out a contest clock on top of that.
test.setTimeout(240_000);

const RUN = Date.now();
const PROBLEM = 'tong-hai-so';
const PASSWORD = 'khong-phai-mat-khau-that-dau';
/** What an imported pupil chooses for themselves at the forced change. */
const PUPIL_PASSWORD = 'mat-khau-rieng-cua-em';

/**
 * The model solution ON DISK, exactly as `journey.spec.ts` reads it: a source
 * typed into this file would drift from the program the project ships, and
 * the similarity journey's whole premise is that two pupils hand in the SAME
 * bytes.
 */
const AC_SOURCE = readFileSync(
  resolve(process.cwd(), `../../content/problems/${PROBLEM}/solution.cpp`),
  'utf8',
);

/** The editorial the repository ships and the deployment never published. */
const EDITORIAL = readFileSync(
  resolve(process.cwd(), `../../content/problems/${PROBLEM}/editorial.md`),
  'utf8',
);

/**
 * The site's own origin, for the handful of state changes this file makes
 * through `page.request` rather than through a form.
 *
 * D82 added an Origin/Referer check on every COOKIE-authenticated state
 * change, and Playwright's request context sends no `Origin` of its own — so
 * a signed-in `page.request.patch` is refused 403 `csrf_origin`, exactly as
 * a hostile page would be. A browser sends this header on every unsafe
 * method itself; here it has to be said out loud. (A request made before
 * anyone signs in carries no cookie and is never checked — which is why
 * `register` below works either way, and why it says so anyway.)
 */
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const SAME_ORIGIN = { origin: ORIGIN } as const;

/** `GET /contests/{key}/me` 404s until the viewer has joined — by design. */
const NOT_JOINED: Allowance = { status: 404, url: /\/contests\/[^/]+\/me/ };
/**
 * `/notifications` signed out. The SHELL's bell is `enabled`-gated and never
 * asks, but the notifications ROUTE asks unconditionally and folds 401/403
 * into "nothing to show" (`notificationsQueryOptions`) — deliberately, since
 * gating the query would leave the page spinning on `isPending` forever. So
 * the request is part of that page working, and it is allowed by route and
 * status rather than muted.
 */
const SIGNED_OUT_BELL: Allowance = { status: 401, url: '/notifications' };

interface Account {
  username: string;
  displayName: string;
}

/**
 * A throwaway account through the API, as `journey.spec.ts` does it: the
 * registration FORM is that file's journey 1 and walking it again here would
 * spend a form fill on a user whose only job is to exist.
 *
 * **Minted by the ADMIN (D200).** This deployment decides who may sign up and
 * its rung is `closed`, so the anonymous POST this used to make is a 403. A
 * global admin is the one caller a closed judge still admits, and it is the
 * more faithful rehearsal besides: on a school judge no pupil ever signs
 * themselves up. `organiser.spec.ts` at `91a8402` is the shape this follows.
 *
 * Its own context, never `page.request`: that one shares the page's cookie
 * jar, so a mint through it would be made by whoever the page is signed in as
 * — or would leave the page signed in as the admin behind its own back, which
 * is the bug F-56 found in the fixed-account walks. A fresh `newContext` does
 * not inherit `playwright.config.ts`'s `extraHTTPHeaders`, so `Origin` is
 * named here or D82's `CsrfOriginGuard` refuses the write.
 *
 * Expects 201 and nothing else: `RUN` is in the username, so a 409 would be a
 * real collision rather than a re-run. The account carries no
 * `mustChangePassword` — D61 sets that only for the bulk import, where the
 * SERVER chose the password — so the sign-in each caller chains is ordinary
 * and D102 never bites.
 */
async function register(suffix: string): Promise<Account> {
  const username = `bh14-${suffix}-${RUN}`;
  const displayName = `BH14 ${suffix} ${RUN}`;
  const admin = adminCredentials();
  const ctx = await playwrightRequest.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { Origin: ORIGIN },
  });
  try {
    const signedIn = await ctx.post('/api/v1/auth/login', {
      headers: SAME_ORIGIN,
      data: { usernameOrEmail: admin.username, password: admin.password },
    });
    expect(signedIn.ok(), `admin sign-in to mint ${username}: ${signedIn.status()}`).toBe(true);
    const response = await ctx.post('/api/v1/auth/register', {
      headers: SAME_ORIGIN,
      data: { username, email: `${username}@example.invalid`, password: PASSWORD, displayName },
    });
    expect(response.ok(), `register ${username}: ${response.status()}`).toBe(true);
    return { username, displayName };
  } finally {
    await ctx.dispose();
  }
}

/** Signs in through the real form at `/`, the only sign-in surface there is. */
async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(
    page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' }),
  ).toBeVisible();
}

/** Fills the submit form and waits for the judge over the live socket. */
async function submitAndAwait(page: Page, source: string, verdict: string): Promise<void> {
  await page.locator('#source').fill(source);
  await page.getByRole('button', { name: 'Nộp bài', exact: true }).click();
  await expect(page.getByText(/Không nhận được cập nhật trực tiếp/)).toHaveCount(0);
  await expect(page.locator('.badge')).toHaveText(verdict, { timeout: 90_000 });
}

/** `YYYY-MM-DDTHH:mm` in the local zone — what a `datetime-local` input takes. */
function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Creates a contest through the real form, with one problem on it.
 *
 * Every journey here that needs a contest needs the same six fields filled
 * the same way, and a copy per journey is six chances for one of them to
 * drift out of step with `contest-new.tsx`.
 */
async function createContest(
  page: Page,
  key: string,
  name: string,
  start: Date,
  end: Date,
): Promise<void> {
  await page.goto('/contests/new');
  await page.getByLabel('Mã kỳ thi').fill(key);
  await page.getByLabel('Tên', { exact: true }).fill(name);
  await page.getByLabel('Bắt đầu').fill(localInputValue(start));
  await page.getByLabel('Kết thúc').fill(localInputValue(end));
  await page.getByLabel('Đóng băng (phút)').fill('0');
  await page.getByLabel('Phạm vi').selectOption('public');
  await page.getByLabel('Mã bài 1').fill(PROBLEM);
  await page.getByLabel('Điểm bài 1').fill('100');
  await page.getByRole('button', { name: 'Tạo kỳ thi' }).click();
  await expect(page).toHaveURL(new RegExp(`/contests/${key}$`));
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/screenshots/b14-${name}.png`, fullPage: true });
}

/* ── state shared down the serial chain ──────────────────────────────── */

/** Journey 4's contest, reused by 5 (the editorial mask) and 6 (the booklet). */
let contestKey = '';
/** Journey 9's short contest, measured again by 10 (similarity). */
let shortKey = '';
/** Journey 7's school, filled in by 8 and read again by 11. */
let orgSlug = '';
/** One imported pupil, after they have chosen their own password. */
let pupil: { username: string; password: string } | null = null;
/**
 * All three imported pupils, so journey 8 can check the grid is a CLASS list.
 * Display names as well as usernames: the class grid links a pupil BY
 * username and labels them by the name their teacher typed, so the two
 * screens this journey walks are keyed differently.
 */
let imported: { username: string; displayName: string }[] = [];
/**
 * The two accounts journeys 4 and 5 mint, kept for journey 9 to re-use as its
 * pair of competitors.
 *
 * Registration is metered 30/IP/hour (D26) and this file shares that meter
 * with `journey.spec.ts`'s seven, so four accounts a run was two too many: a
 * 429 in journey 9 stops the file dead having proved nothing about the
 * exports. Nothing about journey 9 wants a FRESH competitor — it wants two
 * people in one contest with the same source in front of them — so it
 * borrows the two who already exist. The cost is that journey 9 can no
 * longer be run on its own with `-g`.
 */
const competitors: Account[] = [];
/** Journey 9's two identical-source competitors, by username. */
const twins: [string, string] = ['', ''];
/** Set by journey 5; restored in `afterAll` — the one mutation of seeded data. */
let editorialPublished = false;

test.afterAll(async ({ browser }) => {
  if (!editorialPublished) return;
  // `editorial: null` clears the text AND unpublishes, in one UPDATE and in
  // the database's own CHECK (D43) — so the problem ends the run exactly as
  // it started rather than as a draft nobody wrote.
  const context = await browser.newContext();
  try {
    const admin = adminCredentials();
    const signedIn = await context.request.post('/api/v1/auth/login', {
      headers: SAME_ORIGIN,
      data: { usernameOrEmail: admin.username, password: admin.password },
    });
    expect(signedIn.ok(), `restoring the editorial: sign-in ${signedIn.status()}`).toBe(true);
    const restored = await context.request.patch(`/api/v1/problems/${PROBLEM}`, {
      headers: SAME_ORIGIN,
      data: { editorial: null },
    });
    expect(restored.ok(), `restoring the editorial: PATCH ${restored.status()}`).toBe(true);
    editorialPublished = false;
  } finally {
    await context.close();
  }
});

/* ── 1 — the guides ─────────────────────────────────────────────────── */

test('feature 1 — /help offers three role guides as tabs, and follows the interface language', async ({
  page,
}) => {
  // F10's own concern, verbatim: "No Playwright journey for `/help`, and
  // nothing ties a guide sentence to the screen it describes." The second
  // half is the last assertion here.
  const watch = watchForBrokenRequests(page);
  await page.goto('/help');

  await expect(page.getByRole('heading', { level: 1, name: 'Hướng dẫn sử dụng' })).toBeVisible();
  const tabs = page.getByRole('group', { name: 'Chọn bản hướng dẫn' });
  await expect(tabs.getByRole('button', { name: 'Học sinh' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The guides are bundled Markdown, so the proof they RENDERED is a heading
  // the pipeline produced — `renderStatement` demotes the guide's own `#` to
  // `<h2>`, which is why the page still has exactly one `<h1>`.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const studentBody = await page.locator('section.panel').innerText();
  expect(studentBody.length, 'the student guide must render prose').toBeGreaterThan(500);

  await tabs.getByRole('button', { name: 'Giáo viên' }).click();
  await expect(tabs.getByRole('button', { name: 'Giáo viên' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(tabs.getByRole('button', { name: 'Học sinh' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const teacherBody = await page.locator('section.panel').innerText();
  expect(teacherBody, 'a tab that changes nothing is not a tab').not.toBe(studentBody);
  await shot(page, 'f1a-help-teacher');

  // Both halves are always on the page (D10) — the switch reorders them, it
  // does not hide one. So the English heading is present in Vietnamese too.
  await expect(page.getByRole('heading', { name: 'English' })).toBeVisible();

  await page.locator('nav.shell-nav').getByRole('button', { name: 'Tiếng Anh' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Guides' })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Choose a guide' }).getByRole('button', { name: 'Teachers' }),
  ).toHaveAttribute('aria-pressed', 'true');
  // The chosen role survives the language switch: it is a different reader,
  // not a different page.
  await shot(page, 'f1b-help-en');

  // Back to Vietnamese, so nothing downstream inherits an English UI through
  // `localStorage`.
  await page.locator('nav.shell-nav').getByRole('button', { name: 'Vietnamese' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hướng dẫn sử dụng' })).toBeVisible();

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 2 — topics and difficulty ──────────────────────────────────────── */

test('feature 2 — the topic and difficulty filters are in the URL, and they AND', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page);

  // What the API itself says the filter means, asked first: asserting on a
  // hardcoded list of codes would make this journey a test of the seed data,
  // and the seed data is the one thing here that legitimately changes.
  const tagged = await page.request.get('/api/v1/problems?tag=quy-hoach-dong&limit=100');
  expect(tagged.ok(), `tag filter: ${tagged.status()}`).toBe(true);
  const taggedCodes = ((await tagged.json()) as { items: { code: string }[] }).items.map(
    (item) => item.code,
  );
  expect(taggedCodes.length, 'seed a dynamic-programming problem or this proves nothing')
    .toBeGreaterThan(0);

  // ── a link a teacher could send to a class ───────────────────────────
  await page.goto('/problems?tag=quy-hoach-dong');
  await expect(page.getByRole('heading', { name: 'Bài tập' })).toBeVisible();
  // The URL seeded the CONTROL, not merely the query: a filter bar that
  // shows every box unticked over a filtered list is how a reader clears a
  // filter they cannot see.
  await expect(page.locator('#tag-quy-hoach-dong')).toBeChecked();
  for (const code of taggedCodes) {
    await expect(page.getByRole('link', { name: code, exact: true })).toBeVisible();
  }
  // `tong-hai-so` carries `mo-phong` and `toan` and never `quy-hoach-dong`.
  await expect(page.getByRole('link', { name: PROBLEM, exact: true })).toHaveCount(0);
  await shot(page, 'f2a-tag-filter');

  // ── difficulty, as two bounds in the URL ─────────────────────────────
  const ranged = await page.request.get('/api/v1/problems?difficultyMin=4&difficultyMax=6&limit=100');
  expect(ranged.ok(), `difficulty filter: ${ranged.status()}`).toBe(true);
  const rangedCodes = ((await ranged.json()) as { items: { code: string }[] }).items.map(
    (item) => item.code,
  );
  expect(rangedCodes.length, 'seed a problem rated 4–6').toBeGreaterThan(0);

  await page.goto('/problems?difficultyMin=4&difficultyMax=6');
  await expect(page.locator('#difficulty-min')).toHaveValue('4');
  await expect(page.locator('#difficulty-max')).toHaveValue('6');
  for (const code of rangedCodes) {
    await expect(page.getByRole('link', { name: code, exact: true })).toBeVisible();
  }
  // Rated 1, so out of a 4–6 page.
  await expect(page.getByRole('link', { name: PROBLEM, exact: true })).toHaveCount(0);
  await shot(page, 'f2b-difficulty-filter');

  // ── and the other direction: a click puts the filter INTO the URL ────
  await page.goto('/problems');
  await page.locator('#tag-do-thi').check();
  await expect(page).toHaveURL(/do-thi/);
  // D35's AND, on the page rather than in a unit test: adding a second topic
  // NARROWS the list. `dsu` is carried by exactly one of the graph problems.
  const graphRows = await page.getByRole('row').count();
  await page.locator('#tag-dsu').check();
  await expect(page).toHaveURL(/dsu/);
  await expect(page.locator('#tag-do-thi')).toBeChecked();
  const bothRows = await page.getByRole('row').count();
  expect(bothRows, 'a second topic must AND, never widen').toBeLessThan(graphRows);

  await page.getByRole('button', { name: 'Xoá bộ lọc' }).click();
  await expect(page.locator('#tag-do-thi')).not.toBeChecked();
  await shot(page, 'f2c-tag-and');

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 3 — the phone ──────────────────────────────────────────────────── */

test.describe('feature 3 — a phone at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('shows at most five tabs, opens and closes the “Thêm” sheet, and never scrolls sideways', async ({
    page,
  }) => {
    // D76 shipped with "the e2e journeys were not run (live stack, out of
    // bounds)" as its first concern, and the phone tree is chosen by
    // `window.matchMedia` — which jsdom does not have, so the entire vitest
    // suite exercises the DESKTOP bar. This is the only place the five-tab
    // tree is ever rendered by a browser.
    // The outer watchdog spans the whole test, the per-path one below is
    // scoped to a page: both need the same allowance, since both see every
    // request the loop makes.
    const watch = watchForBrokenRequests(page, [NOT_JOINED, SIGNED_OUT_BELL]);
    await page.goto('/problems');

    const phoneNav = page.locator('nav.shell-nav-phone');
    await expect(phoneNav).toBeVisible();
    const tabs = phoneNav.locator('.nav-tab');
    const tabCount = await tabs.count();
    expect(tabCount, 'a bottom bar is five tabs at the most (D76)').toBeLessThanOrEqual(5);
    expect(tabCount, 'and this app fills all five').toBe(5);
    // Signed out, the bell would be a dead tab, so the fourth is the door.
    await expect(phoneNav.getByRole('link', { name: 'Đăng nhập' })).toBeVisible();
    await shot(page, 'f3a-tab-bar');

    // ── the overflow sheet ───────────────────────────────────────────
    const more = phoneNav.getByRole('button', { name: 'Thêm' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    const sheet = page.getByRole('dialog', { name: 'Thêm lựa chọn' });
    await expect(sheet).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    // Every route is one tap or two: the items the bar could not hold are
    // here.
    await expect(sheet.getByRole('link', { name: 'Trợ giúp' })).toBeVisible();
    await shot(page, 'f3b-more-sheet');

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(more).toHaveAttribute('aria-expanded', 'false');

    // …and by its own close button, which is the control a thumb reaches.
    await more.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Đóng' }).click();
    await expect(sheet).toBeHidden();

    // ── no page scrolls sideways ─────────────────────────────────────
    for (const path of [
      '/',
      '/problems',
      `/problems/${PROBLEM}`,
      '/problems?tag=do-thi',
      '/contests',
      '/submissions',
      '/orgs',
      '/help',
      '/me/progress',
      '/notifications',
    ]) {
      const pageWatch = watchForBrokenRequests(page, [NOT_JOINED, SIGNED_OUT_BELL]);
      await page.goto(path);
      await expect(page.locator('nav.shell-nav-phone')).toBeVisible();
      await expect(page.locator('main')).not.toBeEmpty();

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${path} scrolls sideways on a phone: ${String(overflow.scrollWidth)} > ${String(overflow.innerWidth)}`,
      ).toBeLessThanOrEqual(overflow.innerWidth);
      expect(pageWatch.errors, `${path} reported: ${pageWatch.errors.join(' | ')}`).toEqual([]);
    }
    await shot(page, 'f3c-phone-problem');

    expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
  });
});

/* ── 4 — clarifications ─────────────────────────────────────────────── */

test('feature 4 — a pupil asks, the organiser answers and publishes, and the bell rings', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const admin = adminCredentials();
  const watch = watchForBrokenRequests(page, [NOT_JOINED]);
  contestKey = `bh14-qa-${RUN}`;
  const question = `Bài A dùng kiểu số nào ạ? (${RUN})`;
  const answer = `Dùng số nguyên 64 bit. (${RUN})`;

  await signIn(page, admin.username, admin.password);
  await createContest(
    page,
    contestKey,
    `Hỏi đáp BH14 ${RUN}`,
    new Date(Date.now() - 60_000),
    new Date(Date.now() + 2 * 3600_000),
  );
  await expect(page.getByRole('heading', { name: 'Hỏi đáp / Thông báo' })).toBeVisible();

  // ── the pupil joins and asks ─────────────────────────────────────────
  const pupilContext = await browser.newContext();
  const student = await pupilContext.newPage();
  const studentWatch = watchForBrokenRequests(student, [NOT_JOINED]);
  const account = await register('s1');
  competitors.push(account);
  await signIn(student, account.username, PASSWORD);

  await student.goto(`/contests/${contestKey}`);
  // The ask form is behind joining (D31): a spectator cannot put a question
  // in front of the people running a contest they are not sitting.
  await expect(student.getByText('Tham gia kỳ thi để đặt câu hỏi.')).toBeVisible();
  await student.getByRole('button', { name: 'Tham gia' }).click();
  await expect(student.getByRole('status')).toContainText('Đang thi chính thức');

  await student.getByRole('textbox', { name: 'Hỏi ban tổ chức' }).fill(question);
  await student.getByRole('button', { name: 'Gửi', exact: true }).click();

  const asked = student.locator('article').filter({ hasText: question });
  await expect(asked).toHaveCount(1);
  await expect(asked).toContainText('Đang chờ trả lời.');
  // Private until an organiser publishes it, and the page says so rather
  // than leaving the asker to guess who can read it.
  await expect(asked).toContainText('(chỉ bạn và ban tổ chức thấy)');
  await shot(student, 'f4a-asked');

  // ── the organiser answers ────────────────────────────────────────────
  await page.goto(`/contests/${contestKey}`);
  const row = page.locator('article').filter({ hasText: question });
  await expect(row).toHaveCount(1);
  await row.locator('textarea').fill(answer);
  await row.getByRole('button', { name: 'Trả lời', exact: true }).click();
  await expect(row).toContainText(answer);

  // ── …and publishes it ────────────────────────────────────────────────
  await row.getByRole('button', { name: 'Công bố' }).click();
  await expect(row.getByText('Công khai')).toBeVisible();
  await shot(page, 'f4b-answered-published');

  // ── the pupil is told ────────────────────────────────────────────────
  await student.goto(`/contests/${contestKey}`);
  const seen = student.locator('article').filter({ hasText: question });
  await expect(seen).toContainText(answer);
  await expect(seen).not.toContainText('(chỉ bạn và ban tổ chức thấy)');

  // The bell, not merely the feed: D31 fires `clarification_answered` at the
  // asker on the FIRST answer, and an unread badge is how they find out
  // without staring at the contest page.
  const bell = student.locator('nav.shell-nav .nav-bell');
  await expect(bell.locator('.nav-badge')).toBeVisible({ timeout: 60_000 });
  await bell.click();
  await expect(student).toHaveURL(/\/notifications$/);
  await expect(student.getByText(/Câu hỏi của bạn ở/)).toBeVisible();
  await expect(
    student.locator(`a[href="/contests/${contestKey}"]`).first(),
  ).toBeVisible();
  await shot(student, 'f4c-bell');

  expect(studentWatch.errors, `pupil reported: ${studentWatch.errors.join(' | ')}`).toEqual([]);
  expect(watch.errors, `organiser reported: ${watch.errors.join(' | ')}`).toEqual([]);
  await pupilContext.close();
});

/* ── 5 — the editorial ──────────────────────────────────────────────── */

test('feature 5 — an editorial is public, vanishes for the room still solving it, and comes back on AC', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const admin = adminCredentials();
  const watch = watchForBrokenRequests(page, [NOT_JOINED]);

  await signIn(page, admin.username, admin.password);
  // The deployment ships no editorial on any problem (`content/README.md`'s
  // step 7 was never run), so the journey publishes the one the repository
  // carries and `afterAll` clears it again.
  const published = await page.request.patch(`/api/v1/problems/${PROBLEM}`, {
    headers: SAME_ORIGIN,
    data: { editorial: EDITORIAL, editorialPublished: true },
  });
  expect(published.ok(), `publishing the editorial: ${published.status()}`).toBe(true);
  editorialPublished = true;

  const readerContext = await browser.newContext();
  const reader = await readerContext.newPage();
  const readerWatch = watchForBrokenRequests(reader, [NOT_JOINED]);
  const account = await register('s2');
  competitors.push(account);
  await signIn(reader, account.username, PASSWORD);

  const editorial = reader.locator('details').filter({ hasText: 'Lời giải' });

  // ── published, and nobody is sitting a contest on it ─────────────────
  await reader.goto(`/problems/${PROBLEM}`);
  await expect(editorial).toHaveCount(1);
  await editorial.locator('summary').click();
  // Rendered prose, not merely a `<details>` with a heading in it: the
  // editorial goes through `renderStatement`, and an empty body is what a
  // publish that stored nothing would look like.
  const written = (await editorial.innerText()).trim();
  expect(written.length, 'the editorial must have rendered').toBeGreaterThan(80);
  await shot(reader, 'f5a-editorial-open');

  // ── joins the contest that uses it: gone ─────────────────────────────
  await reader.goto(`/contests/${contestKey}`);
  await reader.getByRole('button', { name: 'Tham gia' }).click();
  await expect(reader.getByRole('status')).toContainText('Đang thi chính thức');

  await reader.goto(`/problems/${PROBLEM}`);
  await expect(reader.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(
    editorial,
    'D43: a competitor still solving the problem must not be handed the solution',
  ).toHaveCount(0);
  // D35's own mask, on the same page and for the same reason — the topics
  // are a hint at the method.
  await expect(reader.getByText('Chủ đề:')).toHaveCount(0);
  await shot(reader, 'f5b-editorial-withheld');

  // ── solves it, in the contest: back ──────────────────────────────────
  await reader.goto(`/submit?problem=${PROBLEM}&contest=${contestKey}`);
  await submitAndAwait(reader, AC_SOURCE, 'AC');

  await reader.goto(`/problems/${PROBLEM}`);
  await expect(
    editorial,
    'D43: an AC ends the reason to withhold it, contest or no contest',
  ).toHaveCount(1);
  await shot(reader, 'f5c-editorial-after-ac');

  expect(readerWatch.errors, `reader reported: ${readerWatch.errors.join(' | ')}`).toEqual([]);
  expect(watch.errors, `admin reported: ${watch.errors.join(' | ')}`).toEqual([]);
  await readerContext.close();
});

/* ── 6 — the booklet ────────────────────────────────────────────────── */

test('feature 6 — the contest booklet link downloads a real PDF', async ({ page }) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED]);
  const admin = adminCredentials();
  await signIn(page, admin.username, admin.password);
  await page.goto(`/contests/${contestKey}`);

  const link = page.getByRole('link', { name: 'Tải đề (PDF)' });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href, 'the booklet link must carry an href').not.toBeNull();
  // `lang` follows the reader's own locale (D48) — the booklet prints one
  // half of a bilingual statement and this reader is on the Vietnamese site.
  expect(href).toContain('lang=vi');

  // Fetched rather than clicked: a click on a PDF in Chromium opens a viewer
  // and there is no status code to assert on. `page.request` shares the
  // browser context's cookies, so this is the same reader.
  const pdf = await page.request.get(href!);
  expect(pdf.status(), `booklet: ${pdf.status()}`).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  const body = await pdf.body();
  // A real document, not an empty 200: typst's output starts `%PDF`.
  expect(body.length, 'the booklet must have pages in it').toBeGreaterThan(1000);
  expect(body.subarray(0, 4).toString('latin1')).toBe('%PDF');

  await shot(page, 'f6-booklet-link');
  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 7 — the roster import ──────────────────────────────────────────── */

test('feature 7 — a school imports three pupils, and the first one in must choose a password', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const admin = adminCredentials();
  const watch = watchForBrokenRequests(page);
  orgSlug = `bh14-truong-${RUN}`;
  const names = [1, 2, 3].map((n) => `bh14i${n}-${RUN}`);
  const displayNames = [1, 2, 3].map((n) => `Học Sinh ${n} ${RUN}`);
  imported = names.map((username, index) => ({ username, displayName: displayNames[index]! }));

  await signIn(page, admin.username, admin.password);

  // ── the school ───────────────────────────────────────────────────────
  await page.goto('/orgs');
  await page.getByLabel('Định danh').fill(orgSlug);
  await page.getByLabel('Tên', { exact: true }).fill(`Trường BH14 ${RUN}`);
  // Invite-only: nothing should be able to wander into a school this run
  // created, and the roster arrives by import rather than by request.
  await page.getByLabel('Cách gia nhập').selectOption('invite');
  await page.getByRole('button', { name: 'Tạo', exact: true }).click();
  await page.goto(`/orgs/${orgSlug}`);
  await expect(page.getByRole('heading', { level: 1, name: `Trường BH14 ${RUN}` })).toBeVisible();

  // ── check, then create ───────────────────────────────────────────────
  const csv = ['username,displayName', ...names.map((n, i) => `${n},${displayNames[i]!}`)].join('\n');
  await page.getByRole('textbox', { name: 'Danh sách học sinh' }).fill(csv);
  await page.getByRole('button', { name: 'Kiểm tra danh sách' }).click();
  // `dryRun` first (D61): the school sees what the server understood before
  // anything exists.
  await expect(page.getByText('Sẽ tạo 3 tài khoản.')).toBeVisible();
  await shot(page, 'f7a-import-preview');

  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.getByRole('heading', { name: 'Đã tạo tài khoản' })).toBeVisible();
  await expect(
    page.getByText(/Các mật khẩu này chỉ hiện một lần/),
  ).toBeVisible();

  // The credentials table is the ONLY copy of these passwords — nothing on
  // the server can reproduce them — so this is where the journey reads one.
  //
  // Scoped to the table with a `Mật khẩu` column, NOT to the page: the
  // import's own `onImported` refresh has by now put the same three
  // usernames into the roster table further down, and a page-wide row
  // locator resolves to two.
  const credentials = page
    .locator('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Mật khẩu' }) });
  await expect(credentials).toHaveCount(1);
  const credentialRow = credentials.getByRole('row').filter({ hasText: names[0]! });
  await expect(credentialRow).toHaveCount(1);
  const cells = credentialRow.getByRole('cell');
  await expect(cells).toHaveCount(3);
  const generated = (await cells.nth(2).innerText()).trim();
  expect(generated.length, 'a generated password must be on screen').toBeGreaterThanOrEqual(8);
  // Never asserted verbatim and never screenshotted: the shot is taken with
  // the table on it, which is the sheet a teacher prints, so it is taken
  // BEFORE anything types it into a form. (The passwords are throwaway, and
  // the screenshot directory is gitignored.)
  await shot(page, 'f7b-credentials');

  // The roster really grew, on the page a teacher looks at.
  await page.goto(`/orgs/${orgSlug}`);
  for (const name of names) {
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  }

  // ── the pupil signs in and is stopped ────────────────────────────────
  const pupilContext = await browser.newContext();
  const first = await pupilContext.newPage();
  const pupilWatch = watchForBrokenRequests(first);
  await first.goto('/');
  await first.locator('#identifier').fill(names[0]!);
  await first.locator('#password').fill(generated);
  await first.getByRole('button', { name: 'Đăng nhập', exact: true }).click();

  // D61's forced change is a HARD SWAP of the whole app, not a redirect: the
  // pupil is signed in and every route is this form until they choose one.
  await expect(first.getByRole('heading', { level: 1, name: 'Đổi mật khẩu' })).toBeVisible();
  await expect(first.getByText(/Tài khoản này do trường lập cho bạn/)).toBeVisible();
  await first.goto('/problems');
  await expect(
    first.getByRole('heading', { level: 1, name: 'Đổi mật khẩu' }),
    'the gate must stand on every route, not only on /account/password',
  ).toBeVisible();
  // And the old password is not asked for — they never chose it.
  await expect(first.getByLabel('Mật khẩu hiện tại')).toHaveCount(0);
  await shot(first, 'f7c-forced-change');

  await first.getByLabel('Mật khẩu mới', { exact: true }).fill(PUPIL_PASSWORD);
  await first.getByLabel('Nhập lại mật khẩu mới').fill(PUPIL_PASSWORD);
  await first.getByRole('button', { name: 'Đổi mật khẩu' }).click();

  // The gate comes down where it stood, without a navigation: `PasswordGate`
  // swaps `<Outlet />` back the instant `me` says the debt is paid, so the
  // pupil is left on the route they were trying to reach.
  //
  // NOT asserted: the form's own "Đã đổi mật khẩu" line. It is real, and it
  // is unobservable in this flow — the same `me` refetch that clears the
  // flag unmounts the page carrying it, so whether a browser ever paints it
  // is a race between two renders. Recorded in the loop report as a UX nit
  // rather than tested for. What the new password is worth is proved
  // instead by feature 8, which signs this pupil in with it.
  await expect(first.getByRole('heading', { level: 1, name: 'Bài tập' })).toBeVisible();
  await expect(first.getByRole('heading', { name: 'Đổi mật khẩu' })).toHaveCount(0);
  pupil = { username: names[0]!, password: PUPIL_PASSWORD };

  expect(pupilWatch.errors, `pupil reported: ${pupilWatch.errors.join(' | ')}`).toEqual([]);
  expect(watch.errors, `teacher reported: ${watch.errors.join(' | ')}`).toEqual([]);
  await pupilContext.close();
});

/* ── 8 — homework ───────────────────────────────────────────────────── */

test('feature 8 — a teacher assigns homework, the pupil solves it, and the class grid shows it', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  expect(pupil, 'feature 7 must have imported a pupil').not.toBeNull();
  const admin = adminCredentials();
  const watch = watchForBrokenRequests(page);
  const setSlug = 'tuan-1';
  const setName = `Bài tập tuần 1 (${RUN})`;

  await signIn(page, admin.username, admin.password);
  await page.goto(`/orgs/${orgSlug}`);

  await page.getByRole('button', { name: 'Giao bài tập' }).click();
  await page.getByLabel('Định danh').fill(setSlug);
  await page.getByLabel('Tên', { exact: true }).fill(setName);
  // No deadline: "late" is a whole second column (D66) and this journey is
  // about the assignment reaching a pupil, not about the bell.
  await page.getByLabel('Tìm bài theo mã hoặc tên').fill(PROBLEM);
  const found = page.locator('li').filter({ hasText: PROBLEM });
  await found.getByRole('button', { name: 'Thêm' }).click();
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();

  await expect(page.getByRole('link', { name: setName })).toBeVisible();
  await shot(page, 'f8a-assigned');

  // ── the pupil, who is a member because the import made them one ──────
  const pupilContext = await browser.newContext();
  const learner = await pupilContext.newPage();
  const learnerWatch = watchForBrokenRequests(learner);
  await signIn(learner, pupil!.username, pupil!.password);

  await learner.goto(`/orgs/${orgSlug}`);
  await expect(learner.getByRole('heading', { name: 'Bài tập về nhà' })).toBeVisible();
  await learner.getByRole('link', { name: setName }).click();
  await expect(learner).toHaveURL(new RegExp(`/orgs/${orgSlug}/sets/${setSlug}$`));
  await expect(learner.getByRole('heading', { level: 1, name: setName })).toBeVisible();
  // Nothing done yet.
  await expect(learner.getByText('0/1')).toBeVisible();

  await learner.getByRole('link', { name: 'Nộp bài' }).click();
  await expect(learner).toHaveURL(new RegExp(`/submit\\?problem=${PROBLEM}`));
  await submitAndAwait(learner, AC_SOURCE, 'AC');

  await learner.goto(`/orgs/${orgSlug}/sets/${setSlug}`);
  // By position, not by code: a set row shows the problem's NAME, and the
  // set has exactly one problem on it.
  const doneRow = learner.locator('table tbody tr');
  await expect(doneRow).toHaveCount(1);
  await expect(doneRow.locator('.badge')).toHaveText('AC');
  await expect(learner.getByText('1/1')).toBeVisible();
  await shot(learner, 'f8b-pupil-done');

  // ── and the teacher's grid ───────────────────────────────────────────
  await page.goto(`/orgs/${orgSlug}/sets/${setSlug}`);
  await page.getByRole('link', { name: 'Kết quả cả lớp' }).click();
  await expect(page).toHaveURL(new RegExp(`/orgs/${orgSlug}/sets/${setSlug}/progress$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(setName);

  // The grid is inside its own scroller so a wide class does not widen the
  // page (m21) — and it is reachable from a keyboard because of it.
  const grid = page.getByRole('region', { name: /Bảng kết quả cả lớp/ });
  await expect(grid).toBeVisible();
  await expect(grid).toHaveAttribute('tabindex', '0');
  // By DISPLAY name: the grid labels a pupil with the name their teacher
  // typed and hangs the username on the link's href.
  const pupilRow = grid.getByRole('row').filter({ hasText: imported[0]!.displayName });
  await expect(pupilRow).toHaveCount(1);
  await expect(pupilRow.locator('.badge')).toHaveText('AC');
  // The other two imported pupils are on the roster and have done nothing —
  // a grid that lists only the people who submitted is not a class list.
  for (const member of imported) {
    await expect(grid.getByRole('row').filter({ hasText: member.displayName })).toHaveCount(1);
  }

  // The CSV is the whole roster, straight at the API (D66's documented
  // exception to D58's paging).
  const csvHref = await page.getByRole('link', { name: 'Tải CSV' }).getAttribute('href');
  expect(csvHref).not.toBeNull();
  const csv = await page.request.get(csvHref!);
  expect(csv.status(), `class CSV: ${csv.status()}`).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect(await csv.text()).toContain(pupil!.username);
  await shot(page, 'f8c-class-grid');

  expect(learnerWatch.errors, `pupil reported: ${learnerWatch.errors.join(' | ')}`).toEqual([]);
  expect(watch.errors, `teacher reported: ${watch.errors.join(' | ')}`).toEqual([]);
  await pupilContext.close();
});

/* ── 9 — results and certificates ───────────────────────────────────── */

test('feature 9 — once a contest is over its organiser can export the results and the certificates', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  // Two competitors, a two-minute window, and then a wait for the bell.
  test.setTimeout(360_000);
  const admin = adminCredentials();
  const watch = watchForBrokenRequests(page, [NOT_JOINED]);
  shortKey = `bh14-ket-qua-${RUN}`;

  await signIn(page, admin.username, admin.password);
  // Starts a minute ago so the pupils can join at once; the end is set two
  // minutes out and `datetime-local` truncates to the minute, so the real
  // window is between one and two minutes of submitting time. Short on
  // purpose: this journey has to outlive the contest.
  const endsAt = new Date(Date.now() + 2 * 60_000);
  await createContest(
    page,
    shortKey,
    `Kết quả BH14 ${RUN}`,
    new Date(Date.now() - 60_000),
    endsAt,
  );

  // ── two pupils, the SAME source ──────────────────────────────────────
  // The two journeys 4 and 5 already registered, rather than two more: see
  // `competitors` for why the meter makes that the difference between this
  // journey running and 429ing.
  expect(competitors.length, 'features 4 and 5 must have run first').toBe(2);
  const contexts = [];
  for (const [index, account] of competitors.entries()) {
    const context = await browser.newContext();
    const competitor = await context.newPage();
    const competitorWatch = watchForBrokenRequests(competitor, [NOT_JOINED]);
    await signIn(competitor, account.username, PASSWORD);
    await competitor.goto(`/contests/${shortKey}`);
    await competitor.getByRole('button', { name: 'Tham gia' }).click();
    await expect(competitor.getByRole('status')).toContainText('Đang thi chính thức');
    await competitor.goto(`/submit?problem=${PROBLEM}&contest=${shortKey}`);
    // Byte-for-byte the same program for both of them — feature 10 is about
    // what that looks like from the organiser's chair.
    await submitAndAwait(competitor, AC_SOURCE, 'AC');
    twins[index] = account.username;
    contexts.push({ context, watch: competitorWatch, page: competitor });
  }

  // ── the bell ─────────────────────────────────────────────────────────
  // D71 lets an organiser export at any hour — the gate is the PERSON, the
  // export being the live unfrozen board — but the LINKS wait for the end,
  // because printing a board that is still moving is the mistake the delay
  // exists to prevent. So this polls the page rather than the clock.
  await expect
    .poll(
      async () => {
        await page.goto(`/contests/${shortKey}`);
        return await page.getByRole('link', { name: 'Kết quả (CSV)' }).count();
      },
      { timeout: 180_000, intervals: [5_000] },
    )
    .toBe(1);
  await shot(page, 'f9a-exports-offered');

  // ── the sheet ────────────────────────────────────────────────────────
  const csvHref = await page.getByRole('link', { name: 'Kết quả (CSV)' }).getAttribute('href');
  const csv = await page.request.get(csvHref!);
  expect(csv.status(), `results CSV: ${csv.status()}`).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  const sheet = await csv.text();
  // The BOM Excel needs to read Vietnamese names, and both competitors.
  expect(sheet.charCodeAt(0), 'the sheet opens with a UTF-8 BOM (D71)').toBe(0xfeff);
  for (const name of twins) expect(sheet).toContain(name);

  const pdfHref = await page.getByRole('link', { name: 'Kết quả (PDF)' }).getAttribute('href');
  const resultsPdf = await page.request.get(pdfHref!);
  expect(resultsPdf.status(), `results PDF: ${resultsPdf.status()}`).toBe(200);
  expect(resultsPdf.headers()['content-type']).toContain('application/pdf');

  // ── the certificates ─────────────────────────────────────────────────
  //
  // The route shipped with F12 and NOTHING on the site pointed at it — the
  // bug this loop found and fixed. The fix is an anchor in `contests.tsx`,
  // and the anchor is pinned by `test/contest-results-links.spec.tsx`
  // against THIS tree; the live stack runs whatever is deployed, which may
  // still predate it. So what this journey proves is the half a unit test
  // cannot: that the URL answers a real PDF, and that the page — once the
  // deployment has caught up — points at exactly that URL.
  //
  // `?top=` is not decoration: `CertificatesQuery` refuses a request carrying
  // neither `top` nor `username` outright (422), which is how this journey
  // found that the first spelling of the fix — a bare link — could never
  // have worked. Three is what the page's box opens on, and both competitors
  // rank inside it.
  const certHref = `${csvHref!.replace('results.csv', 'certificates.pdf')}?top=3`;
  const linked = page.getByRole('link', { name: 'Giấy chứng nhận (PDF)' });
  if ((await linked.count()) === 1) {
    expect(await linked.getAttribute('href')).toBe(certHref);
  }
  const certificates = await page.request.get(certHref);
  expect(certificates.status(), `certificates: ${certificates.status()}`).toBe(200);
  expect(certificates.headers()['content-type']).toContain('application/pdf');
  const body = await certificates.body();
  expect(body.subarray(0, 4).toString('latin1')).toBe('%PDF');
  expect(body.length, 'two eligible finishers means real pages').toBeGreaterThan(1000);
  await shot(page, 'f9b-exports-fetched');

  for (const { watch: competitorWatch, context } of contexts) {
    expect(
      competitorWatch.errors,
      `competitor reported: ${competitorWatch.errors.join(' | ')}`,
    ).toEqual([]);
    await context.close();
  }
  expect(watch.errors, `organiser reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 10 — similarity ────────────────────────────────────────────────── */

test('feature 10 — the similarity check finds the identical pair and shows them side by side', async ({
  page,
}) => {
  expect(twins[0], 'feature 9 must have run two competitors').not.toBe('');
  const admin = adminCredentials();
  const watch = watchForBrokenRequests(page, [NOT_JOINED]);

  await signIn(page, admin.username, admin.password);
  await page.goto(`/contests/${shortKey}`);

  const panel = page.locator('section').filter({ hasText: 'Kiểm tra trùng lặp' }).last();
  await expect(panel.getByRole('heading', { name: 'Kiểm tra trùng lặp' })).toBeVisible();
  // D77's whole ruling, on the screen: a score is a reason to look, never a
  // finding. A table printed without it invites an organiser to treat a
  // number as a verdict.
  await expect(panel.getByText(/Điểm cao là lý do để xem lại/)).toBeVisible();
  await expect(page.getByText('Kỳ thi này chưa được kiểm tra lần nào.')).toBeVisible();

  await panel.getByRole('button', { name: 'Chạy kiểm tra' }).click();
  // The run row commits first and the comparison happens in-process; the
  // panel polls itself at 2 s while it is `running`.
  await expect(page.getByText(/Đã kiểm tra/)).toBeVisible({ timeout: 120_000 });
  await shot(page, 'f10a-report');

  const pair = page
    .getByRole('row')
    .filter({ hasText: twins[0] })
    .filter({ hasText: twins[1] });
  await expect(pair, 'two identical sources must be reported as a pair').toHaveCount(1);
  // Byte-identical, so both measures are 100% — the containment column is
  // the one the threshold tests (padding is the first disguise).
  await expect(pair.getByRole('cell', { name: '100%' })).toHaveCount(2);

  await pair.getByRole('link', { name: 'So sánh' }).click();
  await expect(page).toHaveURL(/\/similarity\?/);
  await expect(page.getByRole('heading', { level: 1, name: 'So sánh hai bài làm' })).toBeVisible();

  // Two sources, side by side, with the matching regions marked — and the
  // marks are real: an unmarked pair view is the failure this screen exists
  // to make impossible to miss.
  const sources = page.locator('.side-by-side pre');
  await expect(sources).toHaveCount(2);
  await expect(page.locator('mark.match').first()).toBeVisible();
  for (const name of twins) {
    await expect(page.locator('.side-by-side').getByRole('link', { name })).toBeVisible();
  }
  await shot(page, 'f10b-side-by-side');

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 11 — the progress page ─────────────────────────────────────────── */

test('feature 11 — a pupil’s progress page paints a heatmap and topic bars after an AC', async ({
  page,
}) => {
  expect(pupil, 'feature 7 must have imported a pupil').not.toBeNull();
  const watch = watchForBrokenRequests(page);
  await signIn(page, pupil!.username, pupil!.password);

  // Reached the way a pupil reaches it — from the nav, in both IAs (D76).
  // Behind the account overflow since D139: the bar had grown to three rows
  // at 1280px, so the five account PAGES moved behind one button while the
  // way OUT, the name, the bell and the language switch stayed on it.
  await page.locator('nav.shell-nav').getByRole('button', { name: 'Thêm' }).click();
  await page.locator('nav.shell-nav').getByRole('link', { name: 'Tiến độ' }).click();
  await expect(page).toHaveURL(/\/me\/progress$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tiến độ của tôi' })).toBeVisible();

  // The homework AC from feature 8 is a PRACTICE submission — no
  // participation, so D49's window exclusion has nothing to exclude and it
  // counts here immediately.
  const solved = page.locator('.stat').filter({ hasText: 'Số bài đã giải' });
  await expect(solved.locator('strong')).toHaveText('1');

  // The heatmap is an SVG the page draws itself; it must have painted, and
  // it must be reachable from a keyboard inside its scroller (m21).
  const heatmap = page.getByRole('img', { name: /bài nộp trong một năm qua/ });
  await expect(heatmap).toBeVisible();
  const box = await heatmap.boundingBox();
  expect(box!.height, 'the heatmap must have painted, not merely rendered').toBeGreaterThan(20);
  await expect(page.getByRole('group', { name: 'Hoạt động' })).toHaveAttribute('tabindex', '0');

  // Tag bars, per PROBLEM: `tong-hai-so` carries `mo-phong` and `toan`.
  await expect(page.getByRole('heading', { name: 'Theo chủ đề' })).toBeVisible();
  await expect(page.getByText('Chưa tính bài nào')).toHaveCount(0);
  const tagRow = page.getByRole('row').filter({ hasText: 'Mô phỏng' });
  await expect(tagRow).toHaveCount(1);
  await expect(tagRow.getByRole('cell', { name: '1', exact: true })).toHaveCount(2);

  await expect(page.getByRole('heading', { name: 'Theo độ khó' })).toBeVisible();
  // And the homework itself, which is what a pupil opens this page for.
  await expect(page.getByRole('heading', { name: 'Bài tập về nhà' })).toBeVisible();

  await shot(page, 'f11-progress');
  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});
