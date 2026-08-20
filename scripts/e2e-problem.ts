/**
 * End-to-end proof that Phase 2b's problems surface works against the real
 * stack — the whole authoring path, over real HTTP, in one run:
 *
 *   register → promote to admin (bootstrap SQL) → promote a second user to
 *   `setter` (PATCH /admin/users/:username) → create a private problem →
 *   build and upload a package → attach it as a draft revision → publish →
 *   make the problem public → submit and grade to AC → submit uncompilable
 *   source and assert CE.
 *
 * Sibling of `scripts/e2e-submit.ts`, and deliberately shaped like it: this
 * cannot run in ordinary CI (it needs the whole compose stack, a real judge
 * and a real sandbox), so its output is pasted into the acceptance report.
 *
 * Why both promotion paths, in one script: `PATCH /admin/users/:username` is
 * admin-only and therefore cannot mint the *first* admin on a fresh
 * database, so the runbook's bootstrap `UPDATE users SET global_role =
 * 'admin'` is a load-bearing, documented step with no test anywhere that
 * runs it. Exercising the SQL hop and then the HTTP route it unlocks is the
 * only way to prove the documented bootstrap actually bootstraps.
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

const UNCOMPILABLE = `int main(){ this is not c++ }`;

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

/** An anonymous caller — no cookie is ever stored, so it stays anonymous. */
const anon = {
  async call(path: string): Promise<Response> {
    return fetch(`${BASE}/api/v1${path}`, { redirect: 'follow' });
  },
};

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

