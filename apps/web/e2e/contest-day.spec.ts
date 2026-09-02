import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminCredentials } from './credentials.js';
import { watchForBrokenRequests, type Allowance } from './watch.js';

/**
 * Contest day in a real browser (loop B-24) — the screens `scripts/rehearsal.ts`
 * proves functionally, proved again through the composed stack where only a
 * browser can see them: the authoring tab, a team scoreboard rendering team
 * NAMES, the organiser monitor's counters and room count, the freeze banner a
 * rival gets while the organiser's feed shows the real verdict, the Q&A panel,
 * and the ordinary individual path still working beside all of it.
 *
 * Same contract as `authoring.spec.ts` and `features.spec.ts`: serial,
 * Vietnamese locators, zero console errors and zero broken subresources per
 * page (`watchForBrokenRequests`).
 *
 * **Meter-safe (D26).** Registration is 30/IP/hour and every POST burns it
 * even on a 409, but a successful login does not. So the pupils are the fixed
 * `rehearse-*` accounts `scripts/rehearsal.ts` already minted, reached
 * login-first; a first-ever run on a clean stack registers them once, and
 * every run after that costs the meter nothing.
 */
test.describe.configure({ mode: 'serial' });

// A judged submission is a compile plus a sandboxed run; the authoring journey
// also tars and stores a package server-side.
test.setTimeout(300_000);

const RUN = Date.now();
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const SAME_ORIGIN = { origin: ORIGIN } as const;
const PASSWORD = 'rehearse-not-a-real-password-2026';

