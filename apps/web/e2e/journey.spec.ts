import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { TOTP, Secret } from 'otpauth';
import { adminCredentials } from './credentials.js';
import { watchForBrokenRequests } from './watch.js';

/**
 * The end-to-end journeys (tasks P5 and P9): what a pupil, a teacher and an
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
 * The single exception is journey 8's `source_access` flip, which is
 * restored in an `afterAll` — read its comment for why no browser can reach
 * the freeze mask without it.
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
// A fresh secret per run for the throwaway accounts this file creates. It was
// a fixed string once, which a secret scanner rightly flagged: the repo is
// public and the accounts outlive the run, so anyone could sign in as them.
const PASSWORD = `e2e-${randomUUID()}`;

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
 * The API path to an account, for the THROWAWAY users the later journeys need
 * as scenery — a rival to be masked, a pupil to disqualify.
 *
 * Registration does have a UI now (`/register`, task P6), and journey 1 walks
 * it in a browser, which is what proves the screen works. Repeating that walk
 * six more times would prove nothing further and would spend six form fills
 * per run on users whose only job is to exist, so every other journey mints
 * its account here and signs in through the form — the half of the front door
 * those journeys are actually about.
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
  // D84: the source box is CodeMirror's contenteditable, not a <textarea>.
  // `.fill()` works on either, but the editor arrives in a lazily-loaded
  // chunk, so it has to be waited for rather than assumed present the
  // instant the page renders. `.cm-content` also carries `id="source"`; the
  // class is used here because it is the thing that is actually true about
  // the element, and it survives a change of id.
  const editor = page.locator('.cm-content');
  await editor.waitFor({ state: 'visible' });
  await editor.fill(source);
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

test('journey 1 — register on the form, refuse a mismatched confirmation, then read the site in Vietnamese and English', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page);
  const username = `e2ej1${RUN}`;
  const displayName = `E2E j1 ${RUN}`;

  // The nav is where a visitor finds the door, so the journey opens it the
  // way they would rather than by typing the URL.
  await page.goto('/');
  const nav = page.locator('nav.shell-nav');
  await nav.getByRole('link', { name: 'Đăng ký', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);

  await page.locator('#username').fill(username);
  await page.locator('#email').fill(`${username}@example.invalid`);
  await page.locator('#displayName').fill(displayName);
  await page.locator('#password').fill(PASSWORD);
  // Valid on every other rule, wrong only in the confirmation: the mismatch
  // check sits in an `else` behind the length check, so a short password here
  // would prove the length rule instead of this one.
  await page.locator('#confirm').fill(`${PASSWORD}-khac`);
  // The page's own submit button, not the nav's link of the same name.
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();

  await expect(page.getByText('Hai mật khẩu không khớp nhau.')).toBeVisible();
  // Refused in the browser, before any request: still on `/register`, and the
  // watchdog below would have caught a 4xx if the form had posted anyway.
  await expect(page).toHaveURL(/\/register$/);
  await expect(nav.getByRole('link', { name: 'Đăng nhập', exact: true })).toBeVisible();
  await shot(page, 'j1a-register-mismatch');

  await page.locator('#confirm').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();

  // `POST /auth/register` mints no cookie, so the page chains a login: a
  // successful signup ends with the visitor SIGNED IN on `/`, not back at the
  // sign-in form.
  await expect(page).toHaveURL(/\/$/);
  await expect(nav.getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
  // The display name, not the username: the nav shows what the person chose
  // to be called.
  await expect(nav.getByText(displayName)).toBeVisible();
  // Vietnamese by default (D18) — no toggle, no stored preference, first
  // visit.
  await expect(nav.getByRole('link', { name: 'Bài tập' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Kỳ thi' })).toBeVisible();

  // By its accessible name, which is the language's own name — "EN" is only
  // the glyph on the face of the button. The two were the same string until
  // the toggle grew `aria-label`s (a bare <span>'s `role="generic"` cannot
  // carry the group label, so a screen reader announced two unnamed
  // buttons); this locator is the one that survives that. The page runs in
  // `vi-VN` (playwright.config.ts), so the name is the Vietnamese spelling.
  await nav.getByRole('button', { name: 'Tiếng Anh' }).click();

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
  // D72: turning the second factor off asks for the account password, not a
  // confirm() dialog.
  await page.getByLabel('Mật khẩu hiện tại').fill(PASSWORD);
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

/**
 * The seeded demo contest (`scripts/seed-live`), public and month-long, with
 * no freeze on it. Journey 7 needs a contest that is *running* and that
 * outlives the run, and inventing one would prove the link works for contests
 * this file made rather than for the ones the stack ships.
 */
const SEEDED_CONTEST = 'thu-nghiem-1';

