/**
 * F15 — contest source-similarity reports (D77).
 *
 * Two layers, in the order `contest-results.spec.ts` uses: the two pure
 * decisions the whole report rests on (which submission is compared, and
 * which pairs are compared at all), then the three routes on a real database
 * — where visibility comes before everything, so a contest the caller may
 * not see 404s and one they may see but do not run 403s.
 */
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  contestParticipations,
  contestProblems,
  contestSubmissions,
  contests,
  problemRevisions,
  problems,
  similarityRuns,
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import {
  SIMILARITY_BOUNDS,
  bestPerParticipant,
  comparePeople,
  type SimilarityBounds,
} from '../src/authz/contest.similarity.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser, registerAndLogin, userIdOf } from './submissions.fixtures.js';

const MINUTE = 60 * 1000;

/* ------------------------------------------------------------- the sources */

const ORIGINAL = `#include <bits/stdc++.h>
using namespace std;
long long gcd_of(long long a, long long b) {
  while (b != 0) { long long t = a % b; a = b; b = t; }
  return a;
}
int main() {
  int n; scanf("%d", &n);
  vector<int> values(n);
  for (int i = 0; i < n; i++) scanf("%d", &values[i]);
  long long best = 0;
  for (int i = 0; i < n; i++)
    for (int j = i + 1; j < n; j++)
      best = max(best, gcd_of(values[i], values[j]));
  printf("%lld\\n", best);
  return 0;
}
`;

/** The same program, every name changed and a comment added. */
const RENAMED = `#include <bits/stdc++.h>
using namespace std;
// uoc chung lon nhat
long long ucln(long long x, long long y) {
  while (y != 0) { long long tam = x % y; x = y; y = tam; }
  return x;
}
int main() {
  int soLuong; scanf("%d", &soLuong);
  vector<int> mang(soLuong);
  for (int idx = 0; idx < soLuong; idx++) scanf("%d", &mang[idx]);
  long long ketQua = 0;
  for (int idx = 0; idx < soLuong; idx++)
    for (int jdx = idx + 1; jdx < soLuong; jdx++)
      ketQua = max(ketQua, ucln(mang[idx], mang[jdx]));
  printf("%lld\\n", ketQua);
  return 0;
}
`;

/** A different problem, solved by somebody else. */
const UNRELATED = `#include <iostream>
#include <map>
#include <string>
using namespace std;
int main() {
  ios::sync_with_stdio(false);
  string line;
  map<string, int> counts;
  while (getline(cin, line)) { if (!line.empty()) counts[line] += 1; }
  string bestWord; int bestCount = -1;
  for (const auto& entry : counts) {
    if (entry.second > bestCount) { bestCount = entry.second; bestWord = entry.first; }
  }
  cout << bestWord << ' ' << bestCount << '\\n';
  return 0;
}
`;

/** The same algorithm again, in a language the C++ lexer must never meet. */
const PYTHON = `import sys
def ucln(x, y):
    while y != 0:
        x, y = y, x % y
    return x
def main():
    n = int(sys.stdin.readline())
    values = list(map(int, sys.stdin.readline().split()))
    best = 0
    for i in range(n):
        for j in range(i + 1, n):
            best = max(best, ucln(values[i], values[j]))
    print(best)
main()
`;

/* -------------------------------------------------- the two pure decisions */

function candidate(over: {
  username: string;
  submissionId: number;
  verdict?: string | null;
  points?: number | null;
  contestProblemId?: number;
}) {
  return {
    username: over.username,
    contestProblemId: over.contestProblemId ?? 1,
    submissionId: over.submissionId,
    verdict: over.verdict ?? null,
    points: over.points ?? null,
  };
}