async function submitAndWait(
  session: Session,
  problemCode: string,
  source: string,
): Promise<Record<string, unknown>> {
  const created = await session.json('/submissions', 'POST', {
    problemCode,
    languageKey: 'cpp17',
    source,
  });
  const body = (await expectStatus(created, 201, `POST /submissions (${problemCode})`)) as {
    id: number;
  };

  const deadline = Date.now() + 180_000;
  for (;;) {
    const detail = (await (await session.call(`/submissions/${String(body.id)}`)).json()) as Record<
      string,
      unknown
    >;
    if (detail.state === 'done' || detail.state === 'errored') return detail;
    if (Date.now() > deadline) {
      fail(`submission ${String(body.id)} never finished; last state ${String(detail.state)}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --------------------------------------------------------------------------

const nonce = Date.now();
const adminName = `e2eadm${String(nonce)}`;
const setterName = `e2eset${String(nonce)}`;
const viewerName = `e2evie${String(nonce)}`;
const problemCode = `e2e-sum-${String(nonce)}`;

console.log(`base=${BASE} project=${PROJECT} problem=${problemCode}\n`);

const admin = new Session();
const setter = new Session();
const viewer = new Session();

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
  const me = await session.call('/auth/me');
  return (await expectStatus(me, 200, `GET /auth/me (${username})`)) as Record<string, unknown>;
}

// 1 — three users register through the public route.
await register(admin, adminName);
await register(setter, setterName);
await register(viewer, viewerName);
ok(`registered ${adminName}, ${setterName}, ${viewerName}`);

// 2 — the runbook's bootstrap SQL, the only path to the first admin.
await promoteToAdminBySql(adminName);
const adminMe = await login(admin, adminName);
expectEqual(adminMe.globalRole, 'admin', 'bootstrap SQL should have made this user an admin');
ok(`bootstrap SQL promoted ${adminName} to admin (globalRole=${String(adminMe.globalRole)})`);

// 3 — the HTTP path the bootstrap unlocks. Second promotion, different route.
const granted = (await expectStatus(
  await admin.json(`/admin/users/${setterName}`, 'PATCH', { globalRole: 'setter' }),
  200,
  `PATCH /admin/users/${setterName}`,
)) as Record<string, unknown>;
expectEqual(granted.globalRole, 'setter', 'PATCH /admin/users response globalRole');
const setterMe = await login(setter, setterName);
expectEqual(setterMe.globalRole, 'setter', 'GET /auth/me after the grant');
ok(`PATCH /admin/users/${setterName} promoted them to setter`);

// 4 — an unprivileged user may not create problems. Proves the role grant
// above is what unlocks step 5, not that everyone can author.
const viewerMe = await login(viewer, viewerName);
expectEqual(viewerMe.globalRole, 'user', 'the viewer should still be a plain user');
const refused = await viewer.json('/problems', 'POST', {
  code: `${problemCode}-nope`,
  name: 'nope',
  statement: 'x',
});
const refusedBody = (await expectStatus(refused, 403, 'POST /problems as a plain user')) as {
  code?: string;
};
expectEqual(refusedBody.code, 'problem_forbidden', 'POST /problems as a plain user: error code');
ok('a plain user is refused problem creation (403 problem_forbidden)');

// 5 — create the problem, private.
const created = (await expectStatus(
  await setter.json('/problems', 'POST', {
    code: problemCode,
    name: 'E2E sum',
    statement: '# E2E sum\n\nRead $a$ and $b$, print $a + b$.\n',
    visibility: 'private',
  }),
  201,
  'POST /problems',
)) as Record<string, unknown>;
expectEqual(created.code, problemCode, 'created problem code');
expectEqual(created.visibility, 'private', 'created problem visibility');
expectEqual(created.hasPublishedRevision, false, 'a brand-new problem has no published revision');
expectEqual(
  (created.members as { username: string; role: string }[]).some(
    (m) => m.username === setterName && m.role === 'author',
  ),
  true,
  'the creator should be recorded as an author member',
);
ok(`POST /problems created ${problemCode} (private, author=${setterName})`);

// 6 — 404, not 403, for someone who may not see it (spec §3.2).
const hidden = await viewer.call(`/problems/${problemCode}`);
const hiddenBody = (await expectStatus(hidden, 404, 'GET a private problem as a non-member')) as {
  code?: string;
};
expectEqual(hiddenBody.code, 'problem_not_found', 'a private problem 404s rather than 403s');
ok('a private problem is invisible (404 problem_not_found) to a non-member');

// 7 — build a package and upload it through the real HTTP endpoint.
const fixtureDir = await writeFixture(nonce % 1000);
const built = await buildPackage(fixtureDir);
const uploaded = (await expectStatus(
  await setter.call(`/packages?hash=${built.hash}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(built.archive),
  }),
  201,
  'POST /packages',
)) as { hash?: string };
expectEqual(uploaded.hash, built.hash, 'the hash the API re-derived from the archive');
ok(
  `POST /packages stored ${built.hash} (${String(built.files.length)} files, ${String(built.archive.length)} bytes)`,
);

// 8 — attach it as a draft revision, and assert the denormalised limits.
const attached = (await expectStatus(
  await setter.json(`/problems/${problemCode}/revisions`, 'POST', {
    packageHash: built.hash,
    notes: 'e2e',
  }),
  201,
  'POST /problems/:code/revisions',
)) as { version?: number };
expectEqual(attached.version, 1, 'the first revision should be version 1');

const revisions = (await expectStatus(
  await setter.call(`/problems/${problemCode}/revisions`),
  200,
  'GET /problems/:code/revisions',
)) as Record<string, unknown>[];
expectEqual(revisions.length, 1, 'revision count');
const rev = revisions[0]!;
expectEqual(rev.state, 'draft', 'a freshly attached revision is a draft');
expectEqual(rev.packageHash, built.hash, 'revision packageHash');
expectEqual(rev.timeMs, 2000, 'denormalised timeMs');
expectEqual(rev.memoryKb, 131072, 'denormalised memoryKb');
expectEqual(rev.testCount, 4, 'denormalised testCount');
expectEqual(rev.totalPoints, 10, 'denormalised totalPoints');
expectEqual(rev.checkerKind, 'standard', 'denormalised checkerKind');
ok(
  `revision 1 attached: ${String(rev.timeMs)}ms / ${String(rev.memoryKb)}KiB / ${String(rev.testCount)} tests / ${String(rev.totalPoints)} points / ${String(rev.checkerKind)}`,
);

