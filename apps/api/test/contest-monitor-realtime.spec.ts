/**
 * F23 — the `contest-activity` WebSocket frame (D95).
 *
 * The monitor page polls every five seconds; this is what makes it feel live
 * in between. Two claims, and they are the whole feature:
 *
 *  - an organiser who watches a contest is woken when a submission in it
 *    changes state, through the SAME Redis channel `judged` already publishes
 *    verdicts on;
 *  - a signed-in caller who does not run the contest cannot watch it — and,
 *    because `AuthGuard` never sees a WebSocket upgrade, that refusal is the
 *    only thing standing between them and a live feed of the room.
 *
 * `buildAppWithRealtime` is what makes this real rather than a unit test of a
 * method: an actual socket, an actual Redis, an actual publish.
 */
import { WebSocket } from 'ws';
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
  submissions,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildAppWithRealtime } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, userIdOf } from './submissions.fixtures.js';

const MINUTE = 60 * 1000;

function open(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('unexpected-response', (_req, res) => reject(new Error(`http ${String(res.statusCode)}`)));
  });
}

/** The next frame, or a rejection — never a hang that reads as a pass. */
function nextFrame(socket: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame arrived')), timeoutMs);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
}

/** Every frame seen in `ms`. The only honest way to assert that none arrived. */
function collect(socket: WebSocket, ms: number): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  const listener = (data: unknown): void => {
    seen.push(JSON.parse(String(data)) as Record<string, unknown>);
  };
  socket.on('message', listener);
  return new Promise((resolve) =>
    setTimeout(() => {
      socket.off('message', listener);
      resolve(seen);
    }, ms),
  );
}

/** A running contest with one problem, one competitor and one submission in it. */
async function seed(
  db: Db,
  key: string,
  ownerId: number,
  competitorId: number,
): Promise<{ submissionId: number }> {
  const now = Date.now();
  const [language] = await db
    .insert(schema.languages)
    .values({ key: `${key}-cpp`, name: 'C++17', extension: 'cpp' })
    .returning({ id: schema.languages.id });
  await db.insert(schema.packages).values({ hash: `${key}-pkg`, sizeBytes: 1, fileCount: 1 });
  const [problem] = await db
    .insert(problems)
    .values({
      code: `${key}-a`,
      name: 'Bài A',
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

  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: 'Thi thử',
      startTime: new Date(now - 30 * MINUTE),
      endTime: new Date(now + 30 * MINUTE),
      format: 'icpc',
      visibility: 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });
  const [contestProblem] = await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: problem!.id, label: 'A', points: 100, order: 0 })
    .returning({ id: contestProblems.id });
  const [participation] = await db
    .insert(contestParticipations)
    .values({
      contestId: contest!.id,
      userId: competitorId,
      virtual: 0,
      startTime: new Date(now - 25 * MINUTE),
    })
    .returning({ id: contestParticipations.id });
  const [submission] = await db
    .insert(submissions)
    .values({
      userId: competitorId,
      problemId: problem!.id,
      revisionId: revision!.id,
      languageId: language!.id,
      source: 'int main(){}',
      state: 'queued',
    })
    .returning({ id: submissions.id });
  await db.insert(contestSubmissions).values({
    participationId: participation!.id,
    contestProblemId: contestProblem!.id,
    submissionId: submission!.id,
  });
  return { submissionId: submission!.id };
}