describe('bestPerParticipant (D77)', () => {
  it('prefers an accepted submission over a higher-scoring wrong one', () => {
    const best = bestPerParticipant([
      candidate({ username: 'an', submissionId: 1, verdict: 'AC', points: 60 }),
      candidate({ username: 'an', submissionId: 2, verdict: 'WA', points: 90 }),
    ]);
    // A 90-point wrong answer is a draft; an AC is the finished work.
    expect(best.get('an')).toBe(1);
  });

  it('falls back to the highest-scoring submission when nothing was accepted', () => {
    const best = bestPerParticipant([
      candidate({ username: 'an', submissionId: 1, verdict: 'WA', points: 10 }),
      candidate({ username: 'an', submissionId: 2, verdict: 'WA', points: 70 }),
      candidate({ username: 'an', submissionId: 3, verdict: 'WA', points: 40 }),
    ]);
    expect(best.get('an')).toBe(2);
  });

  it('breaks a tie on the LATEST — the one the competitor ended on', () => {
    const best = bestPerParticipant([
      candidate({ username: 'an', submissionId: 7, verdict: 'AC', points: 100 }),
      candidate({ username: 'an', submissionId: 9, verdict: 'AC', points: 100 }),
    ]);
    expect(best.get('an')).toBe(9);
  });

  it('keeps one submission per person, not per submission', () => {
    const best = bestPerParticipant([
      candidate({ username: 'an', submissionId: 1, points: 10 }),
      candidate({ username: 'binh', submissionId: 2, points: 10 }),
      candidate({ username: 'an', submissionId: 3, points: 20 }),
    ]);
    expect([...best.keys()].sort()).toEqual(['an', 'binh']);
  });
});

describe('comparePeople (D77)', () => {
  const sources = new Map([
    [1, { source: ORIGINAL, languageKey: 'cpp17' }],
    [2, { source: RENAMED, languageKey: 'cpp20' }],
    [3, { source: UNRELATED, languageKey: 'cpp17' }],
    [4, { source: PYTHON, languageKey: 'py3' }],
    [5, { source: ORIGINAL, languageKey: 'rust' }],
  ]);

  it('reports a renamed copy and not an unrelated solution', () => {
    const { pairs } = comparePeople(
      new Map([['an', 1], ['binh', 2], ['cuong', 3]]),
      sources,
      0.6,
    );
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.a, pairs[0]!.b]).toEqual(['an', 'binh']);
    expect(pairs[0]!.containment).toBeGreaterThan(0.9);
    expect(pairs[0]!.language).toBe('cpp');
  });

  it('compares two C++ dialects with each other — `cpp17` and `cpp20` are one language', () => {
    const { compared } = comparePeople(new Map([['an', 1], ['binh', 2]]), sources, 0.6);
    expect(compared).toBe(1);
  });

  it('never compares across families — a Python file and a C++ file share no tokens', () => {
    const { pairs, compared } = comparePeople(new Map([['an', 1], ['dung', 4]]), sources, 0.1);
    expect(compared).toBe(0);
    expect(pairs).toEqual([]);
  });

  it('skips a language it has no lexer for rather than failing the run', () => {
    const { pairs, compared } = comparePeople(new Map([['an', 1], ['e', 5]]), sources, 0.1);
    expect(compared).toBe(0);
    expect(pairs).toEqual([]);
  });

  it('honours the threshold', () => {
    const high = comparePeople(new Map([['an', 1], ['cuong', 3]]), sources, 0.6);
    expect(high.pairs).toEqual([]);
    const low = comparePeople(new Map([['an', 1], ['cuong', 3]]), sources, 0.01);
    expect(low.pairs).toHaveLength(1);
  });

  it('sorts by containment, highest first', () => {
    const padded = `${RENAMED}\nnamespace pad { int f(int a) { return a + 1; } }\n`;
    const scored = comparePeople(
      new Map([['an', 1], ['binh', 2], ['cuong', 6]]),
      new Map([...sources, [6, { source: padded, languageKey: 'cpp17' }]]),
      0.6,
    );
    const containments = scored.pairs.map((pair) => pair.containment);
    expect([...containments].sort((x, y) => y - x)).toEqual(containments);
  });
});

/* --------------------------------------------------------------- the routes */

interface SeedResult {
  contestId: number;
  problemAId: number;
  submissionIds: Record<string, number>;
}