// A+B, correct — the model solution the two authored tests describe, and also
// exactly what `aplusb` (the seeded public problem reused below) wants.
const AC_SOURCE = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`;

const AUTHORED = `contest-day-ab-${RUN}`;
const TEAM_KEY = `cd-icpc-${RUN}`;
const OPEN_KEY = `cd-open-${RUN}`;
const ORG = 'rehearse-school';
const TEAM_A = `cd-alpha-${RUN}`;
const TEAM_B = `cd-bravo-${RUN}`;

// `GET /contests/{key}/me` 404s until the viewer has joined — the app working
// as designed. Scoped to that route + status so a 500 there still fails.
const NOT_JOINED: Allowance = { status: 404, url: /\/contests\/[^/]+\/me/ };

// D120 — the live stack still serves the pre-fix Caddyfile, whose
// `script-src 'self'` blocks index.html's D116 pre-paint theme <script>, so
// every page logs one CSP violation. The Caddyfile fix + its test ship in this
// branch (security-headers.spec.ts pins the hash); until the edge is
// redeployed the running stack keeps emitting it, so it is tolerated HERE by
// its exact text — nothing else is. Delete this once the stack ships the hash.
const CSP_THEME_BLOCKED = /Executing inline script violates the following Content Security Policy/;
const CONSOLE_ALLOW = [CSP_THEME_BLOCKED] as const;

// D80 meters submissions (1 per 10 s). `submitAndExpectAC` waits the cooldown
// out and resubmits, but the refused attempt is a real 429 the watchdog sees —
// expected on the submit route, and only there.
const SUBMIT_METERED: Allowance = { status: 429, url: '/api/v1/submissions' };

/** Browser sign-in, asserted by the shell showing a sign-out button. */
async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' })).toBeVisible();
}

/** Sign the current user out and wait for the sign-in form to return. */
async function signOut(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.locator('#identifier')).toBeVisible();
}

/**
 * Submit the source in the editor and wait for an AC badge — retrying through
 * D80's submit meter (1 per 10 s). A successful submit paints the verdict badge
 * at once; the meter instead paints a cooldown alert, so this waits the window
 * out and resubmits, exactly as a competitor does on contest day.
 */
async function submitAndExpectAC(page: Page): Promise<void> {
  const badge = page.locator('.badge');
  const cooldown = page.getByRole('alert').filter({ hasText: 'quá nhanh' });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.getByRole('button', { name: 'Nộp bài', exact: true }).click();
    await expect(badge.or(cooldown).first()).toBeVisible({ timeout: 20_000 });
    if (await badge.isVisible()) break;
    await page.waitForTimeout(11_000);
  }
  await expect(badge).toHaveText('AC', { timeout: 120_000 });
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
        email: `${username}@rehearsal.invalid`,
        password: PASSWORD,
        displayName: username,
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

/** A logged-in API context for one actor, cookies and Origin carried. */
async function actorContext(username: string, password = PASSWORD): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { Origin: ORIGIN } });
  const res = await ctx.post('/api/v1/auth/login', {
    headers: SAME_ORIGIN,
    data: { usernameOrEmail: username, password },
  });
  expect(res.ok(), `API login ${username}: ${String(res.status())}`).toBe(true);
  return ctx;
}

async function waitForVerdict(ctx: APIRequestContext, id: number): Promise<string> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const res = await ctx.get(`/api/v1/submissions/${String(id)}`);
    const body = (await res.json()) as { state: string; verdict: string | null };
    if (body.state === 'done' || body.state === 'errored') return body.verdict ?? body.state;
    if (Date.now() > deadline) throw new Error(`submission ${String(id)} never finished`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/* ── state shared down the serial chain ──────────────────────────────── */
let admin: { username: string; password: string };
let bravoLateVerdict = '';

test('journey 1 — an admin authors a problem in the browser authoring tab, and a pupil ACs it', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [SUBMIT_METERED], CONSOLE_ALLOW);
  admin = adminCredentials();
  await signIn(page, admin.username, admin.password);

  // The problem row — PUBLIC, so the team round below and the pupil here can
  // both see it with no membership.
  await page.goto('/problems/new');
  await page.locator('#problem-code').fill(AUTHORED);
  await page.locator('#problem-name').fill(`Contest-day A+B ${RUN}`);
  await page.locator('#problem-statement').fill('# A+B\n\nCho $a$ và $b$, in ra $a+b$.\n');
  await page.locator('#problem-visibility').selectOption('public');
  await page.getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.getByText('Đã lưu.')).toBeVisible();

  // Two tests typed into the tab, standard checker (the default, asserted).
  await page.goto(`/problems/${AUTHORED}/edit`);
  await page.getByRole('button', { name: 'Dữ liệu chấm' }).click();
  await expect(page.getByRole('heading', { name: 'Dữ liệu chấm' })).toBeVisible();
  await page.getByLabel('Giới hạn thời gian (ms)').fill('1000');
  await page.getByLabel('Giới hạn bộ nhớ (KB)').fill('65536');
  await expect(page.getByLabel('Trình chấm')).toHaveValue('standard');
  await page.getByRole('button', { name: 'Thêm test' }).click();
  await page.getByRole('button', { name: 'Thêm test' }).click();
  await page.getByLabel('Đầu vào', { exact: true }).nth(0).fill('1 2\n');
  await page.getByLabel('Đáp án', { exact: true }).nth(0).fill('3\n');
  await page.getByLabel('Điểm của test 1').fill('50');
  await page.getByLabel('Đầu vào', { exact: true }).nth(1).fill('-7 4\n');
  await page.getByLabel('Đáp án', { exact: true }).nth(1).fill('-3\n');
  await page.getByLabel('Điểm của test 2').fill('50');
  await expect(page.getByText('2 test, tổng 100 điểm')).toBeVisible();
  await page.getByLabel('Ghi chú phiên bản').fill('B-24 authoring probe');
  await page.getByLabel('Công bố phiên bản này ngay').check();
  await page.getByRole('button', { name: 'Tạo phiên bản' }).click();
  await expect(page.getByText('Đã tạo và công bố phiên bản 1.')).toBeVisible({ timeout: 90_000 });

  // A pupil who never saw the authoring solves it to AC, through the submit UI.
  // Seated by the ADMIN, because a closed judge admits nobody else (D200).
  const boot = await actorContext(admin.username, admin.password);
  await ensureAccount(boot, 'rehearse-solo');
  await boot.dispose();
  await page.goto('/');
  await page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.locator('#identifier')).toBeVisible();
  await signIn(page, 'rehearse-solo', PASSWORD);
  await page.goto(`/submit?problem=${AUTHORED}`);
  await page.locator('#source').fill(AC_SOURCE);
  await submitAndExpectAC(page);
  await expect(page.getByText(/Không nhận được cập nhật trực tiếp/)).toHaveCount(0);

  expect(watch.errors).toEqual([]);
});

test('journey 2 — a frozen ICPC team round renders team names, the monitor, and the freeze', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED], CONSOLE_ALLOW);
  const adminCtx = await actorContext(admin.username, admin.password);

  // Fixed pupils, meter-safe. rehearse-a* on Alpha, rehearse-b* on Bravo.
  for (const u of ['rehearse-a1', 'rehearse-a2', 'rehearse-b1', 'rehearse-b2']) {
    await ensureAccount(adminCtx, u);
  }
  // No re-authentication here any more: `ensureAccount` signs the pupil in on
  // a throwaway context of its own, so this one is still the admin — which it
  // has to be, since it is the caller a closed judge admits (D200).

  // The org and its roster (idempotent — the org and members may already exist).
  const orgRes = await adminCtx.post('/api/v1/orgs', {
    headers: SAME_ORIGIN,
    data: { slug: ORG, name: 'Rehearsal Provincial School', visibility: 'private', joinPolicy: 'invite' },
  });
  expect([201, 409]).toContain(orgRes.status());
  for (const u of ['rehearse-a1', 'rehearse-a2', 'rehearse-b1', 'rehearse-b2']) {
    const r = await adminCtx.post(`/api/v1/orgs/${ORG}/members`, { headers: SAME_ORIGIN, data: { username: u } });
    expect([201, 409]).toContain(r.status());
  }
  for (const [slug, name, members] of [
    [TEAM_A, 'Team Alpha', ['rehearse-a1', 'rehearse-a2']],
    [TEAM_B, 'Team Bravo', ['rehearse-b1', 'rehearse-b2']],
  ] as const) {
    const r = await adminCtx.post(`/api/v1/orgs/${ORG}/teams`, { headers: SAME_ORIGIN, data: { slug, name, members } });
    expect(r.ok(), `create team ${slug}: ${String(r.status())}`).toBe(true);
  }

  // A team contest that is ALREADY inside its freeze window: start two minutes
  // ago, freeze longer than it has run, so `frozenAt` is in the past and every
  // submission from here is late — the rival-sees-a-freeze case with no wait.
  const now = Date.now();
  const contest = await adminCtx.post('/api/v1/contests', {
    headers: SAME_ORIGIN,
    data: {
      key: TEAM_KEY,
      name: `Contest-day ICPC ${RUN}`,
      startTime: new Date(now - 2 * 60_000).toISOString(),
      endTime: new Date(now + 30 * 60_000).toISOString(),
      format: 'icpc',
      frozenLastMinutes: 31,
      participationMode: 'team',
      maxTeamSize: 2,
      orgSlugs: [ORG],
      visibility: 'org',
      problems: [
        { code: AUTHORED, points: 100 },
        { code: 'aplusb', points: 100 },
      ],
    },
  });
  expect(contest.ok(), `create team contest: ${String(contest.status())} ${await contest.text()}`).toBe(true);

  // The organiser seeds both teams (D99/F-25), so no pupil has to press Join.
  for (const slug of [TEAM_A, TEAM_B]) {
    const r = await adminCtx.post(`/api/v1/contests/${TEAM_KEY}/participants`, {
      headers: SAME_ORIGIN,
      data: { teamSlug: slug },
    });
    expect(r.ok(), `seed ${slug}: ${String(r.status())} ${await r.text()}`).toBe(true);
  }

  // A Bravo member submits a late (frozen) AC to aplusb.
  const bravo = await actorContext('rehearse-b1');
  const sub = await bravo.post('/api/v1/submissions', {
    headers: SAME_ORIGIN,
    data: { problemCode: 'aplusb', languageKey: 'cpp17', source: AC_SOURCE, contestKey: TEAM_KEY },
  });
  expect(sub.ok(), `bravo submit: ${String(sub.status())} ${await sub.text()}`).toBe(true);
  const subId = ((await sub.json()) as { id: number }).id;
  bravoLateVerdict = await waitForVerdict(bravo, subId);
  expect(bravoLateVerdict).toBe('AC');
  await bravo.dispose();

  // ── the organiser's scoreboard: team NAMES, and the freeze banner ────
  await signIn(page, admin.username, admin.password);
  await page.goto(`/contests/${TEAM_KEY}/scoreboard`);
  await expect(page.getByRole('heading', { name: 'Bảng điểm' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Team Alpha', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Team Bravo', exact: true })).toBeVisible();
  // The print stylesheet (D121): under print media the floating glass nav is
  // gone, so a Ctrl-P scoreboard is clean paper. jsdom never matches
  // `@media print`; only a real browser proves the block applied. Restore the
  // medium immediately so the rest of this test runs on screen.
  await page.emulateMedia({ media: 'print' });
  await expect
    .poll(() => page.locator('nav.shell-nav').evaluate((el) => getComputedStyle(el).display))
    .toBe('none');
  await page.emulateMedia({ media: null });
  // No freeze banner here on purpose: the organiser's board is UNFROZEN
  // (D22/D23). The banner is asserted below on the rival's view, where it is.

  // ── the organiser's monitor: room count + per-problem counters + the real
  //    (unfrozen) verdict in the feed ───────────────────────────────────
  await page.goto(`/contests/${TEAM_KEY}/monitor`);
  await expect(page.getByRole('heading', { name: 'Theo dõi trực tiếp' })).toBeVisible();
  await expect(page.getByText('Thí sinh đang kết nối')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Các bài' })).toBeVisible();
  // aplusb's row shows one submitted and one accepted, unfrozen (D22).
  const aplusbRow = page.getByRole('row').filter({ hasText: 'aplusb' }).first();
  await expect(aplusbRow).toBeVisible();
  await expect(page.getByText('AC', { exact: true }).first()).toBeVisible();

  // ── a rival (Alpha) gets the freeze: the banner IS shown to a competitor,
  //    where the organiser's board above had none (D22/D23). A new page in this
  //    context would share the organiser's cookie, so the rival signs in here.
  await signOut(page);
  await signIn(page, 'rehearse-a1', PASSWORD);
  await page.goto(`/contests/${TEAM_KEY}/scoreboard`);
  await expect(page.getByRole('status')).toContainText('đóng băng');
  await expect(page.getByRole('link', { name: 'Team Bravo', exact: true })).toBeVisible();

  await adminCtx.dispose();
  expect(watch.errors).toEqual([]);
});

test('journey 3 — the Q&A panel: a member asks, the organiser answers and announces, both are seen', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED], CONSOLE_ALLOW);
  const question = `Câu hỏi B-24 ${RUN}`;
  const answer = `Trả lời B-24 ${RUN}`;
  const notice = `Thông báo B-24 ${RUN}`;

  // A seeded Alpha member asks on the contest page.
  await signIn(page, 'rehearse-a2', PASSWORD);
  await page.goto(`/contests/${TEAM_KEY}`);
  await expect(page.getByRole('status').first()).toContainText('Đang thi');
  await page.getByRole('textbox', { name: 'Hỏi ban tổ chức' }).fill(question);
  await page.getByRole('button', { name: 'Gửi', exact: true }).click();
  await expect(page.locator('article').filter({ hasText: question })).toBeVisible();

  // The organiser answers, publishes, and posts an announcement.
  await signOut(page);
  await signIn(page, admin.username, admin.password);
  await page.goto(`/contests/${TEAM_KEY}`);
  const row = page.locator('article').filter({ hasText: question });
  await row.locator('textarea').fill(answer);
  await row.getByRole('button', { name: 'Trả lời', exact: true }).click();
  await row.getByRole('button', { name: 'Công bố' }).click();
  await expect(row.getByText('Công khai')).toBeVisible();
  await page.getByRole('textbox', { name: 'Đăng thông báo' }).fill(notice);
  await page.getByRole('button', { name: 'Đăng', exact: true }).click();
  await expect(page.locator('article').filter({ hasText: notice })).toBeVisible();

  // The asker's teammate sees the answer; a Bravo rival sees the published
  // answer AND the announcement — it reached everyone.
  await signOut(page);
  await signIn(page, 'rehearse-a2', PASSWORD);
  await page.goto(`/contests/${TEAM_KEY}`);
  await expect(page.locator('article').filter({ hasText: answer })).toBeVisible();
  await expect(page.locator('article').filter({ hasText: notice })).toBeVisible();

  await signOut(page);
  await signIn(page, 'rehearse-b2', PASSWORD);
  await page.goto(`/contests/${TEAM_KEY}`);
  await expect(page.locator('article').filter({ hasText: answer })).toBeVisible();
  await expect(page.locator('article').filter({ hasText: notice })).toBeVisible();

  expect(watch.errors).toEqual([]);
});

test('journey 4 — the ordinary individual public contest still works end to end', async ({ page }) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED, SUBMIT_METERED], CONSOLE_ALLOW);
  const adminCtx = await actorContext(admin.username, admin.password);
  const now = Date.now();
  const created = await adminCtx.post('/api/v1/contests', {
    headers: SAME_ORIGIN,
    data: {
      key: OPEN_KEY,
      name: `Contest-day open ${RUN}`,
      startTime: new Date(now - 60_000).toISOString(),
      endTime: new Date(now + 3_600_000).toISOString(),
      format: 'icpc',
      visibility: 'public',
      problems: [{ code: 'aplusb', points: 100 }],
    },
  });
  expect(created.ok(), `create open contest: ${String(created.status())} ${await created.text()}`).toBe(true);
  await adminCtx.dispose();

  // A pupil joins through the UI and submits into the contest.
  await signIn(page, 'rehearse-solo', PASSWORD);
  await page.goto(`/contests/${OPEN_KEY}`);
  await page.getByRole('button', { name: 'Tham gia', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Đang thi');
  await page.goto(`/submit?problem=aplusb&contest=${OPEN_KEY}`);
  await page.locator('#source').fill(AC_SOURCE);
  await submitAndExpectAC(page);

  // The individual scoreboard shows the USERNAME (no team map).
  await page.goto(`/contests/${OPEN_KEY}/scoreboard`);
  await expect(
    page.getByRole('table').getByRole('link', { name: 'rehearse-solo', exact: true }),
  ).toBeVisible();

  expect(watch.errors).toEqual([]);
});
