import { expect, test, type Page } from '@playwright/test';

/**
 * What these cover that the jsdom suites cannot.
 *
 * jsdom executes the bundle. It does not paint, does not load stylesheets,
 * does not run layout, and does not report a console error the app swallowed.
 * So it cannot see: a CSS file that 404'd behind Caddy, KaTeX rendering every
 * formula twice (its MathML copy is hidden by a stylesheet — without that
 * stylesheet the page shows every formula twice, which is wrong *content*,
 * not merely unstyled content), or a page that renders an error state while
 * still returning HTTP 200.
 *
 * Two real bugs this phase were found by a human opening the page rather than
 * by any automated check. These exist so the next one is not.
 */

const SEED_PROBLEM = 'aplusb';

/** Fails the test if the page logged an error or failed to fetch a subresource. */
function watchForBrokenRequests(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (msg) => {
    // Chromium emits "Failed to load resource: ..." for every non-2xx
    // response, with no URL attached. That is a duplicate of the `response`
    // handler below, which DOES carry the URL and can therefore be filtered
    // precisely. Keeping both meant an expected 401 was unfilterable and all
    // three page tests failed on it while every real assertion passed.
    if (msg.type() !== 'error') return;
    if (msg.text().startsWith('Failed to load resource')) return;
    errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    // A 4xx/5xx on a subresource is the exact shape of the Caddy bugs this
    // project has shipped three times: the document loads, an asset does not.
    if (res.status() < 400) return;
    // `GET /auth/me` answering 401 to a signed-out visitor is the app working
    // as designed — every page issues it to decide whether to show a session.
    // It is the one expected failure, and it is scoped to that exact route and
    // status so a 500 there would still fail the test.
    if (res.status() === 401 && res.url().includes('/auth/me')) return;
    errors.push(`${res.status()} ${res.url()}`);
  });
  return { errors };
}

