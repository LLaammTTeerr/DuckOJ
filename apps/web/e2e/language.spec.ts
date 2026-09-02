import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { adminCredentials } from './credentials.js';
import { watchForBrokenRequests, type Allowance } from './watch.js';

/**
 * The language path — the picker every pupil touches on every submission, and
 * the form a setter uses to bend it (loop F-42, extended by F-47).
 *
 * F-39, F-40 and F-41 all shipped with no Playwright run at all, and B-30's
 * sharpest finding was a *browser* defect proved only in jsdom: the picker
 * preselected C11 on the ordinary path and C++17 on a direct link, so a pupil
 * who read the statement and pressed Submit was offered C11 with a C starter
 * template on every problem on the site. Pasting a correct C++ program into
 * that is a Compile Error, on contest day. A test that drives a real browser
 * against the real API — which is the thing that decided the order — is what
 * would have caught it, and this file is that test.
 *
 * Three properties, in the order a pupil meets them:
 *
 *  1. **the menu, and its default** (D158). Five languages, C++17 first, and
 *     the SAME answer whether the pupil arrived by link or from the statement
 *     page. That is one assertion made twice on purpose: the two arrivals are
 *     literally different first renders, cold against the fallback list and
 *     warm against the cache the statement page filled under the same key.
 *  2. **the budget beside it** (D154). Python's limits are not the limits the
 *     statement quotes, and the line has to move when the selection does.
 *  3. **the draft that is waiting** (D84), and a language the problem refuses
 *     being absent from the menu AND absent from what the page posts — which
 *     the DOM's `select.value` cannot tell you, so the POST is read.
 *
 * Plus the F-41 form itself, deployed on 908a6b8 and never once opened in a
 * browser: an empty box means INHERIT and must never be stored as zero, which
 * is the distinction the whole form exists for and the one a browser breaks.
 *
 * ## The fixture, and why it is a clone
 *
 * Every walk here needs a problem it may set `allowed = false` on, and the
 * demo problems a province is shown are not that. `POST /problems/{code}/clone`
 * copies `aplusb` with its package attached as revision 1 — publishing it and
 * opening it up is two more calls, against building a package from scratch —
 * so each run gets a real, judgeable, `fe42-` named problem of its own (D153)
 * and nothing touches `aplusb`'s own limits.
 *
 * Serial, Vietnamese locators, zero console errors and zero unexpected 4xx per
 * page. Meter-safe (D26): the pupil is a FIXED `fe42-` account reached
 * login-first.
 */
test.describe.configure({ mode: 'serial' });

test.setTimeout(240_000);

const RUN = Date.now();
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const SAME_ORIGIN = { origin: ORIGIN } as const;
const PASSWORD = 'fe42-not-a-real-password-2026';

const CODE = `fe42-ngonngu-${RUN}`;
const PUPIL = 'fe42-a1';

/**
 * D158's order, read off the live API: the order an operator ADDED them in
 * (`problem.access.ts` orders `languageLimits` by `languages.id`), which is
 * why this is not alphabetical and `GET /languages` — ordered by key — is.
 *
 * Seven since F-46's migration 0046. It was five here until F-47, and this
 * file was the suite F-46 could not run: the two new rows landed on the live
 * database and nothing in `apps/web/e2e` had heard of them.
 */
const OFFERED = ['cpp17', 'cpp20', 'cpp14', 'c11', 'python3', 'pascal', 'java'] as const;