test('journey 7 — a contest submission names its contest, in the list and on its own page', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED]);
  const account = await register(page, 'j7');
  await signIn(page, account.username, PASSWORD);

  await page.goto(`/contests/${SEEDED_CONTEST}`);
  // The contest's own name, read off the page rather than typed here: it is
  // seeded content, and the link's LABEL is that name (`contestLabel`).
  const contestName = (await page.getByRole('heading', { level: 1 }).innerText()).trim();
  expect(contestName.length, 'the contest must have a name to link by').toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Tham gia' }).click();
  await expect(page.getByRole('status')).toContainText('Đang thi chính thức');

  // Through `?contest=`, so this becomes a `contest_submissions` row — a
  // practice attempt at the same problem would have no contest to name.
  //
  // By href, not by name: this contest carries five problems and therefore
  // five links reading "Nộp bài", one per row. Journey 4's single-problem
  // contest can afford the name; here it is ambiguous by construction.
  await page.locator(`a[href="/submit?problem=${PROBLEM}&contest=${SEEDED_CONTEST}"]`).click();
  await expect(page).toHaveURL(new RegExp(`contest=${SEEDED_CONTEST}`));
  await submitAndAwait(page, AC_SOURCE, 'AC');

  // ── the list names it ────────────────────────────────────────────────
  await page.goto(`/submissions?user=${account.username}`);
  const row = page.getByRole('row').filter({ hasText: account.username });
  await expect(row).toHaveCount(1);
  // Asserted by HREF, not merely by text: a label with no link is exactly the
  // state this column replaced.
  const listLink = row.locator(`a[href="/contests/${SEEDED_CONTEST}"]`);
  await expect(listLink).toHaveText(contestName);
  await shot(page, 'j7a-submissions-contest-column');

  // ── and so does the submission's own page ────────────────────────────
  await row.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/submissions\/\d+$/);
  await expect(page.locator('.badge')).toHaveText('AC');
  await expect(page.locator(`a[href="/contests/${SEEDED_CONTEST}"]`)).toHaveText(contestName);

  await shot(page, 'j7b-submission-contest-line');
  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/**
 * Journey 8 needs one rival to be able to SEE another's submission at all,
 * and by design nobody can: `source_access` defaults to `private`, so
 * `visibleSubmissionsWhere` admits only your own rows (design §2.2). The
 * freeze mask (D23) sits *inside* that visibility, so with the default it is
 * unreachable from a browser — there is no viewer who can see the row and is
 * not exempt from the mask.
 *
 * So the journey opens the one door D23 was written for: the problem is
 * flipped to `source_access = 'solved'`, which is the setting that lets
 * people who solved a problem read each other's attempts — and therefore the
 * setting under which a live scoreboard freeze would otherwise leak the
 * verdict it is hiding. This is the ONLY thing in this file that mutates
 * seeded content, so it is restored in `afterAll` rather than at the end of
 * the test body: a run Playwright aborts on a timeout never reaches the end
 * of a body, and leaving the demo stack's problem open would be a real
 * change to the deployment.
 */
let sourceAccessFlipped = false;

/**
 * The origin this run is driving, as a header.
 *
 * Everything else in this file goes through a real page, and a real browser
 * sends `Origin` on every unsafe method. `context.request` does not — it is
 * an HTTP client that happens to share the cookie jar — so the one
 * cookie-authenticated write below has to say so itself, or D82's
 * `CsrfOriginGuard` refuses it 403. The value must be `PUBLIC_ORIGIN` or one
 * of `WS_EXTRA_ORIGINS` on the stack under test; `playwright.config.ts`
 * defaults `E2E_BASE_URL` to the same `http://localhost:8080` that `.env`
 * lists.
 */
const REQUEST_ORIGIN = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin;

test.afterAll(async ({ browser }) => {
  if (!sourceAccessFlipped) return;
  const context = await browser.newContext();
  try {
    const admin = adminCredentials();
    const signedIn = await context.request.post('/api/v1/auth/login', {
      data: { usernameOrEmail: admin.username, password: admin.password },
      headers: { origin: REQUEST_ORIGIN },
    });
    expect(signedIn.ok(), `restoring source_access: admin sign-in ${signedIn.status()}`).toBe(true);
    const restored = await context.request.patch(`/api/v1/problems/${PROBLEM}`, {
      data: { sourceAccess: 'private' },
      headers: { origin: REQUEST_ORIGIN },
    });
    expect(restored.ok(), `restoring source_access: PATCH ${restored.status()}`).toBe(true);
    sourceAccessFlipped = false;
  } finally {
    await context.close();
  }
});