describe('contest-activity over the WebSocket (D95)', () => {
  it('wakes an organiser watching the contest when a submission in it changes state', async () => {
    await withTestDb(async (db) => {
      const { app, url, publish } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'wsowner');
        const ownerId = await userIdOf(db, 'wsowner');
        const competitor = request.agent(app.getHttpServer());
        await registerAndLogin(competitor, 'wsplayer');
        const competitorId = await userIdOf(db, 'wsplayer');
        const { submissionId } = await seed(db, 'wslive', ownerId, competitorId);

        const socket = await open(`${url}/ws`, { cookie });
        try {
          socket.send(JSON.stringify({ type: 'watch-contest', key: 'wslive' }));
          // The ack, not a `setTimeout`: it is the server's own proof the
          // watch is live, and the reason `subscribed` exists at all.
          expect(await nextFrame(socket)).toEqual({ type: 'contest-watched', key: 'wslive' });

          const activity = nextFrame(socket);
          await publish(submissionId);
          expect(await activity).toEqual({ type: 'contest-activity', key: 'wslive' });
        } finally {
          socket.close();
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('publishes nothing for a practice submission, which belongs to no contest', async () => {
    await withTestDb(async (db) => {
      const { app, url, publish } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'wspracowner');
        const ownerId = await userIdOf(db, 'wspracowner');
        const competitor = request.agent(app.getHttpServer());
        await registerAndLogin(competitor, 'wspracplayer');
        const competitorId = await userIdOf(db, 'wspracplayer');
        await seed(db, 'wsprac', ownerId, competitorId);

        // A submission with no `contest_submissions` row at all.
        const [practice] = await db
          .insert(submissions)
          .values({
            userId: competitorId,
            problemId: (await db.select({ id: problems.id }).from(problems).limit(1))[0]!.id,
            revisionId: (
              await db.select({ id: problemRevisions.id }).from(problemRevisions).limit(1)
            )[0]!.id,
            languageId: (await db.select({ id: schema.languages.id }).from(schema.languages).limit(1))[0]!
              .id,
            source: 'int main(){}',
            state: 'queued',
          })
          .returning({ id: submissions.id });

        const socket = await open(`${url}/ws`, { cookie });
        try {
          socket.send(JSON.stringify({ type: 'watch-contest', key: 'wsprac' }));
          expect(await nextFrame(socket)).toEqual({ type: 'contest-watched', key: 'wsprac' });

          const frames = collect(socket, 600);
          await publish(practice!.id);
          expect(await frames).toEqual([]);
        } finally {
          socket.close();
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a signed-in caller who does not run the contest, and sends them nothing', async () => {
    await withTestDb(async (db) => {
      const { app, url, publish } = await buildAppWithRealtime(db);
      try {
        const owner = request.agent(app.getHttpServer());
        await registerAndLogin(owner, 'wsdenyowner');
        const ownerId = await userIdOf(db, 'wsdenyowner');
        const intruderAgent = request.agent(app.getHttpServer());
        const intruderCookie = await registerAndLogin(intruderAgent, 'wsintruder');
        const intruderId = await userIdOf(db, 'wsintruder');
        const { submissionId } = await seed(db, 'wsdeny', ownerId, intruderId);

        const socket = await open(`${url}/ws`, { cookie: intruderCookie });
        try {
          socket.send(JSON.stringify({ type: 'watch-contest', key: 'wsdeny' }));
          // A COMPETITOR in this contest — they can see it, they submitted
          // into it, and they still may not watch the room.
          expect(await nextFrame(socket)).toEqual({ type: 'error', code: 'contest_forbidden' });

          const frames = collect(socket, 600);
          await publish(submissionId);
          // Not merely "no ack": no activity either, ever. A refusal that
          // left the socket enrolled would be a refusal in name only.
          expect(await frames).toEqual([]);
        } finally {
          socket.close();
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('answers contest_not_found for a contest the caller may not see', async () => {
    await withTestDb(async (db) => {
      const { app, url } = await buildAppWithRealtime(db);
      try {
        const owner = request.agent(app.getHttpServer());
        await registerAndLogin(owner, 'wshiddenowner');
        const ownerId = await userIdOf(db, 'wshiddenowner');
        const outsider = request.agent(app.getHttpServer());
        const outsiderCookie = await registerAndLogin(outsider, 'wsoutsider');
        // The competitor is somebody else: a participation of one's own may
        // be enough to SEE a private contest, and this test is about the
        // caller who has nothing to do with it.
        const player = request.agent(app.getHttpServer());
        await registerAndLogin(player, 'wshiddenplayer');
        await seed(db, 'wshidden', ownerId, await userIdOf(db, 'wshiddenplayer'));
        await db
          .update(contests)
          .set({ visibility: 'private' })
          .where(eq(contests.key, 'wshidden'));

        const socket = await open(`${url}/ws`, { cookie: outsiderCookie });
        try {
          socket.send(JSON.stringify({ type: 'watch-contest', key: 'wshidden' }));
          expect(await nextFrame(socket)).toEqual({ type: 'error', code: 'contest_not_found' });

          // A key that names nothing is indistinguishable from one they may
          // not see — the gateway must not become an existence oracle.
          socket.send(JSON.stringify({ type: 'watch-contest', key: 'nosuchcontest' }));
          expect(await nextFrame(socket)).toEqual({ type: 'error', code: 'contest_not_found' });
        } finally {
          socket.close();
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('releases a watch taken under a differently-cased key', async () => {
    // `watch-contest` goes out of its way to match a key case-insensitively
    // (D8's `contests_key_lower_idx`) and stores the CANONICAL spelling, so a
    // client that re-watches on every reconnect pays for it once. Its pair
    // deleted the raw string the client sent, which is a different string —
    // so `unwatch-contest` spelled the way the client had spelled its own
    // `watch-contest` silently did nothing, and the socket kept both the
    // activity frames and its slot against the eight-watch cap.
    await withTestDb(async (db) => {
      const { app, url, publish } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'wscaseowner');
        const ownerId = await userIdOf(db, 'wscaseowner');
        const competitor = request.agent(app.getHttpServer());
        await registerAndLogin(competitor, 'wscaseplayer');
        const competitorId = await userIdOf(db, 'wscaseplayer');
        const { submissionId } = await seed(db, 'wscase', ownerId, competitorId);

        const socket = await open(`${url}/ws`, { cookie });
        try {
          socket.send(JSON.stringify({ type: 'watch-contest', key: 'WsCase' }));
          // The ack carries the canonical spelling — the watch is real.
          expect(await nextFrame(socket)).toEqual({ type: 'contest-watched', key: 'wscase' });

          socket.send(JSON.stringify({ type: 'unwatch-contest', key: 'WsCase' }));
          // Echoed as sent, `unsubscribe`'s shape: the client hears about the
          // frame it wrote.
          expect(await nextFrame(socket)).toEqual({ type: 'contest-unwatched', key: 'WsCase' });

          const frames = collect(socket, 600);
          await publish(submissionId);
          expect(await frames).toEqual([]);
        } finally {
          socket.close();
        }
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
