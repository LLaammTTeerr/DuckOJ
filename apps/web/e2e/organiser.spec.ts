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
 * The two organiser screens `docs/PROVINCE-READINESS.md` has carried as
 * unproven since 29 August — the live monitor and the team roster — walked as
 * a teacher against the live composed stack (loop F-42).
 *
 * The readiness note was only half right by the time this was written.
 * `contest-day.spec.ts` journey 2 already opens the monitor and
 * `features.spec.ts` feature 10 already runs a similarity check and reads the
 * matched spans, so neither route is untouched. What neither of them does is
 * the thing that makes a monitor worth having on contest day:
 *
 *  - **the monitor's numbers are never compared with anything.** Journey 2
 *    asserts that the headings, a room-count tile and an `AC` badge are on
 *    screen. Every one of those survives a panel that renders the wrong
 *    contest's counters, a `solvers` column wired to `accepted`, or a feed
 *    that quietly stopped refreshing an hour ago. This file reads
 *    `GET /contests/{key}/monitor` and asserts the SCREEN AGREES WITH IT,
 *    cell by cell, and then that a submission made while the page is open
 *    reaches the feed with no navigation at all.
 *  - **no team was ever assembled through the form.** Journey 2 seeds its two
 *    teams over the API, so `TeamForm` — the only surface a provincial
 *    teacher has — had never been driven, and D101/D104's one-seat rule had
 *    never been shown to be VISIBLE to the person it refuses. It is enforced
 *    in three places (two service checks and a primary key); a teacher who is
 *    never told which pupil is double-entered cannot fix it.
 *
 * ## D100, and the assertion this file deliberately does NOT make
 *
 * The per-problem panel is a maintained counter (`contest_problem_stats`),
 * and the queue depth is a live count of unfinished jobs across the whole
 * deployment. They answer different questions and are allowed to disagree —
 * a problem's `pending` can be zero while the queue is deep with another
 * contest's work, and the queue can be empty while a counter is a
 * transaction behind. So nothing here ties one to the other. What IS asserted
 * is that each number equals the number the API served for it, which is the
 * property a wrong wiring breaks and an honest disagreement does not.
 *
 * ## Contract, shared with the rest of `e2e/`
 *
 * Serial, Vietnamese locators, `RUN`-stamped names, zero console errors and
 * zero unexpected 4xx per page. **Meter-safe (D26):** registration is 30/IP/
 * hour and burns even on a 409, so the pupils are FIXED `fe42-*` accounts
 * reached login-first — a first run on a clean stack registers them once and
 * every run after costs the meter nothing. Every row this file creates is
 * named for `scripts/cleanup-test-data.ts`'s `fe<n>` patterns (D153).
 */
test.describe.configure({ mode: 'serial' });

// A judged submission is a compile plus a sandboxed run through a real
// sandbox, and journey 1 waits for three of them.
test.setTimeout(300_000);

const RUN = Date.now();
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const SAME_ORIGIN = { origin: ORIGIN } as const;
const PASSWORD = 'fe42-not-a-real-password-2026';

/** D153: `^fe[0-9]+` for accounts, `^fe[0-9]+-` for everything else. */
const ORG = 'fe42-truong';
const MONITOR_KEY = `fe42-monitor-${RUN}`;
const TEAM_KEY = `fe42-thi-doi-${RUN}`;

/**
 * **The two teams this walk KEEPS, and why they stopped being per-run.**
 *
 * Journey 2 seats a pair of teams in a contest, and D101 rightly refuses to
 * delete a team that has competed — so `test.afterAll`'s delete loop could
 * never reach them and every run left two more behind. On 2026-09-02 the one
 * shared school held **32** of them, all undeletable by design, growing by two
 * a run, on a list that pages at twenty-five. That is the same self-inflicted
 * failure the teardown was written to prevent (a walk whose own history moves
 * its row off page one), arriving by a door the teardown cannot close.
 *
 * The fix is not a bigger delete loop. It is a fixture the walk can afford to
 * LEAVE: two teams with stable slugs, get-or-created every run, rosters reset
 * to a known state, and never deleted. Two forever instead of two more.
 *
 * The slugs deliberately do NOT begin `fe42-alpha`/`fe42-bravo`: the 32 rows
 * already on the live host are slugged that way, and `hasText` is a SUBSTRING
 * match, so a stable `fe42-alpha` would select 17 rows and every row lookup in
 * this file would be ambiguous. They still match `^fe[0-9]+-`, so D153's
 * inventory classifies them exactly as it did before.
 */