test('the problem list renders real rows, with styles applied', async ({ page }) => {
  const watch = watchForBrokenRequests(page);
  await page.goto('/problems');

  await expect(page.getByRole('heading', { name: 'Problems' })).toBeVisible();
  await expect(page.getByRole('link', { name: SEED_PROBLEM })).toBeVisible();

  // Proves the stylesheet actually loaded and applied. jsdom would pass this
  // page with no CSS at all; a real browser reports the computed value.
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont.length).toBeGreaterThan(0);

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

test('a problem page renders its statement, and KaTeX renders each formula once', async ({
  page,
  request,
}) => {
  // Find a problem whose statement actually contains maths. The seed problem
  // `aplusb` has none, and pointing this test at it made the KaTeX assertion
  // below unreachable — `count === 0` skipped the whole check, so the test
  // passed while proving nothing. Choosing the subject at runtime keeps it
  // honest as the seed data changes.
  const list = await request.get('/api/v1/problems?limit=100');
  expect(list.ok(), 'problem list must load').toBe(true);
  const { items } = (await list.json()) as { items: Array<{ code: string }> };

  let target: string | null = null;
  for (const item of items) {
    const detail = await request.get(`/api/v1/problems/${item.code}`);
    if (!detail.ok()) continue;
    const { statement } = (await detail.json()) as { statement: string };
    if (statement.includes('$')) {
      target = item.code;
      break;
    }
  }
  expect(
    target,
    'no visible problem has a $…$ statement, so the KaTeX rendering path is untested — seed one',
  ).not.toBeNull();

  const watch = watchForBrokenRequests(page);
  await page.goto(`/problems/${target}`);

  // Exactly one <h1>. The statement's own Markdown headings are demoted to
  // <h2> by renderStatement precisely so this holds — before that fix,
  // Chromium reported `getByRole('heading')` resolving to two elements,
  // because a statement opening with `# Title` injected a second page-level
  // heading. jsdom could not see the conflict; the accessibility tree can.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('link', { name: /submit a solution/i })).toBeVisible();

  // Maths must actually have rendered, not merely "not rendered wrongly".
  const katexNodes = page.locator('.katex');
  expect(await katexNodes.count(), 'statement contains $…$ so KaTeX must render').toBeGreaterThan(0);

  // The double-render check. `katex.renderToString` emits a VISIBLE html
  // rendering plus a MathML copy for accessibility, and only `katex.min.css`
  // hides the MathML one. If that stylesheet fails to load, every formula
  // appears twice — wrong *content*, not merely unstyled content, and
  // invisible to jsdom, which applies no stylesheets at all.
  //
  // Measure the rendered box, do NOT use Playwright's `:visible`. KaTeX hides
  // MathML with the visually-hidden pattern — `clip-path: inset(50%)`,
  // 1x1px, absolutely positioned — rather than `display: none`, because
  // screen readers must still reach it. Playwright counts any non-empty box
  // as visible, so `:visible` reports every MathML node and the assertion
  // fails against a perfectly working page. Without the stylesheet the box
  // would be full-size, which is exactly what this measures.
  const mathmlBox = await page.locator('.katex-mathml').first().boundingBox();
  expect(mathmlBox, 'MathML node should exist').not.toBeNull();
  expect(
    mathmlBox!.width,
    'MathML must be clipped to ~1px by katex.min.css; a full-width box means the stylesheet did not load and every formula renders twice',
  ).toBeLessThanOrEqual(2);

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

test('the site root offers a sign-in form, reachable from the problems pages', async ({ page }) => {
  const watch = watchForBrokenRequests(page);

  // The gap a human found by hand: the problems pages render outside the auth
  // gate, so without this link a signed-out visitor has no route to the login
  // form, which lives only at `/`.
  await page.goto('/problems');
  // Scoped to the shell nav, which now owns this link on every route. The
  // per-page copies were removed once the shell existed — two links to the
  // same place, one of which the next page forgets, is how the gap reopens.
  const signIn = page.locator('nav.shell-nav').getByRole('link', { name: /sign in/i });
  await expect(signIn).toBeVisible();
  await signIn.click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel(/username or email/i)).toBeVisible();
  await expect(page.getByLabel(/^password$/i)).toBeVisible();

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

test('the API reference loads and lists routes', async ({ page }) => {
  const watch = watchForBrokenRequests(page);
  await page.goto('/api/v1/docs');

  // Scalar renders asynchronously from the fetched document; wait for real
  // content rather than asserting on the 375-byte shell, which would pass
  // even if the viewer never initialised.
  await expect(page.locator('body')).toContainText(/DuckOJ/i, { timeout: 30_000 });

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

test('every route carries the shell: one nav, links that work, styles applied', async ({ page }) => {
  // The shell exists because the problems routes render outside the auth gate
  // and a signed-out visitor had no route back to `/`. A human found that by
  // clicking; this makes it a standing check for every route added from here.
  for (const path of ['/', '/problems', '/problems/aplusb', '/submissions']) {
    const watch = watchForBrokenRequests(page);
    await page.goto(path);

    const nav = page.locator('nav.shell-nav');
    await expect(nav, `no shell nav on ${path}`).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Problems' })).toBeVisible();

    // The stylesheet actually applied, not merely linked. jsdom would pass
    // this page with no CSS at all; only a real browser computes the value.
    const navBg = await nav.evaluate((el) => getComputedStyle(el).borderBottomWidth);
    expect(navBg, `shell stylesheet not applied on ${path}`).not.toBe('0px');

    // The column is constrained rather than running the full window width —
    // the one layout promise this shell makes.
    const main = page.locator('main');
    const box = await main.boundingBox();
    expect(box!.width, `main column unconstrained on ${path}`).toBeLessThanOrEqual(1000);

    expect(watch.errors, `${path} reported: ${watch.errors.join(' | ')}`).toEqual([]);
  }
});

test('the home page introduces the site instead of the submit form', async ({ page }) => {
  // `/` used to render the submit form directly — a Phase 1 scaffold from when
  // submitting was the only thing the app did. It offered to grade a solution
  // before showing what there was to solve.
  const watch = watchForBrokenRequests(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'DuckOJ' })).toBeVisible();
  await expect(page.getByRole('link', { name: /browse problems/i })).toBeVisible();

  // The submit form must NOT be here. Its language selector is the part unique
  // to it — the sign-in form below shares this page, so asserting on "no form"
  // would be wrong.
  await expect(page.locator('#language')).toHaveCount(0);

  // …and it must still exist on its own route.
  await page.goto('/submit');
  await expect(page.getByLabel(/username or email/i)).toBeVisible();

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/**
 * Regression coverage for the three problem-list bugs found by screenshotting
 * the running site (task report) — none of these was caught by the jsdom
 * suite, and none could be: they are about what actually paints.
 */
test('the problem list splits time and memory into separate right-aligned columns, memory in MB', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page);
  await page.goto('/problems');

  await expect(page.getByRole('columnheader', { name: 'Time' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Mem' })).toBeVisible();

  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: SEED_PROBLEM }) });
  // Seed problem `aplusb`: 1000 ms / 65536 KB — 64 MB, a whole number.
  await expect(row.getByRole('cell', { name: '1000 ms' })).toBeVisible();
  await expect(row.getByRole('cell', { name: '64 MB' })).toBeVisible();
  // The old concatenated "1000 ms / 65536 KB" cell, and raw KB anywhere, are
  // both gone.
  await expect(page.getByText(/65536/)).toHaveCount(0);
  await expect(page.getByText(/ms \//)).toHaveCount(0);

  // The Time/Mem headers are right-aligned tabular numerals — the whole
  // reason to split the column in the first place.
  const timeHeader = page.getByRole('columnheader', { name: 'Time' });
  await expect(timeHeader).toHaveClass(/num/);

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/**
 * `/submissions` — new this task (spec §3.3). Signed out it must show the
 * sign-in gate (same pattern as `/submit`, since `GET /submissions` 401s
 * signed out) rather than an empty table or a broken request.
 */
test('the submissions list is gated behind sign-in, like submit', async ({ page }) => {
  const watch = watchForBrokenRequests(page);
  await page.goto('/submissions');

  await expect(page.getByText(/sign in to see submissions/i)).toBeVisible();
  await expect(page.getByLabel(/username or email/i)).toBeVisible();
  // The shell nav still renders — signed-out gating is per-route content,
  // not a whole-app redirect.
  await expect(page.locator('nav.shell-nav').getByRole('link', { name: 'Submissions' })).toBeVisible();

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/**
 * Signed in, `/submissions` lists the caller's own submissions, newest
 * first, with a verdict rendered through the shared `.badge` glyph+colour
 * system — never a second, bespoke verdict renderer.
 *
 * Registers a fresh user rather than relying on any pre-seeded account, so
 * this is reproducible against any freshly-migrated stack, not just the one
 * a human happened to be screenshotting by hand.
 */
test('signed in, the submissions list shows my own submissions with a verdict badge', async ({ page }) => {
  const username = `e2esub${Date.now()}`;
  const password = 'a-long-enough-password';

  const reg = await page.request.post('/api/v1/auth/register', {
    data: { username, email: `${username}@example.com`, password, displayName: username },
  });
  expect(reg.ok(), `registration failed: ${reg.status()} ${await reg.text()}`).toBe(true);

  await page.goto('/');
  await page.locator('#identifier').fill(username);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Scoped to the shell nav — the home page's own body copy repeats
  // "Signed in as <name>" in a full sentence, which also matches this
  // pattern and turns an unscoped locator ambiguous (strict-mode violation).
  await expect(page.locator('nav.shell-nav').getByText(`Signed in as ${username}`)).toBeVisible();

  // `page.request` shares the browser context's cookies with `page` itself,
  // so this submission is made as the just-signed-in user — no separate
  // credential plumbing needed.
  const submit = await page.request.post('/api/v1/submissions', {
    data: {
      problemCode: SEED_PROBLEM,
      languageKey: 'cpp17',
      source: '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}',
    },
  });
  expect(submit.ok(), `submission failed: ${submit.status()} ${await submit.text()}`).toBe(true);
  const { id: submissionId } = (await submit.json()) as { id: number };

  const watch = watchForBrokenRequests(page);
  await page.goto('/submissions');

  await expect(page.getByRole('heading', { name: 'Submissions' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: String(submissionId) });
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: SEED_PROBLEM })).toBeVisible();
  // A verdict badge is present — pending (still grading) or a real verdict,
  // either way rendered through the one shared `.badge` class, not blank.
  await expect(row.locator('.badge')).toBeVisible();

  expect(watch.errors, `page reported: ${watch.errors.join(' | ')}`).toEqual([]);
});
