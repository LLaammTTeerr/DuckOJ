/**
 * End-to-end proof that Phase 4d works against the real stack: a competitor
 * joins a contest, submits into it, a real judge grades it, and the score
 * lands on the scoreboard.
 *
 *   register three users -> bootstrap an admin -> promote a setter ->
 *   author a PRIVATE problem and publish it -> create a public contest
 *   containing it -> prove the competitor cannot see the problem -> join ->
 *   prove they now can -> submit with `contestKey` -> real grading to AC ->
 *   read the score off the scoreboard -> submit again WITHOUT `contestKey`
 *   and prove the scoreboard does not move.
 *
 * The last step is the one worth having. Phase 4d chose an explicit
 * `contestKey` over DMOJ's hidden `current_contest`, and the cost of that
 * choice is precisely that a participant who omits it is practising. A unit
 * test asserts it; this asserts it through the whole stack.
 *
 * The problem stays **private** throughout: it is visible only because the
 * contest grants access to its own problems. A contest whose problems are
 * already public is a contest whose problems leaked before it started.
 *
 * Sibling of `scripts/e2e-problem.ts` and `scripts/e2e-submit.ts`, and
 * deliberately shaped like them: it needs the whole compose stack, a real
 * judge and a real sandbox, so it cannot run in ordinary CI and its output is
 * pasted into the acceptance report. The three scripts each carry their own
 * copy of the session/assertion harness, which is the existing convention
 * here and is worth collapsing into `scripts/lib/` at some point.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildPackage } from './lib/build-package.js';

const execFileAsync = promisify(execFile);

// Rootless Podman cannot bind privileged ports without extra host
// configuration (see docs/runbook.md), so docker-compose.yml maps Caddy to
// 8080:80 and 8443:443, not 80/443.
const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'duckoj_session';
const PASSWORD = 'a-long-enough-password';

/**
 * The compose project name podman-compose derives from the repo directory's
 * basename — the same derivation `scripts/compose-up.sh` does
 * (`PROJECT=$(basename "$PWD")`), computed from this file's own location so
 * it does not depend on the working directory the script is invoked from.
 */
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROJECT = process.env.COMPOSE_PROJECT ?? basename(resolve(REPO_ROOT));

// The stack terminates TLS with a self-signed certificate under Caddy. This
// disables certificate verification for the WHOLE process — acceptable only
// because this throwaway script talks exclusively to a local self-signed
// stack. Never copy this line into anything that also talks to the internet.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CORRECT = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`;


/**
 * One cookie jar per actor. `scripts/e2e-submit.ts` keeps a single module-level
 * cookie because it only ever has one user; this script juggles three
 * (an admin, a setter, and an unprivileged viewer) and a shared jar would
 * silently make every request run as whoever logged in last — the failure
 * mode being a green run that proved nothing about authorization.
 */
class Session {
  private cookie = '';