const ALPHA = 'fe42-doi-a';
const BRAVO = 'fe42-doi-b';
const ALPHA_NAME = 'FE42 Đội A';
const BRAVO_NAME = 'FE42 Đội B';

/**
 * The team the CREATE form is exercised on, and the one whose record is
 * asserted empty.
 *
 * Per-run, because both of those assertions are about a team that has just
 * come into existence: "Lập đội" cannot be walked against a slug that already
 * exists, and "this team has entered no contest" stops being true of anything
 * this walk seats. It is never seated, so D101 lets the teardown delete it and
 * it leaves nothing behind.
 */
const FRESH = `fe42-moi-${RUN}`;
const PUPILS = ['fe42-a1', 'fe42-a2', 'fe42-c1'] as const;

/** A+B, correct — what `aplusb`, the seeded public problem, wants. */
const AC_SOURCE = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`;
/** Deliberately wrong, so `accepted` and `submitted` cannot be the same number. */
const WA_SOURCE = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1<<"\\n";}`;

/** `GET /contests/{key}/me` 404s until the viewer has joined — by design. */
const NOT_JOINED: Allowance = { status: 404, url: /\/contests\/[^/]+\/me/ };
/**
 * The one-seat refusal IS a 409 on the roster PATCH — the finding journey 2
 * exists to see, so the watchdog is told to expect it on that route and that
 * status alone. A 500 there still fails the test.
 */
const SEAT_REFUSED: Allowance = { status: 409, url: /\/orgs\/[^/]+\/teams/ };

/**
 * D120 — a stack still serving the pre-fix Caddyfile blocks index.html's
 * D116 pre-paint theme script, and every page logs one CSP violation for it.
 * Tolerated by its exact text, as `contest-day.spec.ts` does, and nothing
 * else is.
 */
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