// 9 — a draft revision is not gradeable, not even for its own author.
const early = await setter.json('/submissions', 'POST', {
  problemCode,
  languageKey: 'cpp17',
  source: CORRECT,
});
if (early.status === 201)
  fail('submitting against a problem whose only revision is a draft was accepted');
const earlyBody = (await early.json()) as { code?: string };
ok(
  `submitting against an unpublished revision is refused (${String(early.status)} ${String(earlyBody.code)})`,
);

// 10 — publish.
const published = (await expectStatus(
  await setter.json(`/problems/${problemCode}/revisions/1/publish`, 'POST', {}),
  200,
  'POST /problems/:code/revisions/1/publish',
)) as { version?: number };
expectEqual(published.version, 1, 'published version');
const afterPublish = (await expectStatus(
  await setter.call(`/problems/${problemCode}/revisions`),
  200,
  'GET revisions after publish',
)) as Record<string, unknown>[];
expectEqual(afterPublish[0]!.state, 'published', 'revision state after publish');
ok('revision 1 published');

// 11 — make it public.
const madePublic = (await expectStatus(
  await setter.json(`/problems/${problemCode}`, 'PATCH', { visibility: 'public' }),
  200,
  'PATCH /problems/:code',
)) as Record<string, unknown>;
expectEqual(madePublic.visibility, 'public', 'visibility after PATCH');
expectEqual(madePublic.hasPublishedRevision, true, 'hasPublishedRevision after publish');
expectEqual(madePublic.testCount, 4, 'detail testCount after publish');
expectEqual(madePublic.totalPoints, 10, 'detail totalPoints after publish');
ok('PATCH /problems/:code made it public');

// 12 — anonymous callers can now see it, both in the list and by code.
const anonDetail = (await expectStatus(
  await anon.call(`/problems/${problemCode}`),
  200,
  'anonymous GET /problems/:code',
)) as Record<string, unknown>;
expectEqual(anonDetail.code, problemCode, 'anonymous detail code');
const anonList = (await expectStatus(
  await anon.call(`/problems?q=${problemCode}`),
  200,
  'anonymous GET /problems?q=',
)) as { items: { code: string }[] };
expectEqual(
  anonList.items.some((p) => p.code === problemCode),
  true,
  'the published public problem should appear in the anonymous list',
);
ok('anonymous callers see the published public problem in both list and detail');

// 13 — grade a correct solution, as the unprivileged viewer.
const accepted = await submitAndWait(viewer, problemCode, CORRECT);
console.log(
  `      correct → ${String(accepted.verdict)} ${String(accepted.points)}/${String(accepted.maxPoints)}`,
);
expectEqual(accepted.verdict, 'AC', 'verdict for a correct solution');
expectEqual(accepted.points, 10, 'points for a correct solution');
expectEqual(accepted.maxPoints, 10, 'maxPoints for a correct solution');
ok('a correct submission graded AC 10/10 against a package uploaded over HTTP this run');

// 14 — the headline check. `EventWriter` wrote `IE` for every compile error
// until Task 9 added `CE` to `case_verdict` and changed the mapping; a fake
// driver in a unit suite cannot tell the two apart from a real judge's
// packet, and the old behaviour was documented in the runbook as expected.
// This asserts CE against the real judge, not a fake.
const broken = await submitAndWait(viewer, problemCode, UNCOMPILABLE);
console.log(
  `      broken  → ${String(broken.verdict)} | compileOutput: ${String(broken.compileOutput ?? '')
    .slice(0, 60)
    .replace(/\n/g, ' ')}`,
);
expectEqual(broken.verdict, 'CE', 'verdict for uncompilable source (must be CE, not IE)');
if (!broken.compileOutput) fail('expected a non-empty compileOutput for uncompilable source');
ok('uncompilable source came back CE from a real judge');

console.log('\nevery step of the problems path behaved as expected');
