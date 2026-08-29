import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';
import { adminCredentials } from './credentials.js';
import { watchForBrokenRequests } from './watch.js';

/**
 * The end-to-end journeys (task P5): what a pupil, a teacher and an
 * administrator actually do, against the live composed stack — Caddy, the
 * API, the judge, Redis, Postgres — rather than against jsdom.
 *
 * These are deliberately NOT hermetic. They register real users, submit real
 * C++ to a real judge and create real contests on whatever stack
 * `E2E_BASE_URL` points at. Every name is stamped with `Date.now()` so a
 * second run collides with nothing, and no journey ever mutates a
 * pre-existing account: the admin (`duckadmin`) is only ever *used*, and the
 * two-factor journey enrols a throwaway user of its own, because a run that
 * died between "enable TOTP" and "disable TOTP" on a shared account would
 * lock every later run out of it.
 *
 * Serial: they share one database, and journey 6 measures the contest
 * journey 4 created.
 *
 * The UI is Vietnamese by default (D18), so the locators read in Vietnamese.
 * Where a string is content (a username, a contest key, a verdict code) it is
 * asserted verbatim in either language.
 */
test.describe.configure({ mode: 'serial' });

// A judged submission is a compile plus twelve tests through a real sandbox,
// and journey 4 does that twice (once fresh, once rejudged) either side of a
// contest being created through the UI. The config's 60s is the right budget
// for the smoke pages and far too small here.
test.setTimeout(240_000);

const RUN = Date.now();
const PROBLEM = 'tong-hai-so';
const PASSWORD = 'khong-phai-mat-khau-that-dau';

/**
 * The AC source is the model solution ON DISK, not a copy typed into this
 * file: a solution that drifts from the one shipped in `content/` would make
 * this journey prove something about a program nobody ships.
 */
const AC_SOURCE = readFileSync(
  resolve(process.cwd(), `../../content/problems/${PROBLEM}/solution.cpp`),
  'utf8',
);

/** Deliberately wrong, and deliberately not derived from the model solution. */
const WA_SOURCE = `#include <bits/stdc++.h>
int main() {
    long long a = 0, b = 0;
    std::cin >> a >> b;
    std::cout << a + b + 1 << '\\n';
    return 0;
}
`;

/** `GET /contests/{key}/me` 404s until the viewer has joined — by design. */
const NOT_JOINED = { status: 404, url: /\/contests\/[^/]+\/me/ };
/** The first leg of a two-factor sign-in: 401 `totp_required`. */
const TOTP_CHALLENGE = { status: 401, url: '/auth/login' };

interface Account {
  username: string;
  displayName: string;
}

/**
 * Registration has no UI (see the report): `POST /auth/register` is reachable
 * only from the API. Journeys that need an account mint one through the API
 * and sign in through the form, which is the half the app actually renders.
 */
async function register(page: Page, suffix: string): Promise<Account> {
  const username = `e2e${suffix}${RUN}`;
  const displayName = `E2E ${suffix} ${RUN}`;
  const response = await page.request.post('/api/v1/auth/register', {
    data: {
      username,
      email: `${username}@example.invalid`,
      password: PASSWORD,
      displayName,
    },
  });
  expect(response.ok(), `register ${username}: ${response.status()}`).toBe(true);
  return { username, displayName };
}

/** Signs in through the real form at `/`, the only sign-in surface there is. */
async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
}

/**
 * Fills the submit form and waits for the judge, asserting the verdict
 * arrived over the WebSocket rather than by reloading: the page is never
 * navigated between the click and the assertion, and `submit.liveUnavailable`
 * (the app's own "the socket died, reload" message) must never appear.
 */
async function submitAndAwait(page: Page, source: string, verdict: string): Promise<void> {
  await page.locator('#source').fill(source);
  await page.getByRole('button', { name: 'Nộp bài', exact: true }).click();
  await expect(page.getByText(/Không nhận được cập nhật trực tiếp/)).toHaveCount(0);
  await expect(page.locator('.badge')).toHaveText(verdict, { timeout: 60_000 });
}

/** `YYYY-MM-DDTHH:mm` in the local zone — what a `datetime-local` input takes. */
function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
}

