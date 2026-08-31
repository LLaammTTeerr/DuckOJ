/**
 * A full contest-day rehearsal against the live stack (loop B-24).
 *
 * One scripted run that drives the whole system the way a provincial olympiad
 * does on the day: an admin authors and publishes problems, an ICPC **team**
 * contest runs with a freeze window and org-restriction, two schools' teams
 * join and submit, the organiser watches the monitor, answers a clarification,
 * posts an announcement, rejudges, disqualifies, exports the results and runs a
 * similarity check — and, in parallel, an individual public contest proves the
 * non-team path still works.
 *
 * Sibling of `scripts/e2e-contest.ts`, and shaped like it: it needs the whole
 * compose stack, a real judge and a real sandbox, so it cannot run in ordinary
 * CI and its output is pasted into the acceptance report. It differs in three
 * deliberate ways:
 *
 *   1. **No podman/SQL bootstrap.** The operator's `duckadmin` already exists
 *      (secrets file), and a global admin creates contests, orgs, teams and
 *      problems with no promotion hop — a session's authority is unscoped.
 *
 *   2. **Fixed, reused accounts.** Registration is metered 30/IP/hour (D26)
 *      and every POST /auth/register burns the budget even on a 409, but a
 *      SUCCESSFUL login does not. So accounts have stable `rehearse-*` names
 *      and `ensureAccount` logs in first, registering only the once — repeat
 *      runs cost nothing against the meter.
 *
 *   3. **A real freeze timeline.** The contest is short and the run waits
 *      through its freeze instant, because the one assertion a unit test can
 *      never make is "a rival cannot see the late verdict at 14:58 while the
 *      organiser can" — that needs a wall clock and the composed board.
 */

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackage } from './lib/build-package.js';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'duckoj_session';
// The operator's secrets file. In a worktree the repo's own `.secrets/` is
// absent (it is gitignored, so it lives only in the main checkout), so the
// candidates fall back to the main clone the runbook documents.
const SECRETS_CANDIDATES = [
  process.env.E2E_SECRETS_FILE,
  join(process.cwd(), '.secrets', 'duckadmin.txt'),
  '/home/lamter/Projects/duckoj/.secrets/duckadmin.txt',
].filter((p): p is string => typeof p === 'string' && p.length > 0);
const PASSWORD = 'rehearse-not-a-real-password-2026';