const AC_SOURCE = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`;

/** D80 meters submissions at one per ten seconds, and a refusal is a real 429. */
const SUBMIT_METERED: Allowance = { status: 429, url: '/api/v1/submissions' };
/** `GET /contests/{key}/me` 404s until the viewer has joined — by design. */
const NOT_JOINED: Allowance = { status: 404, url: /\/contests\/[^/]+\/me/ };

const CSP_THEME_BLOCKED = /Executing inline script violates the following Content Security Policy/;
const CONSOLE_ALLOW = [CSP_THEME_BLOCKED] as const;

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(
    page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' }),
  ).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.locator('#identifier')).toBeVisible();
}

/**
 * Log a fixed account in; register it through the ADMIN context if it does
 * not exist.
 *
 * **The admin context is not incidental (D200).** Since F-56 this deployment
 * decides who may create an account, the default rung is `closed`, and the
 * live `.env` sets nothing — so an anonymous `POST /auth/register` is a 403
 * here and these walks would have no pupils at all. A global admin is the one
 * caller a closed judge still admits, which is exactly what a rehearsal
 * harness seating fixed accounts on somebody's judge IS. The alternative
 * considered and rejected was weakening the default so the tests kept
 * passing, which would have made the policy a decoration.
 *
 * **The login probe runs on a THROWAWAY context, and that is a bug fix.** The
 * previous shape signed in on the very context it registered through, so the
 * second call of a loop was made by pupil one rather than by the admin — a
 * 403 under the closed rung, and invisible before it only because the
 * anonymous path happened to work.
 */
async function ensureAccount(admin: APIRequestContext, username: string): Promise<void> {
  const probe = await playwrightRequest.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { Origin: ORIGIN },
  });
  try {
    const login = async (): Promise<boolean> => {
      const res = await probe.post('/api/v1/auth/login', {
        headers: SAME_ORIGIN,
        data: { usernameOrEmail: username, password: PASSWORD },
      });
      return res.ok();
    };
    if (await login()) return;
    const reg = await admin.post('/api/v1/auth/register', {
      headers: SAME_ORIGIN,
      data: {
        username,
        email: `${username}@example.invalid`,
        password: PASSWORD,
        displayName: `FE42 ${username}`,
      },
    });
    expect(reg.ok() || reg.status() === 409, `register ${username}: ${String(reg.status())}`).toBe(
      true,
    );
    expect(await login(), `login ${username} after register`).toBe(true);
  } finally {
    await probe.dispose();
  }
}

async function actorContext(username: string, password = PASSWORD): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { Origin: ORIGIN },
  });
  const res = await ctx.post('/api/v1/auth/login', {
    headers: SAME_ORIGIN,
    data: { usernameOrEmail: username, password },
  });
  expect(res.ok(), `API login ${username}: ${String(res.status())}`).toBe(true);
  return ctx;
}

/** The editor arrives in a lazily-loaded chunk (D84 code-splits 505 kB). */
async function openSubmit(page: Page): Promise<void> {
  await page.locator('.cm-editor').waitFor({ state: 'visible' });
  await expect(page.locator('#language')).toBeVisible();
}

/** The values the picker is offering, in the order it offers them. */
function offeredKeys(page: Page): Promise<string[]> {
  return page.locator('#language option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
}

/** The setter's third tab, reached the way a setter reaches it. */
async function openLimitsTab(page: Page): Promise<void> {
  await page.goto(`/problems/${CODE}/edit`);
  await page.getByRole('button', { name: 'Giới hạn theo ngôn ngữ' }).click();
  await expect(page.getByRole('heading', { name: 'Giới hạn theo ngôn ngữ' })).toBeVisible();
}

/** One language's row on that tab. */
function limitsRow(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByRole('rowheader', { name }) });
}

let admin: { username: string; password: string };

/**
 * The fixture is a PUBLIC problem while the walks need it — a pupil has to be
 * able to see it — and a public problem is on the list a province browses. So
 * it is closed again here rather than left on that list until somebody runs
 * `scripts/cleanup-test-data.ts`. In `afterAll` so it happens even when a walk
 * above failed, which is exactly when it would otherwise be forgotten.
 */
test.afterAll(async () => {
  if (admin === undefined) return;
  const ctx = await playwrightRequest.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { Origin: ORIGIN },
  });
  await ctx.post('/api/v1/auth/login', {
    headers: SAME_ORIGIN,
    data: { usernameOrEmail: admin.username, password: admin.password },
  });
  await ctx.patch(`/api/v1/problems/${CODE}`, {
    headers: SAME_ORIGIN,
    data: { visibility: 'private' },
  });
  await ctx.dispose();
});

/* ── 1 — the fixture, and the menu every pupil is shown ──────────────── */

test('journey 1 — the picker offers seven languages and preselects C++17, by link and from the statement', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED], CONSOLE_ALLOW);
  admin = adminCredentials();
  const adminCtx = await actorContext(admin.username, admin.password);

  // Seated by the ADMIN context: a closed judge admits no other registrar
  // (D200), and `ensureAccount` keeps this context as the admin.
  await ensureAccount(adminCtx, PUPIL);

  // A judgeable problem of this run's own: clone, publish the revision the
  // clone brought with it, open it up.
  const cloned = await adminCtx.post('/api/v1/problems/aplusb/clone', {
    headers: SAME_ORIGIN,
    data: { newCode: CODE, newName: `FE42 ngôn ngữ ${RUN}` },
  });
  expect(cloned.ok(), `clone: ${String(cloned.status())} ${await cloned.text()}`).toBe(true);
  const published = await adminCtx.post(`/api/v1/problems/${CODE}/revisions/1/publish`, {
    headers: SAME_ORIGIN,
    data: {},
  });
  expect(published.ok(), `publish: ${String(published.status())}`).toBe(true);
  const opened = await adminCtx.patch(`/api/v1/problems/${CODE}`, {
    headers: SAME_ORIGIN,
    data: { visibility: 'public' },
  });
  expect(opened.ok(), `open up: ${String(opened.status())}`).toBe(true);

  await signIn(page, PUPIL, PASSWORD);

  // ── cold: a direct link, the arrival that mounts against the fallback ─
  await page.goto(`/submit?problem=${CODE}`);
  await openSubmit(page);
  expect(await offeredKeys(page), 'the picker must offer every language the API does').toEqual([
    ...OFFERED,
  ]);
  await expect(page.locator('#language')).toHaveValue('cpp17');
  // The names are proper nouns and are what a pupil actually picks by.
  await expect(page.locator('#language')).toContainText('C++17');
  await expect(page.locator('#language')).toContainText('Python 3');
  await expect(page.locator('#language')).toContainText('Pascal');
  await expect(page.locator('#language')).toContainText('Java 17');

  // D154's budget, for the language now selected. `aplusb`'s clone is
  // 1000 ms / 65536 KB, and Python is the seeded 300 % / +32768 KB.
  await expect(page.locator('#language-limits')).toHaveText(
    'Ngôn ngữ này được 1 giây và 64 MB.',
  );
  await page.locator('#language').selectOption('python3');
  await expect(
    page.locator('#language-limits'),
    'the budget must move with the selection, or a pupil reads the statement’s number',
  ).toHaveText('Ngôn ngữ này được 3 giây và 96 MB.');

  // ── warm: read the statement, press Submit — the ordinary path, and the
  //    one whose first render sees the real catalogue from the cache ─────
  await page.goto(`/problems/${CODE}`);
  await expect(page.getByRole('heading', { level: 1, name: `FE42 ngôn ngữ ${RUN}` })).toBeVisible();
  await page.getByRole('link', { name: 'Nộp bài' }).first().click();
  await openSubmit(page);
  expect(await offeredKeys(page)).toEqual([...OFFERED]);
  await expect(
    page.locator('#language'),
    'the default must not depend on how the pupil got to the page (D158)',
  ).toHaveValue('cpp17');

  await page.screenshot({ path: 'e2e/screenshots/f42-picker.png', fullPage: true });
  await adminCtx.dispose();
  expect(watch.errors, `the submit page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 2 — the draft waiting in the other language ─────────────────────── */