/** Log a fixed account in over the API; register it only if it does not exist. */
async function ensureAccount(ctx: APIRequestContext, username: string): Promise<void> {
  const login = async (): Promise<boolean> => {
    const res = await ctx.post('/api/v1/auth/login', {
      headers: SAME_ORIGIN,
      data: { usernameOrEmail: username, password: PASSWORD },
    });
    return res.ok();
  };
  if (await login()) return;
  const reg = await ctx.post('/api/v1/auth/register', {
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

/**
 * Submit and wait for a terminal grade.
 *
 * D80 meters submissions at one per ten seconds PER PERSON, so a refusal is
 * waited out and retried rather than failing the walk — the same thing a
 * competitor does on contest day.
 */
async function submitAndGrade(
  ctx: APIRequestContext,
  data: Record<string, unknown>,
): Promise<{ id: number; verdict: string }> {
  let id = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await ctx.post('/api/v1/submissions', { headers: SAME_ORIGIN, data });
    if (res.ok()) {
      id = ((await res.json()) as { id: number }).id;
      break;
    }
    expect(res.status(), `submit: ${String(res.status())} ${await res.text()}`).toBe(429);
    await new Promise((r) => setTimeout(r, 11_000));
  }
  expect(id, 'the submit meter never let a submission through').toBeGreaterThan(0);
  const deadline = Date.now() + 180_000;
  for (;;) {
    const res = await ctx.get(`/api/v1/submissions/${String(id)}`);
    const body = (await res.json()) as { state: string; verdict: string | null };
    if (body.state === 'done' || body.state === 'errored') {
      return { id, verdict: body.verdict ?? body.state };
    }
    if (Date.now() > deadline) throw new Error(`submission ${String(id)} never finished`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * The team form's roster box — **by ROLE and accessible name, never by label
 * text (B-34).**
 *
 * `getByLabel` matches the LABEL ELEMENT'S TEXT, and `TeamForm` wraps its
 * control:
 *
 *     <label>Thành viên <textarea …/></label>
 *
 * React mirrors a controlled `<textarea>`'s value into the element's CHILD
 * TEXT NODE — `element.defaultValue = value`, and the HTML spec makes
 * `defaultValue` the setter for the textarea's child text content — on the
 * first mount and again on every update. So the moment the box holds a
 * roster, the label's own `textContent` is `"Thành viên fe42-a1"`, and
 * `getByLabel('Thành viên', { exact: true })` matches NOTHING. Measured on
 * the live edge: `label.textContent === "Thành viên fe42-a1"`,
 * `getByLabel` exact `0`, `getByRole('textbox')` exact `1`.
 *
 * That is why journey 2 went red at `e11188d` and 2b with it: `exact: true`
 * was the right answer to the loose locator matching the org roster's own
 * "Tìm thành viên" search box as well (2 hits, strict-mode violation), and it
 * traded that collision for a locator that only ever matches an EMPTY box —
 * which is why the create form's `fill` kept working and every read of a
 * seeded box stopped.
 *
 * The accessible name is computed by the accname algorithm, which leaves an
 * embedded control's own value out of its own name, so it is `"Thành viên"`
 * in every state — empty, seeded or typed-into. It is also what a screen
 * reader announces, which makes it the honest thing for a walk to assert on.
 *
 * `<input>` is not affected: an input's value is a property with no child
 * text, so `getByLabel('Định danh')` above is fine. The trap is a `<label>`
 * that WRAPS a `<textarea>`; every other textarea in this app is associated
 * by `htmlFor`/`id` instead, which is why nothing else in `e2e/` hits it.
 */
function rosterBox(page: Page) {
  return page.getByRole('textbox', { name: 'Thành viên', exact: true });
}

/**
 * Press Save on the teams form and wait for the roster PATCH to come back,
 * so what follows is asserted against a save that has LANDED rather than
 * against a race with it.
 */
async function saveRoster(page: Page, teamSlug: string): Promise<number> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && res.url().includes(`/teams/${teamSlug}`),
    ),
    page.getByRole('button', { name: 'Lưu' }).click(),
  ]);
  return response.status();
}

interface MonitorBody {
  participantsOnline: number;
  queue: { depth: number; oldestPendingSeconds: number | null };
  problems: {
    code: string;
    submitted: number;
    accepted: number;
    solvers: number;
    pending: number;
  }[];
  feed: { submissionId: number; username: string; verdict: string | null }[];
}

/* ── 1 — the live monitor ────────────────────────────────────────────── */

test('journey 1 — the monitor’s numbers are the API’s numbers, and the feed is live', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED], CONSOLE_ALLOW);
  const admin = adminCredentials();
  const adminCtx = await actorContext(admin.username, admin.password);

  const boot = await playwrightRequest.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { Origin: ORIGIN },
  });
  for (const pupil of PUPILS) await ensureAccount(boot, pupil);
  await boot.dispose();

  // A round that is ALREADY running: started two minutes ago so entrants can
  // join and submit with no wait, and long enough that nothing expires
  // underneath the walk.
  const now = Date.now();
  const created = await adminCtx.post('/api/v1/contests', {
    headers: SAME_ORIGIN,
    data: {
      key: MONITOR_KEY,
      name: `FE42 theo dõi ${RUN}`,
      // Started two minutes ago so entrants can join and submit with no
      // wait; twelve minutes long, which is more than this walk needs and
      // keeps a test round off the province's contest list for the rest of
      // the afternoon.
      startTime: new Date(now - 2 * 60_000).toISOString(),
      endTime: new Date(now + 12 * 60_000).toISOString(),
      format: 'icpc',
      visibility: 'public',
      problems: [{ code: 'aplusb', points: 100 }],
    },
  });
  expect(
    created.ok(),
    `create contest: ${String(created.status())} ${await created.text()}`,
  ).toBe(true);

  // Two entrants, four graded attempts: WA then AC then AC from the first, one
  // AC from the second. That is deliberately the shape in which `submitted`,
  // `accepted` and `solvers` are three PAIRWISE DIFFERENT numbers — 4, 3 and
  // 2 — because each of the cheaper shapes leaves a miswiring invisible. A
  // room where everybody was right first time makes submitted = accepted; one
  // AC each makes accepted = solvers, and `solvers` reading `accepted` is the
  // column-crossing this panel is most likely to get wrong (D100 keeps
  // `solvers` in a SET, on its own table, for exactly the reason it cannot be
  // derived from the other two). The second AC from the same person is what
  // separates them.
  const a1 = await actorContext('fe42-a1');
  const a2 = await actorContext('fe42-a2');
  for (const [who, ctx] of [
    ['fe42-a1', a1],
    ['fe42-a2', a2],
  ] as const) {
    const joined = await ctx.post(`/api/v1/contests/${MONITOR_KEY}/join`, {
      headers: SAME_ORIGIN,
      data: {},
    });
    expect(joined.ok(), `${who} join: ${String(joined.status())} ${await joined.text()}`).toBe(true);
  }
  const attempt = { problemCode: 'aplusb', languageKey: 'cpp17', contestKey: MONITOR_KEY };
  expect((await submitAndGrade(a1, { ...attempt, source: WA_SOURCE })).verdict).toBe('WA');
  expect((await submitAndGrade(a1, { ...attempt, source: AC_SOURCE })).verdict).toBe('AC');
  // The same person, accepted a second time: `accepted` moves and `solvers`
  // must not.
  expect((await submitAndGrade(a1, { ...attempt, source: AC_SOURCE })).verdict).toBe('AC');
  expect((await submitAndGrade(a2, { ...attempt, source: AC_SOURCE })).verdict).toBe('AC');

  // ── the screen ─────────────────────────────────────────────────────
  await signIn(page, admin.username, admin.password);
  await page.goto(`/contests/${MONITOR_KEY}/monitor`);
  await expect(page.getByRole('heading', { name: 'Theo dõi trực tiếp' })).toBeVisible();

  // ONE read of the API, taken now that every job is terminal and nothing is
  // moving. Re-reading it inside a poll would be two moving numbers compared
  // with each other, which is how a real disagreement gets retried away.
  const served = (await (
    await page.request.get(`/api/v1/contests/${MONITOR_KEY}/monitor`)
  ).json()) as MonitorBody;
  const problem = served.problems.find((row) => row.code === 'aplusb');
  expect(problem, 'the monitor served no row for the contest’s only problem').toBeDefined();
  expect(
    [problem!.submitted, problem!.accepted, problem!.solvers, problem!.pending],
    'the walk graded 1 WA + 3 AC, two of them from the same person, before reading the panel',
  ).toEqual([4, 3, 2, 0]);

  // The panel, cell by cell against what the API said. `.num` is the class the
  // four counter columns carry, in the order the header declares them.
  const row = page.getByRole('row').filter({ hasText: 'aplusb' }).first();
  await expect(row).toBeVisible();
  for (const [index, [what, value]] of (
    [
      ['Lượt nộp', problem!.submitted],
      ['Được chấp nhận', problem!.accepted],
      ['Số người giải được', problem!.solvers],
      ['Đang chấm', problem!.pending],
    ] as const
  ).entries()) {
    await expect(row.locator('td.num').nth(index), `the "${what}" cell`).toHaveText(String(value));
  }
  // The bar is drawn from the same two numbers and names them, so a fill that
  // silently used the wrong pair would still be caught.
  await expect(
    row.getByRole('img', {
      name: `${String(problem!.accepted)} trên ${String(problem!.submitted)} lượt nộp được chấp nhận`,
    }),
  ).toBeVisible();

  // The tiles. `participantsOnline` is a floor and not a roster (D101) — the
  // point is that the screen prints the number the API served, whatever it is.
  //
  // The known flake vector, named rather than designed around: the queue depth
  // is FLEET-WIDE, so another loop submitting anywhere on this host between
  // the read above and the assertion below would move it, honestly, and this
  // line would fail for a reason that is not a bug. The per-problem counters
  // cannot drift that way — they belong to this contest and every job in it is
  // already terminal.
  for (const [label, value] of [
    ['Thí sinh đang kết nối', String(served.participantsOnline)],
    ['Đang chờ chấm', String(served.queue.depth)],
  ] as const) {
    await expect(
      page.locator('.stat').filter({ hasText: label }).locator('strong'),
      `the "${label}" tile`,
    ).toHaveText(value);
  }
  // D100: the per-problem `pending` above and the queue depth here are a
  // maintained counter and a live fleet-wide count. They are allowed to
  // disagree, and NOTHING in this file ties one to the other.

  // The feed carries the real verdicts, one row per graded attempt, newest
  // first — and it is the organiser's screen, so the freeze hides nothing.
  const feed = page
    .getByRole('table')
    .filter({ hasText: 'Kết quả' })
    .getByRole('row')
    .filter({ hasText: /fe42-a[12]/ });
  await expect(feed).toHaveCount(served.feed.length);
  const newest = served.feed[0]!;
  await expect(feed.first().getByRole('link', { name: newest.username })).toBeVisible();
  await expect(feed.first().locator('.badge')).toHaveText(newest.verdict ?? 'đang chấm');

  // ── live, without a navigation ─────────────────────────────────────
  //
  // The page is never reloaded from here. A fourth attempt is made over the
  // API and has to reach the screen by itself — the `watch-contest` socket
  // frame, or, if that never opened, the five-second poll. Either is the page
  // being live; a screen that needs an F5 is the failure this asserts against.
  const before = served.feed.length;
  const fourth = await submitAndGrade(a2, { ...attempt, source: WA_SOURCE });
  expect(fourth.verdict).toBe('WA');
  await expect(feed).toHaveCount(before + 1, { timeout: 30_000 });
  // And the counter moved with it, still without a navigation.
  await expect(row.locator('td.num').nth(0)).toHaveText(String(problem!.submitted + 1));

  await page.screenshot({ path: 'e2e/screenshots/f42-monitor.png', fullPage: true });
  await a1.dispose();
  await a2.dispose();
  await adminCtx.dispose();
  expect(watch.errors, `the monitor reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 2 — teams, and the one-seat rule a teacher can see ──────────────── */

test('journey 2 — a teacher assembles a team in the form, and the one-seat rule names the pupil', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED, SEAT_REFUSED], CONSOLE_ALLOW);
  const admin = adminCredentials();
  const adminCtx = await actorContext(admin.username, admin.password);

  // The pupils, login-first so a re-run costs the registration meter nothing.
  // Repeated here rather than shared with journey 1 so either walk can be run
  // on its own while this file is being developed.
  const boot = await playwrightRequest.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: { Origin: ORIGIN },
  });
  for (const pupil of PUPILS) await ensureAccount(boot, pupil);
  await boot.dispose();

  // The school and its roster — idempotent, because both may already exist
  // from an earlier run of this file.
  const orgRes = await adminCtx.post('/api/v1/orgs', {
    headers: SAME_ORIGIN,
    data: {
      slug: ORG,
      name: 'FE42 Trường thử nghiệm',
      visibility: 'private',
      joinPolicy: 'invite',
    },
  });
  expect([201, 409]).toContain(orgRes.status());
  for (const pupil of PUPILS) {
    const res = await adminCtx.post(`/api/v1/orgs/${ORG}/members`, {
      headers: SAME_ORIGIN,
      data: { username: pupil },
    });
    expect([201, 409], `add ${pupil} to ${ORG}: ${String(res.status())}`).toContain(res.status());
  }

  await signIn(page, admin.username, admin.password);
  await page.goto(`/orgs/${ORG}`);
  await expect(page.getByRole('heading', { name: 'Đội tuyển' })).toBeVisible();

  // ── assemble one, in the form ──────────────────────────────────────
  //
  // On the per-run team, not on the pair this walk keeps: "Lập đội" is a
  // CREATE, and a create form cannot be walked twice against the same slug.
  await page.getByRole('button', { name: 'Lập đội' }).click();
  await page.getByLabel('Định danh').fill(FRESH);
  await page.getByLabel('Tên đội').fill(`FE42 Đội mới ${RUN}`);
  // `rosterBox` rather than `getByLabel`: F-51 put a member SEARCH box on the
  // same screen labelled "Tìm thành viên", so the loose label locator matched
  // two controls — and the `exact: true` that fixed THAT matched none at all
  // as soon as the box held a roster. See `rosterBox` for the bytes. The
  // ambiguity was always the walk's to resolve, not the app's: two controls
  // about members on one screen is correct, and a reader is not confused by
  // them.
  await rosterBox(page).fill('fe42-a1');
  await page.getByRole('button', { name: 'Lưu' }).click();

  const freshRow = page.getByRole('row').filter({ hasText: FRESH });
  await expect(freshRow).toHaveCount(1);
  await expect(freshRow.getByRole('link', { name: `FE42 Đội mới ${RUN}` })).toBeVisible();
  await expect(freshRow.getByRole('link', { name: 'fe42-a1' })).toBeVisible();

  // ── add a member, in the form ──────────────────────────────────────
  //
  // `members` REPLACES the roster (the API says so and the form's own comment
  // says so), so adding one means sending both — which is exactly the shape a
  // teacher types, and exactly the shape that loses a pupil if the form ever
  // renders an empty box over a roster that failed to load.
  await freshRow.getByRole('button', { name: 'Sửa' }).click();
  await expect(rosterBox(page)).toHaveValue('fe42-a1');
  await rosterBox(page).fill('fe42-a1, fe42-a2');
  expect(await saveRoster(page, FRESH)).toBe(200);

  // The server first, so a trace of a failure here reads "server right,
  // screen wrong" rather than leaving the two indistinguishable.
  const saved = (await (await adminCtx.get(`/api/v1/orgs/${ORG}/teams/${FRESH}`)).json()) as {
    members: { username: string }[];
  };
  expect(saved.members.map((m) => m.username).sort()).toEqual(['fe42-a1', 'fe42-a2']);

  // The reload is here on purpose and is a POINTER, not a shrug: journey 2b
  // below asserts the panel shows the added pupil with NO reload, which is
  // what a teacher actually gets, and it is red against the deployed bundle
  // because the fix (`fix(teams): a roster saved in the form appears on the
  // panel that saved it`) has not shipped. Tighten this to drop the reload
  // once the edge carries it; the rest of this walk is about the one-seat
  // rule and must not be held hostage to that.
  await page.reload();
  await expect(freshRow.getByRole('link', { name: 'fe42-a2' })).toBeVisible();
  await expect(freshRow.getByRole('link', { name: 'fe42-a1' })).toBeVisible();

  // The team's own page — D99's "a team has a RECORD, and a record is a thing
  // you link to". It has entered nothing yet, and says so. This assertion is
  // on the per-run team for that reason alone: it is only ever true of a team
  // that has never competed, so it cannot live on a fixture the walk keeps.
  await freshRow.getByRole('link', { name: `FE42 Đội mới ${RUN}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: `FE42 Đội mới ${RUN}` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Các kỳ thi đã dự' })).toBeVisible();
  await expect(page.getByText('Đội này chưa dự kỳ thi nào.')).toBeVisible();

  // ── the two teams this walk keeps, and a round both of them enter ──
  //
  // Get-or-created, then their rosters PATCHed to the state the rest of this
  // walk assumes: 201 the first time this walk ever ran on this host, 409
  // every time since, and the roster reset either way so a previous run's
  // one-seat attempt cannot leave them in a shape that makes the refusal below
  // pass for the wrong reason. Both PATCHes happen BEFORE the contest exists,
  // so F-25's roster lock is not in play here.
  for (const team of [
    { slug: ALPHA, name: ALPHA_NAME, members: ['fe42-a1', 'fe42-a2'] },
    { slug: BRAVO, name: BRAVO_NAME, members: ['fe42-c1'] },
  ]) {
    const made = await adminCtx.post(`/api/v1/orgs/${ORG}/teams`, {
      headers: SAME_ORIGIN,
      data: { slug: team.slug, name: team.name, members: team.members },
    });
    expect(
      [201, 409],
      `create ${team.slug}: ${String(made.status())} ${await made.text()}`,
    ).toContain(made.status());
    if (made.status() === 409) {
      const reset = await adminCtx.patch(`/api/v1/orgs/${ORG}/teams/${team.slug}`, {
        headers: SAME_ORIGIN,
        data: { slug: team.slug, name: team.name, members: team.members },
      });
      expect(
        reset.ok(),
        `reset ${team.slug}: ${String(reset.status())} ${await reset.text()}`,
      ).toBe(true);
    }
  }

  const now = Date.now();
  const contest = await adminCtx.post('/api/v1/contests', {
    headers: SAME_ORIGIN,
    data: {
      key: TEAM_KEY,
      name: `FE42 đồng đội ${RUN}`,
      startTime: new Date(now - 2 * 60_000).toISOString(),
      endTime: new Date(now + 12 * 60_000).toISOString(),
      format: 'icpc',
      participationMode: 'team',
      maxTeamSize: 3,
      orgSlugs: [ORG],
      visibility: 'org',
      problems: [{ code: 'aplusb', points: 100 }],
    },
  });
  expect(
    contest.ok(),
    `create team contest: ${String(contest.status())} ${await contest.text()}`,
  ).toBe(true);
  for (const slug of [ALPHA, BRAVO]) {
    const seeded = await adminCtx.post(`/api/v1/contests/${TEAM_KEY}/participants`, {
      headers: SAME_ORIGIN,
      data: { teamSlug: slug },
    });
    expect(seeded.ok(), `seed ${slug}: ${String(seeded.status())} ${await seeded.text()}`).toBe(
      true,
    );
  }

  // The record the team page exists for, now that there is one — read on the
  // team that was just seated, which is the pair this walk keeps.
  await page.goto(`/orgs/${ORG}/teams/${ALPHA}`);
  await expect(page.getByRole('heading', { level: 1, name: ALPHA_NAME })).toBeVisible();
  await expect(page.getByRole('link', { name: `FE42 đồng đội ${RUN}` })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('đang thi');

  // ── the one-seat rule, as the teacher meets it ─────────────────────
  //
  // `fe42-c1` competes in this round on Bravo. Putting them on Alpha as well
  // would give one pupil two rows on one board, which is what D104's
  // `contest_seats` primary key makes unrepresentable — but a primary key
  // cannot say WHO, and the teacher standing at the machine is the person who
  // has to fix it. The refusal is the service check's, and it names them.
  //
  // The round is running, so F-25's roster lock would normally refuse this
  // first; the organiser running the contest is exempt, which is what puts
  // the seat rule in reach at all.
  await page.goto(`/orgs/${ORG}`);
  const alphaRow = page.getByRole('row').filter({ hasText: ALPHA });
  await expect(alphaRow).toHaveCount(1);
  await alphaRow.getByRole('button', { name: 'Sửa' }).click();
  // Wait for the prefill before typing over it, exactly as the first edit
  // above does. This walk typed straight after the click and B-33 is what it
  // caught: on a cold cache the form used to render an editable, EMPTY roster
  // box while `GET /orgs/{slug}/teams/{teamSlug}` was still in flight, and the
  // seed that landed afterwards replaced what had been typed without a word —
  // the PATCH then carried `["fe42-a1","fe42-a2"]` and came back 200 with the
  // roster unchanged, which reads exactly like the one-seat rule not firing.
  //
  // The wait is NOT the fix and must not be read as one: `TeamForm` no longer
  // renders a field before it holds the roster it is editing (D183), and
  // `test/teams-edit-seed-race.spec.tsx` is what guards that. This line only
  // stops the walk racing a prefill it never meant to be testing.
  await expect(rosterBox(page)).toHaveValue('fe42-a1, fe42-a2');
  await rosterBox(page).fill('fe42-a1, fe42-a2, fe42-c1');
  expect(await saveRoster(page, ALPHA), 'the one-seat rule answers 409, never 500').toBe(409);

  // Scoped to the alert that names the pupil, which is both the assertion and
  // the way past a page that may carry more than one `role="alert"`.
  const refusal = page.getByRole('alert').filter({ hasText: 'fe42-c1' });
  await expect(refusal, 'the refusal must name the pupil, not just say no').toBeVisible();

  // And it is a refusal, not a half-write: Alpha still has the two members it
  // had, read back through the API rather than off the screen that just
  // failed.
  const after = (await (
    await adminCtx.get(`/api/v1/orgs/${ORG}/teams/${ALPHA}`)
  ).json()) as { members: { username: string }[] };
  expect(after.members.map((m) => m.username).sort()).toEqual(['fe42-a1', 'fe42-a2']);

  await page.screenshot({ path: 'e2e/screenshots/f42-teams.png', fullPage: true });
  await adminCtx.dispose();
  expect(watch.errors, `the teams panel reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/* ── 2b — the defect journey 2 found, on its own so it blocks nothing ── */

/**
 * A roster saved in the form has to appear on the panel that saved it,
 * WITHOUT a reload.
 *
 * This is the F-42 finding, kept as its own walk rather than folded into
 * journey 2 because it began life **red against the deployed bundle by
 * design** — a defect demonstration must not stop the one-seat walk beside it
 * from running. **It has been green since F-42's fix reached the edge**, and
 * the sentence that used to say otherwise is gone rather than left to mislead
 * the next reader about which of these two walks is a known failure.
 *
 * It went red once more at `e11188d`, for nothing to do with the panel: the
 * exact label locator stopped matching a roster box that HELD a roster. See
 * `rosterBox`. B-34 measured this walk red beside journey 2, which the brief
 * for that slot had believed was passing — the two failed for one reason.
 *
 * What went wrong: `OrgTeams.refresh()` invalidated `['org-teams', slug]`, the
 * summary list, which carried a member COUNT and no names. The names came from
 * `TeamMembers`' own query under `['org-team', slug, teamSlug]`, and
 * invalidation matches by key PREFIX, so nothing ever invalidated it. The
 * teacher saw the count move and the names stay. (D182 has since put the names
 * on the summary, so `teamsKey(slug)` is what refreshes this row now — the
 * second invalidation still matters, because that key still backs the edit
 * form's prefill.)
 *
 * The severe half is not visible from here and is pinned in jsdom instead
 * (`test/teams-roster-refresh.spec.tsx`): the same stale entry prefills the
 * EDIT form, and `members` replaces the whole roster — so the next save writes
 * back the pre-edit list and silently drops the pupil just added. B-33 found a
 * second door onto that same loss and pinned it in
 * `test/teams-edit-seed-race.spec.tsx`.
 */
test('journey 2b — the panel shows the added pupil with no reload', async ({
  page,
}) => {
  const watch = watchForBrokenRequests(page, [NOT_JOINED], CONSOLE_ALLOW);
  const admin = adminCredentials();
  const adminCtx = await actorContext(admin.username, admin.password);
  const slug = `fe42-charlie-${RUN}`;

  const made = await adminCtx.post(`/api/v1/orgs/${ORG}/teams`, {
    headers: SAME_ORIGIN,
    data: { slug, name: `FE42 Charlie ${RUN}`, members: ['fe42-a1'] },
  });
  expect(made.ok(), `create ${slug}: ${String(made.status())} ${await made.text()}`).toBe(true);

  await signIn(page, admin.username, admin.password);
  await page.goto(`/orgs/${ORG}`);
  const row = page.getByRole('row').filter({ hasText: slug });
  await expect(row.getByRole('link', { name: 'fe42-a1' })).toBeVisible();

  await row.getByRole('button', { name: 'Sửa' }).click();
  await expect(rosterBox(page)).toHaveValue('fe42-a1');
  await rosterBox(page).fill('fe42-a1, fe42-a2');
  expect(await saveRoster(page, slug)).toBe(200);

  // The save landed — asserted against the server, so what follows is about
  // the screen and nothing else.
  const saved = (await (await adminCtx.get(`/api/v1/orgs/${ORG}/teams/${slug}`)).json()) as {
    members: { username: string }[];
  };
  expect(saved.members.map((m) => m.username).sort()).toEqual(['fe42-a1', 'fe42-a2']);

  await expect(
    row.getByRole('link', { name: 'fe42-a2' }),
    'the panel that saved the roster is still showing the roster it replaced',
  ).toBeVisible();

  await adminCtx.dispose();
  expect(watch.errors, `the teams panel reported: ${watch.errors.join(' | ')}`).toEqual([]);
});

/**
 * Delete the teams this run created.
 *
 * Without this the walk breaks ITSELF: every run adds three teams to the one
 * shared org, `GET /orgs/{slug}/teams` pages at 25, and on 2026-09-01 the
 * twenty-seventh team meant journey 2b's own row was no longer on the page it
 * navigates to — a green walk turning red from nothing but its own history.
 * The failure looked exactly like a regression in the roster panel it exists
 * to guard, which is the expensive kind of false signal.
 *
 * Teams, not contests: journeys 1 and 2 already close their contests, and a
 * team is the only fixture here with a DELETE and no cleanup. Failures are
 * swallowed — a walk that already failed must not be reported as failing in
 * teardown instead.
 *
 * **`ALPHA` and `BRAVO` are deliberately NOT in this list.** They are the two
 * teams journey 2 seats in a contest, D101 refuses to delete a team that has
 * competed, and this loop could therefore never delete them — it only looked
 * as though it might, which is how 32 of them accumulated. They are now stable
 * fixtures that every run reuses, so there is nothing here to delete: the
 * accumulation is fixed at its source rather than by a delete that was always
 * going to be refused.
 *
 * What is left are the two teams that never compete, which is exactly the
 * class a DELETE can reach.
 */
test.afterAll(async () => {
  const admin = adminCredentials();
  const ctx = await actorContext(admin.username, admin.password);
  for (const slug of [FRESH, `fe42-charlie-${RUN}`]) {
    try {
      await ctx.delete(`/api/v1/orgs/${ORG}/teams/${slug}`, { headers: SAME_ORIGIN });
    } catch {
      /* the walk's verdict is the walk's, not teardown's */
    }
  }
  await ctx.dispose();
});