test('journey 8 — a live freeze masks a rival’s verdict, and never the organiser’s view', async ({
  page,
  browser,
}: {
  page: Page;
  browser: Browser;
}) => {
  const admin = adminCredentials();
  const watch = watchForBrokenRequests(page, [NOT_JOINED]);
  const key = `e2e-p9-freeze-${RUN}`;

  // ── the rival, first, and OUTSIDE the contest window ─────────────────
  // Their own AC on the problem is what buys them sight of a competitor's
  // row once the problem is open to solvers. It is a practice submission and
  // it is made before the contest exists, so nothing about it is frozen and
  // the contest's own five remaining minutes are spent only on the row this
  // journey is actually about.
  const rivalContext = await browser.newContext();
  const rival = await rivalContext.newPage();
  const rivalWatch = watchForBrokenRequests(rival, [NOT_JOINED]);
  const rivalAccount = await register(rival, 'j8r');
  await signIn(rival, rivalAccount.username, PASSWORD);
  await rival.goto(`/submit?problem=${PROBLEM}`);
  await submitAndAwait(rival, AC_SOURCE, 'AC');

  await signIn(page, admin.username, admin.password);
  // Same reason as the afterAll restore above: `page.request` is an HTTP
  // client sharing the cookie jar, not a navigated browser, so it does not
  // send `Origin` on its own and D82's `CsrfOriginGuard` 403s a
  // cookie-authenticated write that names none (B-14 named this exact PATCH).
  const opened = await page.request.patch(`/api/v1/problems/${PROBLEM}`, {
    data: { sourceAccess: 'solved' },
    headers: { origin: REQUEST_ORIGIN },
  });
  expect(opened.ok(), `opening ${PROBLEM} to solvers: ${opened.status()}`).toBe(true);
  sourceAccessFlipped = true;

  // ── a contest whose freeze is biting RIGHT NOW ───────────────────────
  // A sixty-minute window that started fifty-five minutes ago and ends in
  // five, frozen for its last ten: `now` is inside `[end − 10 min, end)`, so
  // the freeze is not merely configured (journey 4's is) but in force. Ten
  // is strictly less than sixty, which is the write-time rule (D22).
  await page.goto('/contests/new');
  await page.getByLabel('Mã kỳ thi').fill(key);
  await page.getByLabel('Tên', { exact: true }).fill(`Đóng băng E2E ${RUN}`);
  await page.getByLabel('Bắt đầu').fill(localInputValue(new Date(Date.now() - 55 * 60_000)));
  await page.getByLabel('Kết thúc').fill(localInputValue(new Date(Date.now() + 5 * 60_000)));
  await page.getByLabel('Đóng băng (phút)').fill('10');
  await page.getByLabel('Phạm vi').selectOption('public');
  await page.getByLabel('Mã bài 1').fill(PROBLEM);
  await page.getByLabel('Điểm bài 1').fill('100');
  await page.getByRole('button', { name: 'Tạo kỳ thi' }).click();
  await expect(page).toHaveURL(new RegExp(`/contests/${key}$`));

  // ── the competitor joins and solves it, inside the freeze ────────────
  const studentContext = await browser.newContext();
  const student = await studentContext.newPage();
  const studentWatch = watchForBrokenRequests(student, [NOT_JOINED]);
  const account = await register(student, 'j8s');
  await signIn(student, account.username, PASSWORD);

  await student.goto(`/contests/${key}`);
  await student.getByRole('button', { name: 'Tham gia' }).click();
  await expect(student.getByRole('status')).toContainText('Đang thi chính thức');
  await student.getByRole('link', { name: 'Nộp bài', exact: true }).click();
  await expect(student).toHaveURL(new RegExp(`contest=${key}`));
  // The submitter is never masked from their own attempt (D23): they watch
  // it grade to AC exactly as they would outside a contest.
  await submitAndAwait(student, AC_SOURCE, 'AC');

  // ── what the rival is allowed to know ────────────────────────────────
  // Listed, not hidden: existence is public, the outcome is not. Note the
  // filters are contest+user and NEVER `?verdict=` — a frozen row matches no
  // verdict filter at all, by design, so filtering by AC here would return an
  // empty page and prove nothing.
  await rival.goto(`/submissions?contest=${key}&user=${account.username}`);
  const maskedRow = rival.getByRole('row').filter({ hasText: account.username });
  await expect(maskedRow).toHaveCount(1);
  const maskedBadge = maskedRow.locator('.badge');
  await expect(maskedBadge).toHaveText('?');
  await expect(maskedBadge).toHaveAttribute(
    'title',
    'Được ẩn cho tới khi bảng điểm hết đóng băng.',
  );
  // Not "not graded yet", which is the other thing an empty cell could mean.
  await expect(maskedBadge).not.toHaveText('AC');
  await shot(rival, 'j8a-rival-masked-row');

  await rival.goto(`/contests/${key}/scoreboard`);
  await expect(rival.getByText(/Bảng điểm đang đóng băng/)).toBeVisible();
  await shot(rival, 'j8b-rival-frozen-board');

  // ── and what the organiser is ────────────────────────────────────────
  // The admin created this contest and is a global admin twice over; either
  // alone exempts them (D22, D23).
  await page.goto(`/submissions?contest=${key}&user=${account.username}`);
  const adminRow = page.getByRole('row').filter({ hasText: account.username });
  await expect(adminRow).toHaveCount(1);
  await expect(adminRow.locator('.badge')).toHaveText('AC');
  await page.goto(`/contests/${key}/scoreboard`);
  await expect(page.getByText(/Bảng điểm đang đóng băng/)).toHaveCount(0);
  await shot(page, 'j8c-admin-live-board');

  expect(rivalWatch.errors, `rival's page reported: ${rivalWatch.errors.join(' | ')}`).toEqual([]);
  expect(studentWatch.errors, `pupil's page reported: ${studentWatch.errors.join(' | ')}`).toEqual(
    [],
  );
  expect(watch.errors, `admin page reported: ${watch.errors.join(' | ')}`).toEqual([]);
  await rivalContext.close();
  await studentContext.close();
});