test('journey 1 — register, sign in, and read the site in Vietnamese, then English', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page);
  const account = await register(page, 'j1');

  await signIn(page, account.username, PASSWORD);

  const nav = page.locator('nav.shell-nav');
  // The display name, not the username: the nav shows what the person chose
  // to be called.
  await expect(nav.getByText(account.displayName)).toBeVisible();
  // Vietnamese by default (D18) — no toggle, no stored preference, first
  // visit.
  await expect(nav.getByRole('link', { name: 'Bài tập' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Kỳ thi' })).toBeVisible();

  await nav.getByRole('button', { name: 'EN' }).click();

  await expect(nav.getByRole('link', { name: 'Problems' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Contests' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Sign out' })).toBeVisible();
  // The choice persists across a navigation, which is the whole point of
  // storing it.
  await page.goto('/problems');
  await expect(page.getByRole('heading', { name: 'Problems' })).toBeVisible();

  await shot(page, 'j1-signed-in-en');
  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

test('journey 2 — a correct C++ solution reaches AC live, and "my submissions" filters to it', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page);
  const account = await register(page, 'j2');
  await signIn(page, account.username, PASSWORD);

  await page.goto(`/problems/${PROBLEM}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await page.getByRole('link', { name: 'Nộp bài giải' }).click();

  await expect(page).toHaveURL(new RegExp(`/submit\\?problem=${PROBLEM}`));
  await submitAndAwait(page, AC_SOURCE, 'AC');

  // "My submissions" from the problem page: the same list, filtered to this
  // problem AND this viewer.
  await page.goto(`/problems/${PROBLEM}`);
  await page.getByRole('link', { name: 'Bài nộp của tôi' }).click();

  await expect(page).toHaveURL(new RegExp(`problem=${PROBLEM}`));
  await expect(page.getByRole('heading', { name: 'Bài nộp' })).toBeVisible();
  const rows = page.getByRole('row').filter({ has: page.getByRole('link', { name: PROBLEM }) });
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByRole('link', { name: account.username })).toBeVisible();
  await expect(rows.first().locator('.badge')).toHaveText('AC');
  // The filter is real, not decorative: another user's submissions to this
  // problem exist on this stack (the seeded `hocsinh1` has solved it) and
  // none of them may appear here.
  await expect(page.getByRole('link', { name: 'hocsinh1' })).toHaveCount(0);

  await shot(page, 'j2-my-submissions');
  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

test('journey 3 — a wrong answer is judged WA, with the failing case shown', async ({ page }) => {
  const watch = watchForBrokenRequests(page);
  const account = await register(page, 'j3');
  await signIn(page, account.username, PASSWORD);

  await page.goto(`/submit?problem=${PROBLEM}`);
  await submitAndAwait(page, WA_SOURCE, 'WA');

  // The per-case grid rendered too — a bare verdict with no cases is the
  // shape of a judge error, not of a wrong answer.
  await expect(page.locator('ul.cases li').first()).toBeVisible();

  await shot(page, 'j3-wrong-answer');
  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/** Set by journey 4, measured again by journey 6. */
let contestKey = '';

test('journey 4 — an admin runs a frozen contest: join, submit, scoreboard, disqualify, rejudge', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const admin = adminCredentials();
  const watch = watchForBrokenRequests(page, [NOT_JOINED]);
  contestKey = `e2e-p5-${RUN}`;

  await signIn(page, admin.username, admin.password);

  // ── the admin creates the contest ────────────────────────────────────
  await page.goto('/contests/new');
  await page.getByLabel('Mã kỳ thi').fill(contestKey);
  await page.getByLabel('Tên', { exact: true }).fill(`Hành trình E2E ${RUN}`);
  // Open now, close in two hours, with a five-minute freeze — so the window
  // is configured and asserted, but its instant (end − 5 min) is far in the
  // future and the board this journey reads is the live one. A freeze that
  // was already biting would hide the very row the journey checks for.
  await page.getByLabel('Bắt đầu').fill(localInputValue(new Date(Date.now() - 60_000)));
  await page.getByLabel('Kết thúc').fill(localInputValue(new Date(Date.now() + 2 * 3600_000)));
  await page.getByLabel('Đóng băng (phút)').fill('5');
  await page.getByLabel('Phạm vi').selectOption('public');
  await page.getByLabel('Mã bài 1').fill(PROBLEM);
  await page.getByLabel('Điểm bài 1').fill('100');
  await page.getByRole('button', { name: 'Tạo kỳ thi' }).click();

  await expect(page).toHaveURL(new RegExp(`/contests/${contestKey}$`));
  await expect(page.getByRole('heading', { name: `Hành trình E2E ${RUN}` })).toBeVisible();

  // ── a pupil joins and submits ────────────────────────────────────────
  const studentContext = await browser.newContext();
  const student = await studentContext.newPage();
  const studentWatch = watchForBrokenRequests(student, [NOT_JOINED]);
  const account = await register(student, 'j4');
  await signIn(student, account.username, PASSWORD);

  await student.goto(`/contests/${contestKey}`);
  await student.getByRole('button', { name: 'Tham gia' }).click();
  await expect(student.getByRole('status')).toContainText('Đang thi chính thức');

  await student.getByRole('link', { name: 'Nộp bài', exact: true }).click();
  await expect(student).toHaveURL(new RegExp(`contest=${contestKey}`));
  await submitAndAwait(student, AC_SOURCE, 'AC');

  // ── the scoreboard shows the row ─────────────────────────────────────
  await page.goto(`/contests/${contestKey}/scoreboard`);
  const row = page.getByRole('row').filter({ hasText: account.username });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell', { name: '100', exact: true })).toBeVisible();
  // The organiser is never frozen out of their own board (D22).
  await expect(page.getByText(/Bảng điểm đang đóng băng/)).toHaveCount(0);
  await shot(page, 'j4a-scoreboard');

  // ── disqualify ───────────────────────────────────────────────────────
  await row.getByRole('button', { name: `Hủy tư cách ${account.username}` }).click();
  await expect(row).toContainText('(hủy tư cách)');
  await expect(row).toHaveClass(/dq/);
  await shot(page, 'j4b-disqualified');

  // ── rejudge that submission ──────────────────────────────────────────
  const list = await page.request.get(
    `/api/v1/submissions?contest=${contestKey}&user=${account.username}`,
  );
  expect(list.ok(), `submission list: ${list.status()}`).toBe(true);
  const { items } = (await list.json()) as { items: Array<{ id: number }> };
  expect(items.length, 'the contest submission must be listed').toBeGreaterThan(0);
  const submissionId = items[0]!.id;

  await page.goto(`/submissions/${String(submissionId)}`);
  await expect(page.locator('.badge')).toHaveText('AC');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Chấm lại' }).click();
  // D21: a rejudge names the contests to re-rate rather than replaying
  // ratings itself. Unrated here, so the hint may be absent — what must
  // happen is the verdict coming back.
  //
  // Polled by RELOADING: the submission page has no live socket of its own
  // (only `/submit` does), so the only way this verdict ever arrives is a
  // fetch. `count()` before `textContent()` is load-bearing — a bare
  // `textContent()` on a `.badge` that is not there yet waits with NO
  // timeout (Playwright's default action timeout is 0), so the poll blocks
  // inside its first iteration and never reloads again. That cost this
  // journey a two-minute false failure on a rejudge the API finishes in
  // three seconds.
  await expect
    .poll(
      async () => {
        await page.reload();
        const badge = page.locator('.badge').first();
        return (await badge.count()) > 0 ? await badge.textContent() : 'chưa chấm';
      },
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBe('AC');

  await shot(page, 'j4c-rejudged');
  expect(studentWatch.errors, `pupil's page reported: ${studentWatch.errors.join(' | ')}`).toEqual(
    [],
  );
  expect(watch.errors, `admin page reported: ${watch.errors.join(' | ')}`).toEqual([]);
  await studentContext.close();
});

test('journey 5 — two-factor: enrol, sign out, sign in with a code, disable', async ({ page }) => {
  const watch = watchForBrokenRequests(page, [TOTP_CHALLENGE]);
  const account = await register(page, 'j5');
  await signIn(page, account.username, PASSWORD);

  // ── enrol ────────────────────────────────────────────────────────────
  await page.goto('/account/security');
  await expect(page.getByRole('status')).toHaveText('Tài khoản này chưa bật xác thực hai lớp.');
  await page.getByRole('button', { name: 'Bật', exact: true }).click();

  const secret = (await page.locator('p', { hasText: 'Chuỗi bí mật' }).locator('code').innerText())
    .trim();
  expect(secret.length, 'the enrolment secret must be on screen').toBeGreaterThan(10);
  const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });

  await page.locator('#totp-code').fill(totp.generate());
  await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Tài khoản này đang bật xác thực hai lớp.');
  await shot(page, 'j5a-enrolled');

  // ── sign out, and back in — now the password alone is not enough ─────
  await page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.locator('nav.shell-nav').getByRole('link', { name: 'Đăng nhập' })).toBeVisible();

  await page.goto('/');
  await page.locator('#identifier').fill(account.username);
  await page.locator('#password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  // The server's own wording, shown verbatim (see i18n/en.ts), and the
  // second-step field the refusal unlocks.
  await expect(page.getByRole('alert')).toBeVisible();
  const code = page.locator('#totp');
  await expect(code).toBeVisible();
  await expect(page.locator('nav.shell-nav').getByRole('link', { name: 'Đăng nhập' })).toBeVisible();

  await code.fill(totp.generate());
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' })).toBeVisible();

  // ── disable, so the account ends the run as it started ───────────────
  await page.goto('/account/security');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Tắt xác thực hai lớp' }).click();
  await expect(page.getByRole('status')).toHaveText('Tài khoản này chưa bật xác thực hai lớp.');

  await shot(page, 'j5b-disabled');
  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

test.describe('journey 6 — a phone', () => {
  // A 390×844 viewport is an iPhone 12/13/14. Anything wider than the window
  // means a horizontal scrollbar on a phone, which on this app would be the
  // nav: it carries eleven controls.
  test.use({ viewport: { width: 390, height: 844 } });

  test('no page scrolls sideways at 390×844', async ({ page }) => {
    const key = contestKey === '' ? 'thu-nghiem-1' : contestKey;
    for (const path of ['/problems', `/contests/${key}`, `/contests/${key}/scoreboard`]) {
      const watch = watchForBrokenRequests(page, [NOT_JOINED]);
      await page.goto(path);
      await expect(page.locator('nav.shell-nav')).toBeVisible();
      // Wait for the page's own content, not just the shell, so the
      // measurement is of the finished layout.
      await expect(page.locator('main')).not.toBeEmpty();

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        overflow.scrollWidth,
        `${path} scrolls sideways on a phone: ${String(overflow.scrollWidth)} > ${String(overflow.innerWidth)}`,
      ).toBeLessThanOrEqual(overflow.innerWidth);

      await shot(page, `j6-${path.replaceAll('/', '_')}`);
      expect(watch.errors, `${path} reported: ${watch.errors.join(' | ')}`).toEqual([]);
    }
  });
});