/**
 * A finished contest with two problems and five entrants:
 *
 * - `an` and `binh` hand in the same program on A, one of them renamed.
 * - `cuong` hands in something unrelated on A (and is disqualified — a
 *   disqualified row is exactly whose code an organiser wants compared).
 * - `dung` hands in the same algorithm in Python: another language, never
 *   compared against the C++ ones.
 * - `echo` hands in `an`'s program VIRTUALLY, after the contest. Never
 *   reported: a replay of a finished contest is not the fraud this is about.
 */
async function seedSimilarityContest(db: Db, key: string, ownerId: number,
  opts: { visibility?: 'public' | 'private' } = {},
): Promise<SeedResult> {
  const now = Date.now();
  const languageIds = new Map<string, number>();
  for (const [k, name, extension] of [
    [`${key}-cpp17`, 'C++17', 'cpp'],
    [`${key}-py3`, 'Python 3', 'py'],
  ] as const) {
    const [row] = await db
      .insert(schema.languages)
      .values({ key: k, name, extension })
      .returning({ id: schema.languages.id });
    languageIds.set(k, row!.id);
  }

  const problemIds: number[] = [];
  const revisionIds: number[] = [];
  await db.insert(schema.packages).values({ hash: `${key}-pkg`, sizeBytes: 1, fileCount: 1 });
  for (const label of ['a', 'b']) {
    const [problem] = await db
      .insert(problems)
      .values({
        code: `${key}-${label}`,
        name: `Bài ${label.toUpperCase()}`,
        statement: 'Cho $a+b$.',
        visibility: 'public',
        createdBy: ownerId,
      })
      .returning({ id: problems.id });
    const [revision] = await db
      .insert(problemRevisions)
      .values({
        problemId: problem!.id,
        version: 1,
        packageHash: `${key}-pkg`,
        state: 'published',
        createdBy: ownerId,
        timeMs: 1000,
        memoryKb: 256_000,
        testCount: 5,
        totalPoints: 100,
        checkerKind: 'wcmp',
      })
      .returning({ id: problemRevisions.id });
    await db
      .update(problems)
      .set({ currentRevisionId: revision!.id })
      .where(eq(problems.id, problem!.id));
    problemIds.push(problem!.id);
    revisionIds.push(revision!.id);
  }

  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: 'Thi thử tỉnh',
      startTime: new Date(now - 120 * MINUTE),
      endTime: new Date(now - 60 * MINUTE),
      format: 'icpc',
      visibility: opts.visibility ?? 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });
  const contestProblemIds: number[] = [];
  for (const [index, problemId] of problemIds.entries()) {
    const [row] = await db
      .insert(contestProblems)
      .values({
        contestId: contest!.id,
        problemId,
        label: index === 0 ? 'A' : 'B',
        points: 100,
        order: index,
      })
      .returning({ id: contestProblems.id });
    contestProblemIds.push(row!.id);
  }

  const submissionIds: Record<string, number> = {};
  async function handIn(
    username: string,
    virtual: number,
    problemIndex: number,
    source: string,
    languageKey: string,
    verdict: 'AC' | 'WA',
    points: number,
    tag = username,
  ): Promise<void> {
    const userId = await userIdOf(db, `${key}-${username}`);
    const rows = await db
      .select({ id: contestParticipations.id })
      .from(contestParticipations)
      .where(eq(contestParticipations.userId, userId));
    const participationId = rows.find(() => true)!.id;
    const [submission] = await db
      .insert(submissions)
      .values({
        userId,
        problemId: problemIds[problemIndex]!,
        revisionId: revisionIds[problemIndex]!,
        languageId: languageIds.get(`${key}-${languageKey}`)!,
        source,
        state: 'done',
        verdict,
        points,
        maxPoints: 100,
      })
      .returning({ id: submissions.id });
    await db.insert(contestSubmissions).values({
      participationId,
      contestProblemId: contestProblemIds[problemIndex]!,
      submissionId: submission!.id,
    });
    submissionIds[tag] = submission!.id;
    void virtual;
  }

  for (const [username, virtual, disqualified] of [
    ['an', 0, false],
    ['binh', 0, false],
    ['cuong', 0, true],
    ['dung', 0, false],
    ['echo', 1, false],
  ] as const) {
    const user = await insertUser(db, `${key}-${username}`);
    await db.insert(contestParticipations).values({
      contestId: contest!.id,
      userId: user.id,
      virtual,
      startTime: new Date(now - 110 * MINUTE),
      isDisqualified: disqualified,
    });
  }

  // `an`'s accepted C++ — and, later, a wrong answer whose source is nothing
  // like it. The report must compare the AC, not the last thing they sent.
  await handIn('an', 0, 0, ORIGINAL, 'cpp17', 'AC', 100);
  await handIn('an', 0, 0, UNRELATED, 'cpp17', 'WA', 0, 'an-wa');
  await handIn('binh', 0, 0, RENAMED, 'cpp17', 'AC', 100);
  await handIn('cuong', 0, 0, UNRELATED, 'cpp17', 'AC', 100);
  await handIn('dung', 0, 0, PYTHON, 'py3', 'AC', 100);
  await handIn('echo', 1, 0, ORIGINAL, 'cpp17', 'AC', 100);
  await handIn('an', 0, 1, UNRELATED, 'cpp17', 'AC', 100, 'an-b');

  return { contestId: contest!.id, problemAId: problemIds[0]!, submissionIds };
}

