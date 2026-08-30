import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { adminCredentials } from './credentials.js';
import { watchForBrokenRequests } from './watch.js';

/**
 * D87/D88's authoring tab, walked end to end in a real browser (loop B-16).
 *
 * F-18 shipped "Dữ liệu chấm" with 14 jsdom tests and no browser journey at
 * all, and F-21 published its live problem through `POST /packages` instead —
 * so the one path a provincial setter with no shell actually takes had never
 * been executed against the composed stack. This is that execution: an admin
 * creates a problem, types two tests into the tab, publishes the revision it
 * builds, and a pupil who has never seen any of it submits a solution and
 * gets AC. Everything in between — the draft, the per-file PUTs, the
 * server-side `buildPackage`, the package store, the judge materialising the
 * archive — is exercised by that one chain and by nothing else here.
 *
 * Same contract as `features.spec.ts` and for the same reasons: serial,
 * Vietnamese locators, `RUN`-stamped names, zero console errors and zero
 * broken subresources per page.
 *
 * ONE registration (`bh16-*`): the meter is 30/IP/hour and shared with every
 * other journey file on this address (D26). The admin needs none — its
 * credentials come from the operator's secrets file, never from this source.
 */
test.describe.configure({ mode: 'serial' });

// A judged submission is a compile plus a sandboxed run, and the build in the
// middle tars and stores a package server-side.
test.setTimeout(240_000);

const RUN = Date.now();
const CODE = `bh16-ab-${RUN}`;
const PASSWORD = 'khong-phai-mat-khau-that-dau';
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const SAME_ORIGIN = { origin: ORIGIN } as const;

/**
 * The model solution ON DISK, as every other journey reads it: a source typed
 * into this file would drift from the program the project ships. It is `a+b`,
 * which is exactly what the two tests typed into the tab below describe.
 */
const AC_SOURCE = readFileSync(
  resolve(process.cwd(), '../../content/problems/tong-hai-so/solution.cpp'),
  'utf8',
);

const STATEMENT = [
  '# Tổng hai số (B-16)',
  '',
  'Cho hai số nguyên $a$ và $b$. Hãy in ra $a + b$.',
  '',
  '## English',
  '',
  'Given two integers, print their sum.',
  '',
].join('\n');

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(
    page.locator('nav.shell-nav').getByRole('button', { name: 'Đăng xuất' }),
  ).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/screenshots/b16-${name}.png`, fullPage: true });
}

/** Filled by journey 1, read by 2 and 3. */
let pupil = '';

test('journey 1 — an admin authors a problem entirely in the browser and publishes it', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page);
  const admin = adminCredentials();
  await signIn(page, admin.username, admin.password);

  // ── the problem row ──────────────────────────────────────────────────
  await page.goto('/problems/new');
  await page.locator('#problem-code').fill(CODE);
  await page.locator('#problem-name').fill(`B16 Tổng hai số ${RUN}`);
  await page.locator('#problem-statement').fill(STATEMENT);
  await page.locator('#problem-visibility').selectOption('public');
  await page.getByRole('button', { name: 'Tạo', exact: true }).click();
  await expect(page.getByText('Đã lưu.')).toBeVisible();

  // ── the test data, typed into the tab ────────────────────────────────
  await page.goto(`/problems/${CODE}/edit`);
  await page.getByRole('button', { name: 'Dữ liệu chấm' }).click();
  await expect(page.getByRole('heading', { name: 'Dữ liệu chấm' })).toBeVisible();

  await page.getByLabel('Giới hạn thời gian (ms)').fill('1000');
  await page.getByLabel('Giới hạn bộ nhớ (KB)').fill('65536');
  // The standard checker — token comparison — is the default and is asserted
  // rather than assumed: it is what makes this package need no testlib source
  // at all, and it is the manifest field the judge dispatches on.
  await expect(page.getByLabel('Trình chấm')).toHaveValue('standard');

  await page.getByRole('button', { name: 'Thêm test' }).click();
  await page.getByRole('button', { name: 'Thêm test' }).click();
  await page.getByLabel('Đầu vào').nth(0).fill('1 2\n');
  await page.getByLabel('Đáp án').nth(0).fill('3\n');
  await page.getByLabel('Điểm của test 1').fill('50');
  await page.getByLabel('Đầu vào').nth(1).fill('-7 4\n');
  await page.getByLabel('Đáp án').nth(1).fill('-3\n');
  await page.getByLabel('Điểm của test 2').fill('50');
  await expect(page.getByText('2 test, tổng 100 điểm')).toBeVisible();

  await page.getByLabel('Ghi chú phiên bản').fill('B-16 live probe');
  await page.getByLabel('Công bố phiên bản này ngay').check();
  await shot(page, 'testdata-filled');

  await page.getByRole('button', { name: 'Tạo phiên bản' }).click();
  // The whole server side in one assertion: a draft was opened, three files
  // (manifest + two cases × two files) were PUT into it, `buildPackage` ran
  // on the server, the archive was stored, a revision was attached and then
  // published — and the draft was deleted.
  await expect(page.getByText('Đã tạo và công bố phiên bản 1.')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'testdata-published');

  // ── D88's round trip, on the revision just made ──────────────────────
  await page.getByRole('button', { name: 'Tải từ phiên bản đã công bố' }).click();
  await expect(page.getByText('Đã tải dữ liệu chấm từ phiên bản 1.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByLabel('Đầu vào').nth(0)).toHaveValue('1 2\n');
  await expect(page.getByLabel('Đáp án').nth(1)).toHaveValue('-3\n');

  expect(watch.errors).toEqual([]);
});

test('journey 2 — the published problem reads as a live problem to everyone', async ({ page }) => {
  const watch = watchForBrokenRequests(page);
  await page.goto(`/problems/${CODE}`);
  // Anonymous, on purpose: the limits and the test count come from the
  // revision the tab built, and a reader who was never signed in is the
  // hardest audience for a problem published through a draft.
  await expect(page.getByRole('heading', { name: `B16 Tổng hai số ${RUN}` })).toBeVisible();
  await expect(page.getByText('Tổng hai số (B-16)')).toBeVisible();
  expect(watch.errors).toEqual([]);
});

test('journey 3 — a pupil solves it to AC against the tests typed in the browser', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page);
  pupil = `bh16-pupil-${RUN}`;
  const registered = await page.request.post('/api/v1/auth/register', {
    headers: SAME_ORIGIN,
    data: {
      username: pupil,
      email: `${pupil}@example.invalid`,
      password: PASSWORD,
      displayName: `BH16 pupil ${RUN}`,
    },
  });
  expect(registered.ok(), `register ${pupil}: ${String(registered.status())}`).toBe(true);

  await signIn(page, pupil, PASSWORD);
  await page.goto(`/submit?problem=${CODE}`);
  await page.locator('#source').fill(AC_SOURCE);
  await page.getByRole('button', { name: 'Nộp bài', exact: true }).click();
  await expect(page.getByText(/Không nhận được cập nhật trực tiếp/)).toHaveCount(0);
  await expect(page.locator('.badge')).toHaveText('AC', { timeout: 120_000 });
  await shot(page, 'pupil-ac');

  expect(watch.errors).toEqual([]);
});