  async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(this.cookie ? { cookie: this.cookie } : {}) };
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
      headers[k] = v;
    const res = await fetch(`${BASE}/api/v1${path}`, { ...init, headers, redirect: 'follow' });
    // `getSetCookie()`, not `headers.get('set-cookie')`: the latter joins
    // multiple Set-Cookie values into one comma-separated string a naive
    // split mangles the moment a response sets more than one cookie.
    const found = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    if (found) this.cookie = found.split(';')[0]!;
    return res;
  }

  json(path: string, method: string, body: unknown): Promise<Response> {
    return this.call(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}


let stepNumber = 0;
function ok(message: string): void {
  stepNumber += 1;
  console.log(`  ${String(stepNumber).padStart(2, ' ')}. ok   ${message}`);
}

/** Fails the whole run loudly — no step may be silently skipped or softened. */
function fail(message: string): never {
  console.error(`\nFAILED at step ${String(stepNumber + 1)}: ${message}`);
  process.exit(1);
}

async function expectStatus(res: Response, want: number, what: string): Promise<unknown> {
  const text = await res.text();
  if (res.status !== want)
    fail(`${what}: expected HTTP ${String(want)}, got ${String(res.status)} — ${text}`);
  return text.length > 0 ? JSON.parse(text) : null;
}

function expectEqual(actual: unknown, want: unknown, what: string): void {
  if (actual !== want)
    fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}

/**
 * The bootstrap hop documented in docs/runbook.md, "Bootstrapping the first
 * admin". `postgres` deliberately publishes no host port, so this reaches it
 * the only way anything outside the Compose network can: a `podman exec` into
 * the container, found by the compose labels rather than by guessing its name
 * (the same lookup `scripts/compose-up.sh`'s `container_for_service` does).
 */
async function promoteToAdminBySql(username: string): Promise<void> {
  const { stdout: names } = await execFileAsync('podman', [
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${PROJECT}`,
    '--filter',
    'label=com.docker.compose.service=postgres',
    '--format',
    '{{.Names}}',
  ]);
  const container = names.split('\n')[0]?.trim();
  if (!container)
    fail(`no postgres container found for compose project '${PROJECT}' — is the stack up?`);

  const { stdout } = await execFileAsync('podman', [
    'exec',
    container,
    'psql',
    '-U',
    'duckoj',
    '-d',
    'duckoj',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE users SET global_role = 'admin' WHERE lower(username) = lower('${username}')`,
  ]);
  if (!stdout.includes('UPDATE 1')) {
    fail(`bootstrap SQL did not update exactly one row (got: ${stdout.trim()})`);
  }
}

/**
 * A per-run problem package, written to a temp directory rather than checked
 * in. Its test data carries a nonce so every run produces a package hash the
 * stack has never seen — which is the point: a fixture with a fixed hash
 * would be served from whatever the judge already materialised, and this run
 * would prove nothing about a package travelling upload → store → judge.
 *
 * The limits and per-test points are deliberately *unlike* `problems/aplusb`'s
 * (2000ms/128MiB, four tests worth 1+2+3+4) so the denormalised revision
 * metadata asserted below cannot accidentally match a stale seeded row.
 */
async function writeFixture(nonce: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-problem-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  const cases = [
    [nonce, 1],
    [-nonce, nonce],
    [nonce * 2, nonce * 3],
    [0, nonce],
  ];
  const tests = [];
  for (let i = 0; i < cases.length; i += 1) {
    const [a, b] = cases[i] as [number, number];
    const name = String(i + 1).padStart(2, '0');
    await writeFile(join(dir, 'tests', `${name}.in`), `${String(a)} ${String(b)}\n`);
    await writeFile(join(dir, 'tests', `${name}.out`), `${String(a + b)}\n`);
    tests.push({ input: `tests/${name}.in`, answer: `tests/${name}.out`, points: i + 1, group: 0 });
  }
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: 'E2E sum',
        checker: { kind: 'standard' },
        limits: { timeMs: 2000, memoryKb: 131072 },
        tests,
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

/** Polls a submission to a terminal state. */
async function waitForGrading(
  session: Session,
  id: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const detail = (await (await session.call(`/submissions/${String(id)}`)).json()) as Record<
      string,
      unknown
    >;
    if (detail.state === 'done' || detail.state === 'errored') return detail;
    if (Date.now() > deadline) {
      fail(`submission ${String(id)} never finished; last state ${String(detail.state)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** The competitor's own row on the scoreboard, or null if absent. */
async function scoreOf(session: Session, key: string, participant: string): Promise<number | null> {
  const board = (await expectStatus(
    await session.call(`/contests/${key}/scoreboard`),
    200,
    'GET /contests/:key/scoreboard',
  )) as { ranking: { participant: string; score: number }[] };
  return board.ranking.find((row) => row.participant === participant)?.score ?? null;
}

// --------------------------------------------------------------------------

const nonce = Date.now();
const adminName = `e2eadm${String(nonce)}`;
const setterName = `e2eset${String(nonce)}`;
const competitorName = `e2ecmp${String(nonce)}`;
const problemCode = `e2e-cst-${String(nonce)}`;
const contestKey = `e2e-contest-${String(nonce)}`;

console.log(`base=${BASE} project=${PROJECT} problem=${problemCode} contest=${contestKey}\n`);

const admin = new Session();
const setter = new Session();
const competitor = new Session();

async function register(session: Session, username: string): Promise<void> {
  const res = await session.json('/auth/register', 'POST', {
    username,
    email: `${username}@example.com`,
    password: PASSWORD,
    displayName: username,
  });
  if (res.status !== 201 && res.status !== 200) {
    fail(`register ${username}: HTTP ${String(res.status)} — ${await res.text()}`);
  }
}

async function login(session: Session, username: string): Promise<Record<string, unknown>> {
  const res = await session.json('/auth/login', 'POST', {
    usernameOrEmail: username,
    password: PASSWORD,
  });
  if (res.status !== 200 && res.status !== 201) {
    fail(`login ${username}: HTTP ${String(res.status)} — ${await res.text()}`);
  }
  return (await expectStatus(
    await session.call('/auth/me'),
    200,
    `GET /auth/me (${username})`,
  )) as Record<string, unknown>;
}

// 1 — three users, and the two promotions the runbook documents.
await register(admin, adminName);
await register(setter, setterName);
await register(competitor, competitorName);
await promoteToAdminBySql(adminName);
await login(admin, adminName);
await expectStatus(
  await admin.json(`/admin/users/${setterName}`, 'PATCH', { globalRole: 'setter' }),
  200,
  `PATCH /admin/users/${setterName}`,
);
await login(setter, setterName);
await login(competitor, competitorName);
ok(`registered ${adminName} (admin), ${setterName} (setter), ${competitorName}`);

// 2 — a PRIVATE problem, published. It stays private for the whole run: the
// contest is the only thing that will ever make it visible.
await expectStatus(
  await setter.json('/problems', 'POST', {
    code: problemCode,
    name: 'E2E contest sum',
    statement: '# Sum\n\nRead $a$ and $b$, print $a + b$.\n',
    visibility: 'private',
  }),
  201,
  'POST /problems',
);
const fixtureDir = await writeFixture(nonce % 1000);
const built = await buildPackage(fixtureDir);
await expectStatus(
  await setter.call(`/packages?hash=${built.hash}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(built.archive),
  }),
  201,
  'POST /packages',
);
await expectStatus(
  await setter.json(`/problems/${problemCode}/revisions`, 'POST', {
    packageHash: built.hash,
    notes: 'e2e',
  }),
  201,
  'POST /problems/:code/revisions',
);
await expectStatus(
  await setter.json(`/problems/${problemCode}/revisions/1/publish`, 'POST', {}),
  200,
  'POST /problems/:code/revisions/1/publish',
);
ok(`published a private problem ${problemCode} (${String(built.files.length)} package files)`);

// 3 — a public contest, running now, containing that private problem.
const now = Date.now();
const contest = (await expectStatus(
  await setter.json('/contests', 'POST', {
    key: contestKey,
    name: 'E2E contest',
    startTime: new Date(now - 60_000).toISOString(),
    endTime: new Date(now + 3_600_000).toISOString(),
    format: 'icpc',
    visibility: 'public',
    problems: [{ code: problemCode, points: 100 }],
  }),
  201,
  'POST /contests',
)) as Record<string, unknown>;
expectEqual(contest.key, contestKey, 'created contest key');
ok(`POST /contests created ${contestKey} (icpc, public, 1 problem)`);

// 4 — the competitor cannot see the problem yet. This is what makes step 6
// meaningful: without it, "visible after joining" proves nothing.
const beforeJoin = await competitor.call(`/problems/${problemCode}`);
await expectStatus(beforeJoin, 404, 'GET a contest problem before joining');
ok('the contest problem is invisible (404) to a competitor who has not joined');

// 5 — submitting before joining is refused, and leaves nothing behind.
const unjoined = await competitor.json('/submissions', 'POST', {
  problemCode,
  languageKey: 'cpp17',
  source: CORRECT,
  contestKey,
});
const unjoinedBody = (await expectStatus(unjoined, 404, 'POST /submissions before joining')) as {
  code?: string;
};
// 404 and not `contest_not_joined`: the problem itself is still invisible, so
// the request never reaches the participation check. The narrower error would
// mean the problem had leaked.
expectEqual(unjoinedBody.code, 'problem_not_found', 'submitting to an unseen problem');
ok('submitting before joining is refused at the problem, not at the participation');

// 6 — join, and the problem becomes visible through both read paths.
const participation = (await expectStatus(
  await competitor.call(`/contests/${contestKey}/join`, { method: 'POST' }),
  201,
  'POST /contests/:key/join',
)) as Record<string, unknown>;
expectEqual(participation.virtual, 0, 'joining a running contest is a live participation');
const again = (await expectStatus(
  await competitor.call(`/contests/${contestKey}/join`, { method: 'POST' }),
  201,
  'POST /contests/:key/join (again)',
)) as Record<string, unknown>;
expectEqual(again.id, participation.id, 'joining twice must not fork the participation');
await expectStatus(
  await competitor.call(`/problems/${problemCode}`),
  200,
  'GET the contest problem after joining',
);
const listed = (await expectStatus(
  await competitor.call('/problems'),
  200,
  'GET /problems after joining',
)) as { items: { code: string }[] };
expectEqual(
  listed.items.some((p) => p.code === problemCode),
  true,
  'the contest problem should appear in the list too — both visibility forms',
);
ok(`joined ${contestKey} (idempotently), and the private problem is now visible in read and list`);

// 7 — submit into the contest, and let a real judge grade it.
const created = (await expectStatus(
  await competitor.json('/submissions', 'POST', {
    problemCode,
    languageKey: 'cpp17',
    source: CORRECT,
    contestKey,
  }),
  201,
  'POST /submissions with contestKey',
)) as { id: number };
const graded = await waitForGrading(competitor, created.id);
expectEqual(graded.verdict, 'AC', 'the contest submission should grade to AC');
ok(`submission ${String(created.id)} graded ${String(graded.verdict)} ${String(graded.points)}/${String(graded.maxPoints)} by a real judge`);

// 8 — the score reaches the scoreboard. Nothing wrote `contest_submissions
// .points`; the scoreboard rebuilt it from the cases grading produced.
const scored = await scoreOf(competitor, contestKey, competitorName);
expectEqual(scored, 100, 'the scoreboard score after grading');
ok(`the scoreboard scores ${competitorName} ${String(scored)} — derived from submission_cases, not a stored column`);

// 9 — the cost of the explicit-key decision, through the whole stack: the
// same competitor, the same problem, no `contestKey`, and the scoreboard
// does not move.
const practice = (await expectStatus(
  await competitor.json('/submissions', 'POST', {
    problemCode,
    languageKey: 'cpp17',
    source: CORRECT,
  }),
  201,
  'POST /submissions without contestKey',
)) as { id: number };
const practiceGraded = await waitForGrading(competitor, practice.id);
expectEqual(practiceGraded.verdict, 'AC', 'the practice submission should also grade to AC');
const afterPractice = await scoreOf(competitor, contestKey, competitorName);
expectEqual(afterPractice, 100, 'the scoreboard must not move for a submission without contestKey');
ok('an AC submitted without contestKey grades normally and does NOT touch the scoreboard');

console.log(`\nAll ${String(stepNumber)} steps passed.`);