/** Start a run and wait for the background work to land. */
async function runAndSettle(
  app: Awaited<ReturnType<typeof buildApp>>,
  agent: ReturnType<typeof request.agent>,
  cookie: string,
  key: string,
  contestId: number,
  body: Record<string, unknown> = {},
): Promise<request.Response> {
  const started = await agent.post(`/contests/${key}/similarity`).set('Cookie', cookie).send(body);
  if (started.status === 201) {
    const { ContestSimilarityService } = await import('../src/authz/contest.similarity.js');
    await app.get(ContestSimilarityService).settle(contestId);
  }
  return started;
}

describe('POST + GET /contests/{key}/similarity (D77)', () => {
  it('refuses an anonymous caller with 401 on all three routes', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'sim-anon-owner');
        await seedSimilarityContest(db, 'simanon', owner.id);
        const server = request(app.getHttpServer());
        expect((await server.post('/contests/simanon/similarity').send({})).status).toBe(401);
        expect((await server.get('/contests/simanon/similarity')).status).toBe(401);
        expect((await server.get('/contests/simanon/similarity/a/b')).status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('404s a contest the caller may not see, and 403s one they may but do not run', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-nosy');
        const owner = await insertUser(db, 'sim-gate-owner');
        await seedSimilarityContest(db, 'simhidden', owner.id, { visibility: 'private' });
        await seedSimilarityContest(db, 'simshown', owner.id);

        const hidden = await agent.get('/contests/simhidden/similarity').set('Cookie', cookie);
        expect(hidden.status).toBe(404);
        expect(hidden.body.code).toBe('contest_not_found');

        const shown = await agent.get('/contests/simshown/similarity').set('Cookie', cookie);
        expect(shown.status).toBe(403);
        expect(shown.body.code).toBe('contest_forbidden');

        const started = await agent
          .post('/contests/simshown/similarity')
          .set('Cookie', cookie)
          .send({});
        expect(started.status).toBe(403);

        const pair = await agent
          .get('/contests/simshown/similarity/simshown-an/simshown-binh')
          .set('Cookie', cookie);
        expect(pair.status).toBe(403);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('answers `{ run: null }` for a contest nobody has ever checked', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-fresh');
        const ownerId = await userIdOf(db, 'sim-fresh');
        await seedSimilarityContest(db, 'simfresh', ownerId);
        const res = await agent.get('/contests/simfresh/similarity').set('Cookie', cookie);
        expect(res.status).toBe(200);
        // Never 404: that is indistinguishable from "no such contest".
        expect(res.body).toEqual({ run: null });
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('finds the copied pair, and nothing else', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-owner');
        const ownerId = await userIdOf(db, 'sim-owner');
        const seeded = await seedSimilarityContest(db, 'simrun', ownerId);

        const started = await runAndSettle(app, agent, cookie, 'simrun', seeded.contestId);
        expect(started.status).toBe(201);
        expect(started.body.status).toBe('running');
        expect(started.body.threshold).toBe(0.6);
        expect(started.body.requestedBy).toBe('sim-owner');

        const res = await agent.get('/contests/simrun/similarity').set('Cookie', cookie);
        expect(res.status).toBe(200);
        const run = res.body.run;
        expect(run.status).toBe('finished');
        expect(run.finishedAt).not.toBeNull();
        expect(run.pairs).toHaveLength(1);
        expect([run.pairs[0].a, run.pairs[0].b].sort()).toEqual(['simrun-an', 'simrun-binh']);
        expect(run.pairs[0].problemCode).toBe('simrun-a');
        expect(run.pairs[0].problemLabel).toBe('A');
        expect(run.pairs[0].containment).toBeGreaterThan(0.8);
        expect(run.pairs[0].language).toBe('cpp');

        // The ACCEPTED submission, not the later wrong answer whose source is
        // the unrelated program.
        const ids = [run.pairs[0].aSubmissionId, run.pairs[0].bSubmissionId];
        expect(ids).toContain(seeded.submissionIds.an);
        expect(ids).not.toContain(seeded.submissionIds['an-wa']);

        // A virtual replay of a finished contest is not this feature's fraud,
        // so `echo` — who handed in `an`'s exact program — is never reported.
        const named = JSON.stringify(run.pairs);
        expect(named).not.toContain('simrun-echo');
        // Four live entrants, and the virtual one is not among them.
        expect(run.participants).toBe(4);

        // Both problems are summarised, whether or not they found anything.
        expect(run.problems.map((p: { code: string }) => p.code)).toEqual([
          'simrun-a',
          'simrun-b',
        ]);
        const a = run.problems[0];
        // an, binh, cuong in C++ — dung's Python is counted as a participant
        // and compared against nobody.
        expect(a.participants).toBe(4);
        expect(a.compared).toBe(3);
        expect(a.reported).toBe(1);
        expect(a.truncated).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('honours the threshold it was given, and stores it on the run', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-strict');
        const ownerId = await userIdOf(db, 'sim-strict');
        const seeded = await seedSimilarityContest(db, 'simstrict', ownerId);
        await runAndSettle(app, agent, cookie, 'simstrict', seeded.contestId, { threshold: 1 });
        const res = await agent.get('/contests/simstrict/similarity').set('Cookie', cookie);
        expect(res.body.run.threshold).toBe(1);
        // The renamed copy is a hair under 1.0, and a threshold of exactly 1
        // asks for identical fingerprint sets.
        expect(res.body.run.pairs.length).toBeLessThanOrEqual(1);

        const loose = await agent
          .post('/contests/simstrict/similarity')
          .set('Cookie', cookie)
          .send({ threshold: 0.35 });
        // A second run of a contest whose first one has finished is fine —
        // the 409 is about a run still going, not about ever running twice.
        expect(loose.status).toBe(201);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a threshold below 0.3 — a report that noisy is worse than none', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-noisy');
        const ownerId = await userIdOf(db, 'sim-noisy');
        await seedSimilarityContest(db, 'simnoisy', ownerId);
        const res = await agent
          .post('/contests/simnoisy/similarity')
          .set('Cookie', cookie)
          .send({ threshold: 0.01 });
        expect(res.status).toBe(422);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a second run while one is going (409)', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-busy');
        const ownerId = await userIdOf(db, 'sim-busy');
        const seeded = await seedSimilarityContest(db, 'simbusy', ownerId);
        // A row left `running` — which is exactly what a second worker's
        // in-flight run looks like from this process.
        await db
          .insert(similarityRuns)
          .values({ contestId: seeded.contestId, status: 'running', threshold: 0.6 });
        const res = await agent
          .post('/contests/simbusy/similarity')
          .set('Cookie', cookie)
          .send({});
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('similarity_running');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('refuses a contest with more participants than the cap (422)', async () => {
    await withTestDb(async (db) => {
      const bounds: SimilarityBounds = { maxParticipants: 2, maxPairsPerProblem: 500 };
      const app = await buildApp(db, {
        overrides: [{ provide: SIMILARITY_BOUNDS, useValue: bounds }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-huge');
        const ownerId = await userIdOf(db, 'sim-huge');
        await seedSimilarityContest(db, 'simhuge', ownerId);
        const res = await agent.post('/contests/simhuge/similarity').set('Cookie', cookie).send({});
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('similarity_too_large');
        // The hint names the actual number, or it is a refusal nobody can act on.
        expect(res.body.detail).toContain('4');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('truncates a problem past the pair cap, and says it did', async () => {
    await withTestDb(async (db) => {
      const bounds: SimilarityBounds = { maxParticipants: 3000, maxPairsPerProblem: 1 };
      const app = await buildApp(db, {
        overrides: [{ provide: SIMILARITY_BOUNDS, useValue: bounds }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-cap');
        const ownerId = await userIdOf(db, 'sim-cap');
        const seeded = await seedSimilarityContest(db, 'simcap', ownerId);
        // A third copy of the same program: three mutually-similar entrants
        // are three pairs, and the cap admits one of them.
        await db
          .update(submissions)
          .set({ source: RENAMED })
          .where(eq(submissions.id, seeded.submissionIds.cuong!));

        await runAndSettle(app, agent, cookie, 'simcap', seeded.contestId);
        const res = await agent.get('/contests/simcap/similarity').set('Cookie', cookie);
        const a = res.body.run.problems[0];
        expect(a.reported).toBe(3);
        expect(a.truncated).toBe(true);
        expect(res.body.run.pairs).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('GET /contests/{key}/similarity/{a}/{b} (D77)', () => {
  it('serves both sources with the matched spans, in either order', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-viewer');
        const ownerId = await userIdOf(db, 'sim-viewer');
        const seeded = await seedSimilarityContest(db, 'simview', ownerId);
        await runAndSettle(app, agent, cookie, 'simview', seeded.contestId);

        const res = await agent
          .get('/contests/simview/similarity/simview-an/simview-binh')
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.problemCode).toBe('simview-a');
        expect(res.body.a.source).toContain('gcd_of');
        expect(res.body.b.source).toContain('ucln');
        expect(res.body.a.languageKey).toBe('simview-cpp17');
        expect(res.body.a.spans.length).toBeGreaterThan(0);
        expect(res.body.b.spans.length).toBeGreaterThan(0);
        // Every span points at real code in the source it belongs to.
        for (const span of res.body.a.spans) {
          expect(span.end).toBeGreaterThan(span.start);
          expect(span.end).toBeLessThanOrEqual(res.body.a.source.length);
        }

        // The pair is a pair, not an ordered one.
        const reversed = await agent
          .get('/contests/simview/similarity/simview-binh/simview-an')
          .set('Cookie', cookie);
        expect(reversed.status).toBe(200);
        expect(reversed.body.a.username).toBe(res.body.a.username);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('404s a pair the run did not report — this is not "show me any two sources"', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-fisher');
        const ownerId = await userIdOf(db, 'sim-fisher');
        const seeded = await seedSimilarityContest(db, 'simfish', ownerId);
        await runAndSettle(app, agent, cookie, 'simfish', seeded.contestId);

        // Two real competitors of this contest whose sources are unrelated.
        const res = await agent
          .get('/contests/simfish/similarity/simfish-an/simfish-cuong')
          .set('Cookie', cookie);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('similarity_pair_not_found');

        // And a problem the pair does not match on.
        const wrongProblem = await agent
          .get('/contests/simfish/similarity/simfish-an/simfish-binh?problem=simfish-b')
          .set('Cookie', cookie);
        expect(wrongProblem.status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('404s before any run has happened at all', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-early');
        const ownerId = await userIdOf(db, 'sim-early');
        await seedSimilarityContest(db, 'simearly', ownerId);
        const res = await agent
          .get('/contests/simearly/similarity/simearly-an/simearly-binh')
          .set('Cookie', cookie);
        expect(res.status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('lets a global admin who did not create the contest read the report', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'sim-root');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'sim-root'));
        const owner = await insertUser(db, 'sim-someone-else');
        const seeded = await seedSimilarityContest(db, 'simadmin', owner.id);
        const started = await runAndSettle(app, agent, cookie, 'simadmin', seeded.contestId);
        expect(started.status).toBe(201);
        const res = await agent.get('/contests/simadmin/similarity').set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body.run.pairs).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