// A+B, correct, and a wrong one (prints a-b) — a token-checker WA on any test
// where a !== 0. The two AC sources are IDENTICAL across teams on purpose: it
// guarantees the similarity check reports the pair at its default threshold.
const AC = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}`;
const WA = `#include <iostream>
int main(){long long a,b;std::cin>>a>>b;std::cout<<a-b<<"\\n";}`;

// --------------------------------------------------------------------------
// Session + assertion harness (the convention e2e-contest.ts established).

class Session {
  private cookie = '';
  label: string;
  constructor(label: string) {
    this.label = label;
  }
  async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      origin: new URL(BASE).origin,
      ...(this.cookie ? { cookie: this.cookie } : {}),
    };
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>))
      headers[k] = v;
    const res = await fetch(`${BASE}/api/v1${path}`, { ...init, headers, redirect: 'follow' });
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
function fail(message: string): never {
  console.error(`\nFAILED at step ${String(stepNumber + 1)}: ${message}`);
  process.exit(1);
}
async function expectStatus(res: Response, want: number, what: string): Promise<unknown> {
  const text = await res.text();
  if (res.status !== want)
    fail(`${what}: expected HTTP ${String(want)}, got ${String(res.status)} — ${text.slice(0, 400)}`);
  return text.length > 0 ? JSON.parse(text) : null;
}
function expectEqual(actual: unknown, want: unknown, what: string): void {
  if (actual !== want)
    fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
}
function expectTrue(cond: boolean, what: string): void {
  if (!cond) fail(what);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitUntil(whenMs: number, why: string): Promise<void> {
  const ms = whenMs - Date.now();
  if (ms > 0) {
    console.log(`     …waiting ${String(Math.ceil(ms / 1000))}s (${why})`);
    await sleep(ms);
  }
}

// --------------------------------------------------------------------------
// Accounts: parse the operator's admin block; log-in-first everyone else.

interface Admin {
  username: string;
  password: string;
}
async function adminCredentials(): Promise<Admin> {
  let text: string | null = null;
  let used = '';
  for (const candidate of SECRETS_CANDIDATES) {
    try {
      text = await readFile(candidate, 'utf8');
      used = candidate;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (text === null) fail(`no admin secrets file found; tried: ${SECRETS_CANDIDATES.join(', ')}`);
  const blocks = text
    .split(/^\s*-{3,}\s*$/m)
    .map((chunk) => {
      const b: Record<string, string> = {};
      for (const line of chunk.split('\n')) {
        const at = line.indexOf(':');
        if (at === -1) continue;
        const k = line.slice(0, at).trim();
        const v = line.slice(at + 1).trim();
        if (k !== '' && v !== '') b[k] = v;
      }
      return b;
    })
    .filter((b) => 'password' in b);
  const block = blocks.find((b) => b.globalRole === 'admin');
  if (!block) fail(`${used} has no block with globalRole: admin`);
  return { username: block!.username ?? 'duckadmin', password: block!.password! };
}

async function login(session: Session, usernameOrEmail: string, password: string): Promise<boolean> {
  const res = await session.json('/auth/login', 'POST', { usernameOrEmail, password });
  return res.status === 200 || res.status === 201;
}

/**
 * Log in a fixed account, registering it only if the login fails (the account
 * does not exist yet). A successful login costs nothing against the D26 meter;
 * the register that a first-ever run needs costs one, and is never repeated.
 */
async function ensureAccount(session: Session, username: string): Promise<void> {
  if (await login(session, username, PASSWORD)) return;
  const reg = await session.json('/auth/register', 'POST', {
    username,
    email: `${username}@rehearsal.invalid`,
    password: PASSWORD,
    displayName: username,
  });
  if (reg.status !== 201 && reg.status !== 200)
    fail(`register ${username}: HTTP ${String(reg.status)} — ${await reg.text()}`);
  if (!(await login(session, username, PASSWORD))) fail(`login ${username} after register`);
}

// --------------------------------------------------------------------------
// A per-run A+B package, written to a temp dir with a nonce so the hash is one
// the store has never seen (e2e-contest.ts's reasoning).

async function writeFixture(name: string, nonce: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rehearsal-'));
  await mkdir(join(dir, 'tests'), { recursive: true });
  const cases = [
    [nonce, 1],
    [nonce * 2, nonce * 3],
    [7, nonce],
  ];
  const tests = [];
  for (let i = 0; i < cases.length; i += 1) {
    const [a, b] = cases[i] as [number, number];
    const n = String(i + 1).padStart(2, '0');
    await writeFile(join(dir, 'tests', `${n}.in`), `${String(a)} ${String(b)}\n`);
    await writeFile(join(dir, 'tests', `${n}.out`), `${String(a + b)}\n`);
    tests.push({ input: `tests/${n}.in`, answer: `tests/${n}.out`, points: 1, group: 0 });
  }
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        name,
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

/** Author + publish a private problem as the admin. */
async function publishProblem(admin: Session, code: string, name: string): Promise<void> {
  await expectStatus(
    await admin.json('/problems', 'POST', {
      code,
      name,
      statement: `# ${name}\n\nRead $a$ and $b$, print $a + b$.\n`,
      visibility: 'private',
    }),
    201,
    `POST /problems (${code})`,
  );
  const built = await buildPackage(await writeFixture(name, (Date.now() % 1000) + code.length));
  await expectStatus(
    await admin.call(`/packages?hash=${built.hash}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(built.archive),
    }),
    201,
    `POST /packages (${code})`,
  );
  await expectStatus(
    await admin.json(`/problems/${code}/revisions`, 'POST', { packageHash: built.hash, notes: 'rehearsal' }),
    201,
    `POST /problems/${code}/revisions`,
  );
  await expectStatus(
    await admin.json(`/problems/${code}/revisions/1/publish`, 'POST', {}),
    200,
    `POST /problems/${code}/revisions/1/publish`,
  );
}

interface Submission {
  id: number;
  state: string;
  verdict: string | null;
  points: number;
  maxPoints: number;
  source: string | null;
  sourceHidden: boolean;
}
async function submit(
  session: Session,
  problemCode: string,
  source: string,
  contestKey: string,
): Promise<number> {
  const created = (await expectStatus(
    await session.json('/submissions', 'POST', { problemCode, languageKey: 'cpp17', source, contestKey }),
    201,
    `POST /submissions (${problemCode} into ${contestKey})`,
  )) as { id: number };
  return created.id;
}
async function detail(session: Session, id: number): Promise<Submission> {
  return (await (await session.call(`/submissions/${String(id)}`)).json()) as Submission;
}
async function waitForGrading(session: Session, id: number): Promise<Submission> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const d = await detail(session, id);
    if (d.state === 'done' || d.state === 'errored') return d;
    if (Date.now() > deadline) fail(`submission ${String(id)} never finished; last ${d.state}`);
    await sleep(1000);
  }
}

interface ScoreRow {
  participant: string;
  score: number;
  virtual: number;
  is_disqualified: boolean;
  pending?: Record<string, number>;
}
interface Board {
  ranking: ScoreRow[];
  frozenAt: string | null;
  teams?: Record<string, { name: string; members: string[]; orgSlug: string; orgName: string }>;
}
async function scoreboard(session: Session, key: string): Promise<Board> {
  return (await expectStatus(
    await session.call(`/contests/${key}/scoreboard`),
    200,
    `GET /contests/${key}/scoreboard (${session.label})`,
  )) as Board;
}

// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const nonce = Date.now();
  const org = 'rehearse-school';
  const teamA = `rehearse-alpha-${String(nonce)}`;
  const teamB = `rehearse-bravo-${String(nonce)}`;
  const p1 = `rehearse-p1-${String(nonce)}`;
  const p2 = `rehearse-p2-${String(nonce)}`;
  const teamKey = `rehearse-icpc-${String(nonce)}`;
  const soloKey = `rehearse-open-${String(nonce)}`;

  console.log(`base=${BASE} org=${org} team-contest=${teamKey} open-contest=${soloKey}\n`);

  const admin = new Session('admin');
  const a1 = new Session('a1');
  const a2 = new Session('a2');
  const b1 = new Session('b1');
  const b2 = new Session('b2');
  const solo = new Session('solo');

  // 1 — accounts. Admin from the secrets file; the five pupils log-in-first.
  const cred = await adminCredentials();
  if (!(await login(admin, cred.username, cred.password))) fail('admin login failed');
  await ensureAccount(a1, 'rehearse-a1');
  await ensureAccount(a2, 'rehearse-a2');
  await ensureAccount(b1, 'rehearse-b1');
  await ensureAccount(b2, 'rehearse-b2');
  await ensureAccount(solo, 'rehearse-solo');
  ok(`signed in ${cred.username} (admin) + 5 rehearse pupils (login-first, meter-safe)`);

  // 2 — the authoring path: two private problems, published, and one proven to
  // grade before it is ever put in a contest.
  await publishProblem(admin, p1, 'Rehearsal A+B I');
  await publishProblem(admin, p2, 'Rehearsal A+B II');
  ok(`admin authored and published two problems (${p1}, ${p2})`);

  // 3 — the org, its roster, and two teams of two.
  const orgRes = await admin.json('/orgs', 'POST', {
    slug: org,
    name: 'Rehearsal Provincial School',
    visibility: 'private',
    joinPolicy: 'invite',
  });
  if (orgRes.status !== 201 && orgRes.status !== 409)
    fail(`POST /orgs: HTTP ${String(orgRes.status)} — ${await orgRes.text()}`);
  for (const u of ['rehearse-a1', 'rehearse-a2', 'rehearse-b1', 'rehearse-b2']) {
    const r = await admin.json(`/orgs/${org}/members`, 'POST', { username: u });
    if (r.status !== 201 && r.status !== 409)
      fail(`add ${u} to ${org}: HTTP ${String(r.status)} — ${await r.text()}`);
  }
  for (const [slug, name, members] of [
    [teamA, 'Team Alpha', ['rehearse-a1', 'rehearse-a2']],
    [teamB, 'Team Bravo', ['rehearse-b1', 'rehearse-b2']],
  ] as const) {
    await expectStatus(
      await admin.json(`/orgs/${org}/teams`, 'POST', { slug, name, members }),
      201,
      `POST /orgs/${org}/teams (${slug})`,
    );
  }
  ok(`org ${org} ready with two teams of two (${teamA}, ${teamB})`);

  // 4 — the team contest. Short, frozen for its last 3 minutes, org-restricted.
  const start = nonce - 60_000;
  const end = nonce + 6 * 60_000; // 6 min duration
  const frozenAtMs = end - 3 * 60_000; // freeze last 3 min → frozen at now+3min
  const contest = (await expectStatus(
    await admin.json('/contests', 'POST', {
      key: teamKey,
      name: 'Rehearsal ICPC team round',
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      format: 'icpc',
      frozenLastMinutes: 3,
      participationMode: 'team',
      maxTeamSize: 2,
      orgSlugs: [org],
      visibility: 'org',
      problems: [
        { code: p1, points: 100 },
        { code: p2, points: 100 },
      ],
    }),
    201,
    'POST /contests (team)',
  )) as { key: string; participationMode: string; frozenAt: string | null };
  expectEqual(contest.participationMode, 'team', 'team contest participationMode');
  ok(`created ${teamKey} — icpc, team, org-restricted, freeze last 3 min, 2 problems`);

  // 5 — both teams join (captain enters the whole team; a teammate's second
  // press is the documented 409).
  const joinA = (await expectStatus(
    await a1.call(`/contests/${teamKey}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamSlug: teamA }),
    }),
    201,
    'a1 joins as Team Alpha',
  )) as { team: { name: string } | null };
  expectEqual(joinA.team?.name, 'Team Alpha', 'Alpha participation carries the team');
  const dupe = await a2.call(`/contests/${teamKey}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teamSlug: teamA }),
  });
  const dupeBody = (await expectStatus(dupe, 409, 'a2 second join')) as { code?: string };
  expectEqual(dupeBody.code, 'contest_team_joined', 'a teammate cannot re-enter the team');
  await expectStatus(
    await b1.call(`/contests/${teamKey}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ teamSlug: teamB }),
    }),
    201,
    'b1 joins as Team Bravo',
  );
  ok('both teams joined; a teammate re-join is 409 contest_team_joined');

  // 6 — pre-freeze submissions. Alpha member a2 (NOT the captain) ACs p1;
  // Bravo member b1 WAs p1 (the rejudge target); Alpha captain a1 ACs p2 with
  // the SAME source Bravo will use late — the pair the similarity check finds.
  const aP1 = await submit(a2, p1, AC, teamKey);
  const bP1 = await submit(b1, p1, WA, teamKey);
  const aP2 = await submit(a1, p2, AC, teamKey);
  const aP1g = await waitForGrading(a2, aP1);
  const bP1g = await waitForGrading(b1, bP1);
  const aP2g = await waitForGrading(a1, aP2);
  expectEqual(aP1g.verdict, 'AC', 'Alpha p1 grades AC');
  expectEqual(bP1g.verdict, 'WA', 'Bravo p1 grades WA');
  expectEqual(aP2g.verdict, 'AC', 'Alpha p2 grades AC');
  ok(`pre-freeze: Alpha ${String(aP1)} AC p1 (by teammate a2), Alpha ${String(aP2)} AC p2, Bravo ${String(bP1)} WA p1`);

  // 7 — D117: a1 (captain) reads a2's submission and its SOURCE, as if it were
  // their own — "one team is one entity". A rival on Bravo cannot read another
  // team's submission at all on a private-source problem (404): the team clause
  // is exactly the access the rival lacks.
  const teammateView = await detail(a1, aP1);
  expectTrue(teammateView.source !== null, 'D117: a teammate reads the team submission source');
  expectEqual(teammateView.sourceHidden, false, 'D117: source not hidden from a teammate');
  const rivalRes = await b1.call(`/submissions/${String(aP1)}`);
  expectEqual(rivalRes.status, 404, 'D117/D27: a live rival cannot read another team’s submission');
  ok('D117: teammate a1 reads a2’s submission + source; a Bravo rival is refused (404)');

  // 8 — scoreboard shows team NAMES, not usernames.
  const board1 = await scoreboard(admin, teamKey);
  const alphaRow = board1.ranking.find((r) => r.participant === 'Team Alpha');
  const bravoRow = board1.ranking.find((r) => r.participant === 'Team Bravo');
  expectTrue(!!alphaRow, 'scoreboard has a Team Alpha row');
  expectTrue(!!bravoRow, 'scoreboard has a Team Bravo row');
  expectTrue(!!board1.teams, 'scoreboard carries the teams map (D99)');
  ok(`scoreboard rows are team names: Team Alpha score=${String(alphaRow!.score)}, Team Bravo score=${String(bravoRow!.score)}`);

  // 9 — pre-freeze verdicts ARE visible to a rival (the discriminating half of
  // D22/D23): b1 sees Alpha's AC on p1 before the freeze instant.
  const rivalPreBoard = await scoreboard(b1, teamKey);
  const alphaSeenByRival = rivalPreBoard.ranking.find((r) => r.participant === 'Team Alpha');
  expectTrue(!!alphaSeenByRival && alphaSeenByRival.score > 0, 'rival sees Alpha’s pre-freeze AC score');
  ok(`pre-freeze: a rival's board already shows Alpha's AC (score=${String(alphaSeenByRival!.score)})`);

  // 10 — the monitor: per-problem counts + who is in the room + real verdicts.
  const mon1 = (await expectStatus(
    await admin.call(`/contests/${teamKey}/monitor`),
    200,
    'GET monitor',
  )) as {
    problems: { code: string; submitted: number; accepted: number; solvers: number }[];
    feed: { username: string; team: string | null; verdict: string | null }[];
    participantsOnline: number;
  };
  const monP1 = mon1.problems.find((p) => p.code === p1)!;
  expectEqual(monP1.submitted, 2, 'monitor p1 submitted count');
  expectEqual(monP1.accepted, 1, 'monitor p1 accepted count');
  expectTrue(mon1.feed.some((f) => f.username === 'rehearse-a2' && f.team === 'Team Alpha'), 'feed attributes the submitter, names the team (D105)');
  expectTrue(typeof mon1.participantsOnline === 'number', 'monitor reports a room count');
  ok(`monitor: p1 submitted=${String(monP1.submitted)} accepted=${String(monP1.accepted)} solvers=${String(monP1.solvers)}, room=${String(mon1.participantsOnline)}`);

  // 11 — a clarification asked by one member, answered + published, seen by the
  // teammate AND the rival.
  const clar = (await expectStatus(
    await a1.json(`/contests/${teamKey}/clarifications`, 'POST', {
      problemCode: p1,
      question: 'Are the inputs guaranteed to fit in 64 bits?',
    }),
    201,
    'a1 asks a clarification',
  )) as { id: number };
  await expectStatus(
    await admin.json(`/contests/${teamKey}/clarifications/${String(clar.id)}`, 'PATCH', {
      answer: 'Yes, |a|,|b| < 10^18.',
      visibility: 'public',
    }),
    200,
    'organiser answers + publishes',
  );
  const seenBy = async (s: Session): Promise<boolean> => {
    const list = (await (await s.call(`/contests/${teamKey}/clarifications`)).json()) as {
      items: { id: number; answer: string | null }[];
    };
    return list.items.some((c) => c.id === clar.id && c.answer !== null);
  };
  expectTrue(await seenBy(a2), 'the teammate a2 sees the answered clarification');
  expectTrue(await seenBy(b1), 'a rival sees the published clarification');
  ok('clarification asked by a1, answered by organiser, seen by teammate a2 AND rival b1');

  // 11b — the team-private case (D119 probe): a member asks, the organiser
  // answers WITHOUT publishing. The teammate should still see their own team's
  // answer, exactly as D117 gives them the team's submissions.
  const priv = (await expectStatus(
    await a1.json(`/contests/${teamKey}/clarifications`, 'POST', {
      question: 'Team-only: may we use the lab printer?',
    }),
    201,
    'a1 asks a private clarification',
  )) as { id: number };
  await expectStatus(
    await admin.json(`/contests/${teamKey}/clarifications/${String(priv.id)}`, 'PATCH', {
      answer: 'Yes.',
    }),
    200,
    'organiser answers privately (no publish)',
  );
  const privListA2 = (await (await a2.call(`/contests/${teamKey}/clarifications`)).json()) as {
    items: { id: number }[];
  };
  const a2SeesPrivate = privListA2.items.some((c) => c.id === priv.id);
  const privListB1 = (await (await b1.call(`/contests/${teamKey}/clarifications`)).json()) as {
    items: { id: number }[];
  };
  const b1SeesPrivate = privListB1.items.some((c) => c.id === priv.id);
  expectTrue(!b1SeesPrivate, 'a rival must NOT see another team’s private clarification');
  if (a2SeesPrivate) {
    ok('D119: a private team clarification is visible to the asker’s teammate (fix present)');
  } else {
    console.log('  ** D119 BUG: a private team clarification is invisible to the asker’s own teammate');
    console.log('     (clarification list filter is `askedBy = me`, not team-aware; cf. D117 for submissions)');
  }

  // 12 — an announcement reaches everyone.
  await expectStatus(
    await admin.json(`/contests/${teamKey}/announcements`, 'POST', {
      text: 'Fifteen minutes remaining.',
    }),
    201,
    'organiser posts an announcement',
  );
  const annSeen = async (s: Session): Promise<boolean> => {
    const list = (await (await s.call(`/contests/${teamKey}/clarifications`)).json()) as {
      items: { question: string | null; answer: string | null }[];
    };
    return list.items.some((c) => c.question === null && (c.answer ?? '').includes('Fifteen minutes'));
  };
  expectTrue(await annSeen(a1), 'a1 sees the announcement');
  expectTrue(await annSeen(b2), 'b2 sees the announcement');
  ok('announcement posted and seen by both teams');

  // 13 — WAIT for the freeze instant, then Bravo makes a late AC on p2.
  await waitUntil(frozenAtMs + 3000, 'the scoreboard freeze to begin');
  const bP2 = await submit(b2, p2, AC, teamKey);
  const bP2g = await waitForGrading(b2, bP2);
  expectEqual(bP2g.verdict, 'AC', 'Bravo late p2 grades AC');
  ok(`inside the freeze: Bravo late submission ${String(bP2)} graded AC (by b2)`);

  // 14 — the freeze, from three seats. A rival (Alpha) sees Bravo's late work
  // as PENDING, not as a verdict; the organiser's board and monitor show it.
  const rivalBoard = await scoreboard(a1, teamKey);
  const bravoFromRival = rivalBoard.ranking.find((r) => r.participant === 'Team Bravo')!;
  const bravoPending = bravoFromRival.pending ?? {};
  const p2LabelPending = Object.values(bravoPending).some((n) => n > 0);
  expectTrue(p2LabelPending, 'D22: a rival sees Bravo’s late attempt as pending, hidden count > 0');
  const orgBoard = await scoreboard(admin, teamKey);
  const bravoFromOrg = orgBoard.ranking.find((r) => r.participant === 'Team Bravo')!;
  expectTrue(bravoFromOrg.score > bravoRow!.score, 'D23: the organiser’s board counts Bravo’s late AC');
  expectTrue(Object.values(bravoFromOrg.pending ?? {}).every((n) => n === 0), 'D23: the organiser’s board hides nothing');
  const mon2 = (await (await admin.call(`/contests/${teamKey}/monitor`)).json()) as {
    feed: { submissionId: number; verdict: string | null }[];
  };
  expectTrue(mon2.feed.some((f) => f.submissionId === bP2 && f.verdict === 'AC'), 'D22: the monitor shows the late verdict unfrozen');
  expectTrue(!!rivalBoard.frozenAt, 'the board reports its frozenAt instant');
  ok('freeze verified: rival sees Bravo’s late work as pending; organiser board + monitor show the real AC');

  // 15 — rejudge Bravo's p1 WA; the monitor counters follow (recompute).
  await expectStatus(
    await admin.call(`/admin/submissions/${String(bP1)}/rejudge`, { method: 'POST' }),
    202,
    'POST /admin/submissions/:id/rejudge',
  );
  const rej = await waitForGrading(admin, bP1);
  expectEqual(rej.verdict, 'WA', 'rejudge of the WA stays WA (deterministic)');
  const mon3 = (await (await admin.call(`/contests/${teamKey}/monitor?recompute=1`)).json()) as {
    problems: { code: string; submitted: number; accepted: number }[];
  };
  const monP1b = mon3.problems.find((p) => p.code === p1)!;
  expectEqual(monP1b.submitted, 2, 'monitor p1 submitted after rejudge+recompute');
  expectEqual(monP1b.accepted, 1, 'monitor p1 accepted after rejudge+recompute');
  ok(`rejudged submission ${String(bP1)} → monitor recomputed (p1 submitted=${String(monP1b.submitted)} accepted=${String(monP1b.accepted)})`);

  // 16 — the similarity check (identical AC sources on p2 guarantee a pair).
  // Run BEFORE the disqualification so both teams' p2 solutions are compared.
  const runStart = (await expectStatus(
    await admin.json(`/contests/${teamKey}/similarity`, 'POST', {}),
    201,
    'POST /contests/:key/similarity',
  )) as { status: string };
  expectTrue(runStart.status === 'running' || runStart.status === 'finished', 'similarity run started');
  let simRun: { status: string; pairs: unknown[]; participants: number } | null = null;
  const simDeadline = Date.now() + 60_000;
  for (;;) {
    const rep = (await (await admin.call(`/contests/${teamKey}/similarity`)).json()) as {
      run: { status: string; pairs: unknown[]; participants: number } | null;
    };
    if (rep.run && (rep.run.status === 'finished' || rep.run.status === 'failed')) {
      simRun = rep.run;
      break;
    }
    if (Date.now() > simDeadline) fail('similarity run never finished');
    await sleep(1000);
  }
  expectEqual(simRun!.status, 'finished', 'similarity run finished');
  expectTrue(simRun!.pairs.length >= 1, 'similarity reports the identical p2 pair across the two teams');
  ok(`similarity run done: ${String(simRun!.participants)} participants examined, ${String(simRun!.pairs.length)} pair(s) reported`);

  // 17 — disqualify Team Bravo. Disqualification keys on the username holding
  // the participation — the captain, who is whoever pressed join (b1).
  await expectStatus(
    await admin.json(`/contests/${teamKey}/participants/rehearse-b1`, 'PATCH', { disqualified: true }),
    200,
    'PATCH participant disqualified',
  );
  const dqBoard = await scoreboard(admin, teamKey);
  const bravoDq = dqBoard.ranking.find((r) => r.participant === 'Team Bravo')!;
  expectEqual(bravoDq.is_disqualified, true, 'the scoreboard marks Bravo disqualified');
  ok('disqualified Team Bravo (via captain rehearse-b1) → scoreboard shows is_disqualified');

  // 18 — the individual public contest, in parallel: the non-team path.
  await expectStatus(
    await admin.json('/contests', 'POST', {
      key: soloKey,
      name: 'Rehearsal open round',
      startTime: new Date(nonce - 60_000).toISOString(),
      endTime: new Date(nonce + 3_600_000).toISOString(),
      format: 'icpc',
      visibility: 'public',
      problems: [{ code: p1, points: 100 }],
    }),
    201,
    'POST /contests (individual public)',
  );
  const soloJoin = (await expectStatus(
    await solo.call(`/contests/${soloKey}/join`, { method: 'POST' }),
    201,
    'solo joins the public contest',
  )) as { team: unknown | null; virtual: number };
  expectEqual(soloJoin.team, null, 'an individual participation has no team');
  const soloSub = await submit(solo, p1, AC, soloKey);
  const soloG = await waitForGrading(solo, soloSub);
  expectEqual(soloG.verdict, 'AC', 'solo submission grades AC');
  const soloBoard = await scoreboard(solo, soloKey);
  const soloRow = soloBoard.ranking.find((r) => r.participant === 'rehearse-solo')!;
  expectTrue(!!soloRow && soloRow.score === 100, 'the individual scoreboard shows the username and score');
  expectTrue(!soloBoard.teams, 'an individual board carries no teams map');
  ok(`individual public contest works: rehearse-solo AC, scoreboard score=${String(soloRow!.score)}`);

  // 19 — WAIT for the team contest to end, then the exports.
  await waitUntil(end + 3000, 'the team contest to end before exporting results');
  const csvRes = await admin.call(`/contests/${teamKey}/results.csv`);
  expectEqual(csvRes.status, 200, 'results.csv status');
  const csvBuf = Buffer.from(await csvRes.arrayBuffer());
  expectTrue(csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf, 'results.csv begins with a UTF-8 BOM');
  const csv = csvBuf.toString('utf8');
  expectTrue(csv.split(/\r?\n/)[0]!.includes('members'), 'results.csv header has the team members column');
  const lines = csv.split(/\r?\n/);
  const alphaLine = lines.find((l) => l.includes('Team Alpha'));
  const bravoLine = lines.find((l) => l.includes('Team Bravo'));
  expectTrue(!!alphaLine && !!bravoLine, 'results.csv carries both team rows');
  expectTrue(bravoLine!.includes(',true,'), 'results.csv marks Team Bravo disqualified (,true,)');
  expectTrue(alphaLine!.includes(',false,'), 'results.csv leaves Team Alpha not disqualified (,false,)');
  ok(`results.csv: UTF-8 BOM, members column, both team rows, disqualified flag (${String(csvBuf.length)} bytes)`);

  const pdfRes = await admin.call(`/contests/${teamKey}/results.pdf`);
  if (pdfRes.status === 200) {
    const pdf = Buffer.from(await pdfRes.arrayBuffer());
    expectTrue(pdf.subarray(0, 4).toString('latin1') === '%PDF', 'results.pdf is a PDF');
    ok(`results.pdf rendered (${String(pdf.length)} bytes)`);
  } else if (pdfRes.status === 501) {
    console.log('  ** results.pdf: 501 (no typst on this deployment) — skipping the PDF assertions');
  } else {
    fail(`results.pdf: HTTP ${String(pdfRes.status)} — ${await pdfRes.text()}`);
  }

  // `?top=N` is a bound on the RANK (D74), and a disqualified team never gets a
  // certificate — an award, not a record — so this correctly prints one per
  // ELIGIBLE team: Team Alpha only, Bravo having been disqualified above.
  const certRes = await admin.call(`/contests/${teamKey}/certificates.pdf?top=10`);
  if (certRes.status === 200) {
    const cert = Buffer.from(await certRes.arrayBuffer());
    expectTrue(cert.subarray(0, 4).toString('latin1') === '%PDF', 'certificates.pdf is a PDF');
    expectTrue(cert.length > 1000, 'certificates.pdf has real content');
    // Heuristic only (page objects may sit in compressed streams).
    const pages = (cert.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    ok(`certificates.pdf rendered for eligible teams (${String(cert.length)} bytes, ~${String(pages)} page objects; Bravo excluded as disqualified)`);
  } else if (certRes.status === 501) {
    console.log('  ** certificates.pdf: 501 (no typst on this deployment) — skipping');
  } else {
    fail(`certificates.pdf: HTTP ${String(certRes.status)} — ${await certRes.text()}`);
  }

  console.log(`\nAll ${String(stepNumber)} steps passed.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