test('journey 2 — switching language and back gives the pupil their own program again', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED], CONSOLE_ALLOW);
  await signIn(page, PUPIL, PASSWORD);
  await page.goto(`/submit?problem=${CODE}`);
  await openSubmit(page);

  const editor = page.locator('.cm-content');
  const CPP = '// fe42 c++ half-written\nint main(){return 0;}';
  const PY = '# fe42 python half-written\nprint(1)';

  await expect(page.locator('#language')).toHaveValue('cpp17');
  await editor.fill(CPP);
  await page.locator('#language').selectOption('python3');
  // Nothing is waiting in Python, so the code is KEPT — a pupil who opens the
  // dropdown to read the options must not lose a half-written program to it.
  await expect(editor).toContainText('fe42 c++ half-written');
  await editor.fill(PY);

  // Back. D84's whole reason for keying per (problem, language) is the pupil
  // coming BACK, and until B-30 the gate could not fire: the buffer is never
  // empty, because an editor with no draft opens on a starter template.
  await page.locator('#language').selectOption('cpp17');
  await expect(editor, 'the C++ draft must come back, not the Python buffer').toContainText(
    'fe42 c++ half-written',
  );
  await expect(page.locator('.editor-note[role="status"]')).toContainText('Khôi phục bản nháp');

  // And the other one is still there, under its own key.
  await page.locator('#language').selectOption('python3');
  await expect(editor).toContainText('fe42 python half-written');

  expect(watch.errors, `the submit page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 3 — the F-41 form: an empty box is INHERIT, never zero ──────────── */

test('journey 3 — a setter writes a language override, and clearing a box stores inherit', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED], CONSOLE_ALLOW);
  const adminCtx = await actorContext(admin.username, admin.password);
  await signIn(page, admin.username, admin.password);
  await openLimitsTab(page);

  // The problem's own limits, which every row on this tab adjusts.
  await expect(page.getByText('Giới hạn gốc của đề: 1 giây và 64 MB.')).toBeVisible();

  const python = limitsRow(page, 'Python 3');
  const time = python.getByLabel('Tỉ lệ thời gian cho Python 3, tính theo phần trăm');
  const memory = python.getByLabel('Bộ nhớ cộng thêm cho Python 3, tính theo KB');

  // Empty to start with, and the placeholder is the inherited VALUE rather
  // than the word "optional" — an empty box has a meaning here and the reader
  // needs to know which number it means.
  await expect(time).toHaveValue('');
  await expect(time).toHaveAttribute('placeholder', 'Kế thừa: 300%');
  await expect(memory).toHaveAttribute('placeholder', 'Kế thừa: 32768 KB');

  // ── an override, and the preview a setter decides on ───────────────
  await time.fill('150');
  await memory.fill('65536');
  // 150 % of 1000 ms, and the interpreter's floor STILL added on top:
  // 65536 + 65536 KB. Computed by `effectiveLimits` itself, which is the same
  // function the API and the judge call.
  await expect(python.getByRole('cell', { name: '1.5 giây và 128 MB' })).toBeVisible();
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu giới hạn theo ngôn ngữ.')).toBeVisible();

  // It PERSISTED — through a real reload, not through the cache that has just
  // been told about it.
  await openLimitsTab(page);
  await expect(limitsRow(page, 'Python 3').getByLabel(/Tỉ lệ thời gian/)).toHaveValue('150');
  await expect(limitsRow(page, 'Python 3').getByLabel(/Bộ nhớ cộng thêm/)).toHaveValue('65536');
  await expect(
    limitsRow(page, 'Python 3').getByRole('cell', { name: '1.5 giây và 128 MB' }),
  ).toBeVisible();

  // And a pupil is given exactly that.
  const detail = (await (await adminCtx.get(`/api/v1/problems/${CODE}`)).json()) as {
    languageLimits: { languageKey: string; timeMs: number; memoryKb: number }[];
  };
  expect(detail.languageLimits.find((l) => l.languageKey === 'python3')).toMatchObject({
    timeMs: 1500,
    memoryKb: 131072,
  });

  // ── the whole point of the form: clearing is INHERIT, not zero ──────
  //
  // `Number('')` is 0, and a zero multiplier is the outcome D154 forbids by
  // name — every submission in that language TLEs while being told it was too
  // slow. The form holds these as STRINGS for exactly this reason, and a
  // browser is where that coercion would come back.
  const cleared = limitsRow(page, 'Python 3').getByLabel(/Tỉ lệ thời gian/);
  await cleared.fill('');
  await expect(
    limitsRow(page, 'Python 3').getByRole('cell', { name: '3 giây và 128 MB' }),
    'an emptied box must fall back to the inherited 300 %, never to 0 %',
  ).toBeVisible();
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu giới hạn theo ngôn ngữ.')).toBeVisible();

  await openLimitsTab(page);
  await expect(limitsRow(page, 'Python 3').getByLabel(/Tỉ lệ thời gian/)).toHaveValue('');
  await expect(limitsRow(page, 'Python 3').getByLabel(/Tỉ lệ thời gian/)).toHaveAttribute(
    'placeholder',
    'Kế thừa: 300%',
  );
  await expect(limitsRow(page, 'Python 3').getByLabel(/Bộ nhớ cộng thêm/)).toHaveValue('65536');

  // Stored as NULL, and asserted as null rather than as falsy: `0` is falsy
  // too, and it is the exact value this walk exists to rule out.
  const stored = (await (
    await adminCtx.get(`/api/v1/problems/${CODE}/language-limits`)
  ).json()) as {
    languages: { languageKey: string; timeMultiplierPct: number | null }[];
  };
  const row = stored.languages.find((l) => l.languageKey === 'python3');
  expect(row!.timeMultiplierPct).toBeNull();

  await page.screenshot({ path: 'e2e/screenshots/f42-limits-form.png', fullPage: true });
  await adminCtx.dispose();
  expect(watch.errors, `the limits form reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 4 — a language the problem refuses ──────────────────────────────── */

test('journey 4 — a refused language is off the menu, and the page does not post it', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED, SUBMIT_METERED], CONSOLE_ALLOW);
  const adminCtx = await actorContext(admin.username, admin.password);

  // The setter refuses C++17 — through the form, which is the only way a
  // provincial setter has and, until F-41, was not a way at all.
  await signIn(page, admin.username, admin.password);
  await openLimitsTab(page);
  const cpp = limitsRow(page, 'C++17');
  await cpp.getByLabel('Cho phép nộp bằng C++17').uncheck();
  await expect(
    cpp.getByRole('cell', { name: 'Không cho phép nộp bằng ngôn ngữ này' }),
    'a refused language must show the refusal and never a limit',
  ).toBeVisible();
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu giới hạn theo ngôn ngữ.')).toBeVisible();

  // ── the pupil's menu ───────────────────────────────────────────────
  await signOut(page);
  await signIn(page, PUPIL, PASSWORD);
  await page.goto(`/submit?problem=${CODE}`);
  await openSubmit(page);
  const keys = await offeredKeys(page);
  expect(keys, 'the refused language must not be offered').not.toContain('cpp17');
  expect(keys).toEqual(OFFERED.filter((key) => key !== 'cpp17'));
  // The cold mount's fallback is `cpp17` and it is no longer on offer, so the
  // derived default is the first language that IS (D158). Before that fix the
  // state kept pointing at `cpp17` while the select showed something else.
  await expect(page.locator('#language')).toHaveValue('cpp20');

  // ── and what it POSTS, which `select.value` cannot tell you ─────────
  //
  // B-30's second reproduction is exactly this: the select showed Python
  // while the button posted C++17, and D154's 404 `language_not_found`
  // refused a submission the pupil had made correctly. So the request is read.
  await page.locator('.cm-content').fill(AC_SOURCE);
  const [posted] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/api/v1/submissions'),
    ),
    page.getByRole('button', { name: 'Nộp bài', exact: true }).click(),
  ]);
  expect(posted.status(), `submit: ${String(posted.status())}`).toBe(201);
  expect(
    (posted.request().postDataJSON() as { languageKey: string }).languageKey,
    'the page must post the language it is showing',
  ).toBe('cpp20');
  await expect(page.locator('.badge')).toHaveText('AC', { timeout: 120_000 });

  // Put it back, so the fixture is left in the state journeys 1–3 describe.
  await signOut(page);
  await signIn(page, admin.username, admin.password);
  await openLimitsTab(page);
  await limitsRow(page, 'C++17').getByLabel('Cho phép nộp bằng C++17').check();
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu giới hạn theo ngôn ngữ.')).toBeVisible();

  await adminCtx.dispose();
  expect(watch.errors, `the submit page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 5 — Pascal and Java, all the way to a verdict (F-46, F-47) ──────── */

/**
 * The fixture F-46 could not add.
 *
 * F-46 shipped Pascal and Java — the toolchain, the allow-list, migration
 * 0046's rows and the whole picker/CLI surface — and could prove none of it
 * end to end, because that needed a deploy. The controller deployed it and
 * two of the three languages graded. Pascal sat in `queued`: `judged` had
 * loaded the executor→language mapping at boot, before 0046 inserted the
 * `pascal` row, and its fallback lowercased the judge's `PAS` into a language
 * key `pas` that does not exist. The judge could run the program. Nothing
 * could tell it to.
 *
 * That was proved by hand, on the live host, as submissions 881 and 882 on
 * `aplusb`. This is that proof as a fixture — through the picker a pupil
 * actually uses, in a real browser, to a real verdict from the real judge.
 *
 * **This walk goes GREEN against the deployed edge** — `f5f5ea6`, with all
 * seven languages proven grading after the controller's restart — unlike
 * `organiser.spec.ts` journey 2b, which is red by design. What it cannot
 * prove is the F-47 fix itself: the mapping only reloads in a `judged` the
 * controller has yet to ship, so what this pins today is that Pascal and Java
 * grade, and what it pins after the next deploy is that they still do.
 */
const PASCAL_AC = `var a, b: int64;
begin
  read(a, b);
  writeln(a + b);
end.`;

/**
 * `Main`, because that is the class DMOJ's `JavaExecutor` compiles and runs,
 * and `long` because a+b in `int` is the classic silent wrong answer.
 */
const JAVA_AC = `import java.util.Scanner;

public class Main {
  public static void main(String[] args) {
    Scanner in = new Scanner(System.in);
    System.out.println(in.nextLong() + in.nextLong());
  }
}`;

/** D80 meters a pupil at one submission per ten seconds. */
const METER_WAIT_MS = 11_000;

test('journey 5 — a Pascal and a Java program are graded, through the picker', async ({ page }) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED, SUBMIT_METERED], CONSOLE_ALLOW);
  await signIn(page, PUPIL, PASSWORD);

  async function submitAndGrade(languageKey: string, source: string, budget: string) {
    // Before the FIRST one too: journey 4 above submits as this same pupil,
    // and D80's meter does not care that a different walk spent it.
    await page.waitForTimeout(METER_WAIT_MS);
    await page.goto(`/submit?problem=${CODE}`);
    await openSubmit(page);
    await page.locator('#language').selectOption(languageKey);
    // D154/D169's budget for this language, on the screen where it is chosen:
    // Pascal is 200 % / +0 KB and Java 300 % / +64 MB of the clone's
    // 1000 ms / 65536 KB.
    await expect(page.locator('#language-limits')).toHaveText(budget);

    await page.locator('.cm-content').fill(source);
    const [posted] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().endsWith('/api/v1/submissions'),
      ),
      page.getByRole('button', { name: 'Nộp bài', exact: true }).click(),
    ]);
    expect(posted.status(), `submit ${languageKey}: ${String(posted.status())}`).toBe(201);
    expect(
      (posted.request().postDataJSON() as { languageKey: string }).languageKey,
      'the page must post the language it is showing',
    ).toBe(languageKey);

    // The assertion that would have failed on 2026-09-01: Pascal stayed
    // `queued` for as long as anybody watched it, because no connected judge
    // was believed to speak `pascal`. A verdict is the whole point.
    await expect(page.locator('.badge'), `${languageKey} never reached a verdict`).toHaveText(
      'AC',
      { timeout: 180_000 },
    );
    // And the pupil is never left staring at D160's "waiting for a judge that
    // can run this" on a language the fleet demonstrably runs.
    await expect(page.getByText('Đang đợi một máy chấm')).toHaveCount(0);
  }

  await submitAndGrade('pascal', PASCAL_AC, 'Ngôn ngữ này được 2 giây và 64 MB.');
  await submitAndGrade('java', JAVA_AC, 'Ngôn ngữ này được 3 giây và 128 MB.');

  await page.screenshot({ path: 'e2e/screenshots/f47-pascal-java.png', fullPage: true });
  expect(watch.errors, `the submit page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});
