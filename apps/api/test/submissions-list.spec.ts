import request from 'supertest';
import type { Agent as SupertestAgent } from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { problems, submissions } from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, seedProblemAndLanguage, seedPrivateProblem } from './submissions.fixtures.js';

async function userIdOf(db: Db, username: string): Promise<number> {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  if (!user) throw new Error(`no such user: ${username}`);
  return user.id;
}

/**
 * Inserts a submission row directly, bypassing `SubmissionAccessService.create`
 * (and therefore its problem-visibility check) — used to seed a submission on
 * a *private* problem for a user who is not a member of it. `getVisible` /
 * `listVisible` both answer purely on ownership (Phase 1's rule — see
 * `submission.visibility.ts`), never on whether the underlying problem is
 * visible right now, so this is exactly the corpus entry that would catch a
 * `listVisible` accidentally made *stricter* than `getVisible` by routing
 * through the problem-visibility predicate instead.
 */
async function insertRawSubmission(
  db: Db,
  opts: { userId: number; problemCode: string; languageKey: string },
): Promise<number> {
  const [problem] = await db
    .select({ id: problems.id, currentRevisionId: problems.currentRevisionId })
    .from(problems)
    .where(eq(problems.code, opts.problemCode));
  if (!problem?.currentRevisionId) throw new Error(`no published revision for ${opts.problemCode}`);
  const [language] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, opts.languageKey));
  if (!language) throw new Error(`no such language: ${opts.languageKey}`);
  const [row] = await db
    .insert(submissions)
    .values({
      userId: opts.userId,
      problemId: problem.id,
      revisionId: problem.currentRevisionId,
      languageId: language.id,
      source: 'x',
    })
    .returning({ id: submissions.id });
  return row!.id;
}

/** Every id `GET /submissions` returns to `agent`, walking `nextCursor` with a small page size. */
async function listedIds(agent: SupertestAgent, limit: number): Promise<Set<number>> {
  const ids = new Set<number>();
  let cursor: string | undefined;
  // Bounds the walk rather than looping on a server bug that never reports
  // `nextCursor: null` — a hang here would be a worse failure than a wrong
  // answer.
  for (let guard = 0; guard < 50; guard += 1) {
    const res = await agent.get('/submissions').query(cursor ? { limit, cursor } : { limit });
    expect(res.status).toBe(200);
    for (const item of res.body.items as { id: number }[]) ids.add(item.id);
    const nextCursor = res.body.nextCursor as string | null;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return ids;
}

/** Every corpus id `GET /submissions/:id` answers 200 for, tried one at a time. */
async function readableIds(agent: SupertestAgent, corpus: number[]): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const id of corpus) {
    const res = await agent.get(`/submissions/${id}`);
    if (res.status === 200) {
      ids.add(id);
    } else {
      expect(res.status, `GET /submissions/${id} for a non-visible id`).toBe(404);
    }
  }
  return ids;
}

function sorted(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

describe('GET /submissions: the list/read agreement (spec §4.1)', () => {
  // The property that matters most in this phase: for a fixed corpus and a
  // fixed actor, the id set GET /submissions returns must equal the id set
  // GET /submissions/:id answers 200 for — asserted here as ONE test walking
  // both paths over the SAME corpus, never as two tests that could drift
  // apart (the Phase 2b org-visibility shape). The corpus is built to catch
  // divergence in both directions: other users' submissions on a public
  // problem (would leak if the list were laxer than the read), and the
  // actor's own submission on a problem she cannot currently see (would
  // vanish from the list if it were stricter than the read).
  it('produces exactly the ids GET /submissions/:id answers 200 for — for a non-admin and for an admin', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedPrivateProblem(db);
      const app = await buildApp(db);
      try {
        const quinn = request.agent(app.getHttpServer());
        await registerAndLogin(quinn, 'sub-list-quinn');
        const rita = request.agent(app.getHttpServer());
        await registerAndLogin(rita, 'sub-list-rita');
        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'sub-list-admin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'sub-list-admin'));

        const quinnId = await userIdOf(db, 'sub-list-quinn');
        const ritaId = await userIdOf(db, 'sub-list-rita');

        const corpus: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          const res = await quinn
            .post('/submissions')
            .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: `quinn-${i}` });
          expect(res.status).toBe(201);
          corpus.push((res.body as { id: number }).id);
        }
        for (let i = 0; i < 2; i += 1) {
          const res = await rita
            .post('/submissions')
            .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: `rita-${i}` });
          expect(res.status).toBe(201);
          corpus.push((res.body as { id: number }).id);
        }
        // Quinn's own submission on `hidden`, a problem she is not a member
        // of and currently cannot see via GET /problems/hidden.
        corpus.push(await insertRawSubmission(db, { userId: quinnId, problemCode: 'hidden', languageKey: 'cpp17' }));
        // Rita's submission on the same private problem — visible only to
        // Rita and an admin, never to Quinn.
        corpus.push(await insertRawSubmission(db, { userId: ritaId, problemCode: 'hidden', languageKey: 'cpp17' }));

        expect(corpus).toHaveLength(7);

        const cases: Array<[string, SupertestAgent]> = [
          ['quinn (non-admin)', quinn],
          ['admin', adminAgent],
        ];
        for (const [name, agent] of cases) {
          const listed = sorted(await listedIds(agent, 2));
          const readable = sorted(await readableIds(agent, corpus));
          expect(listed, `${name}: GET /submissions ids`).toEqual(readable);
        }

        // Sanity: the property above isn't vacuously true over an empty or
        // full set — quinn sees exactly her own 4 (3 on aplusb + 1 on
        // hidden), the admin sees all 7.
        expect((await listedIds(quinn, 2)).size).toBe(4);
        expect((await listedIds(adminAgent, 2)).size).toBe(7);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /submissions: descending keyset pagination', () => {
  it('orders newest first and pages via cursor with no gaps or duplicates', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'sub-list-paginator');

        const ids: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const res = await agent
            .post('/submissions')
            .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: `p-${i}` });
          expect(res.status).toBe(201);
          ids.push((res.body as { id: number }).id);
        }
        // Ascending insertion order; the list must come back the exact
        // reverse — newest (highest id) first.
        const newestFirst = [...ids].reverse();

        const first = await agent.get('/submissions').query({ limit: 2 });
        expect(first.status).toBe(200);
        expect((first.body.items as { id: number }[]).map((i) => i.id)).toEqual(newestFirst.slice(0, 2));
        expect(first.body.nextCursor).not.toBeNull();

        const second = await agent.get('/submissions').query({ limit: 2, cursor: first.body.nextCursor });
        expect((second.body.items as { id: number }[]).map((i) => i.id)).toEqual(newestFirst.slice(2, 4));
        expect(second.body.nextCursor).not.toBeNull();

        const third = await agent.get('/submissions').query({ limit: 2, cursor: second.body.nextCursor });
        expect((third.body.items as { id: number }[]).map((i) => i.id)).toEqual(newestFirst.slice(4, 5));
        // Exhausted: no fourth page.
        expect(third.body.nextCursor).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /submissions: filters', () => {
  it('problem= narrows to that problem only', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      await seedPrivateProblem(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'sub-filter-problem');
        const userId = await userIdOf(db, 'sub-filter-problem');

        const onAplusb = await agent
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'x' });
        expect(onAplusb.status).toBe(201);
        const onHidden = await insertRawSubmission(db, { userId, problemCode: 'hidden', languageKey: 'cpp17' });

        const res = await agent.get('/submissions').query({ problem: 'aplusb', limit: 25 });
        expect(res.status).toBe(200);
        const ids = (res.body.items as { id: number }[]).map((i) => i.id);
        expect(ids).toContain((onAplusb.body as { id: number }).id);
        expect(ids).not.toContain(onHidden);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('user= naming someone else returns an EMPTY page for a non-admin — not a 403', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const alice = request.agent(app.getHttpServer());
        await registerAndLogin(alice, 'sub-filter-alice');
        const bob = request.agent(app.getHttpServer());
        await registerAndLogin(bob, 'sub-filter-bob');
        const created = await bob
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'x' });
        expect(created.status).toBe(201);

        // A 403 here would itself confirm that a user named "sub-filter-bob"
        // exists — the same existence-oracle reasoning `getVisible` already
        // applies by answering 404 rather than 403.
        const res = await alice.get('/submissions').query({ user: 'sub-filter-bob', limit: 25 });
        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([]);
        expect(res.body.nextCursor).toBeNull();

        // Same shape for a user who doesn't exist at all.
        const unknown = await alice.get('/submissions').query({ user: 'no-such-user-at-all', limit: 25 });
        expect(unknown.status).toBe(200);
        expect(unknown.body.items).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('user= naming someone else returns their submissions for an admin', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const adminAgent = request.agent(app.getHttpServer());
        await registerAndLogin(adminAgent, 'sub-filter-admin');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'sub-filter-admin'));

        const dana = request.agent(app.getHttpServer());
        await registerAndLogin(dana, 'sub-filter-dana');
        const created = await dana
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'x' });
        expect(created.status).toBe(201);

        // A second submitter, so the filter has something real to narrow
        // away — without this, an admin who saw *every* submission (i.e. a
        // `user=` filter silently ignored) would produce the same single-item
        // page and the assertion below would pass for the wrong reason.
        const eve = request.agent(app.getHttpServer());
        await registerAndLogin(eve, 'sub-filter-eve');
        const other = await eve.post('/submissions').send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'y' });
        expect(other.status).toBe(201);

        const res = await adminAgent.get('/submissions').query({ user: 'sub-filter-dana', limit: 25 });
        expect(res.status).toBe(200);
        expect((res.body.items as { id: number }[]).map((i) => i.id)).toEqual([(created.body as { id: number }).id]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('verdict= narrows to submissions carrying that verdict', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'sub-filter-verdict');

        const ac = await agent.post('/submissions').send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'ac' });
        const wa = await agent.post('/submissions').send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'wa' });
        expect(ac.status).toBe(201);
        expect(wa.status).toBe(201);
        await db
          .update(submissions)
          .set({ verdict: 'AC', state: 'done' })
          .where(eq(submissions.id, (ac.body as { id: number }).id));
        await db
          .update(submissions)
          .set({ verdict: 'WA', state: 'done' })
          .where(eq(submissions.id, (wa.body as { id: number }).id));

        const res = await agent.get('/submissions').query({ verdict: 'AC', limit: 25 });
        expect(res.status).toBe(200);
        expect((res.body.items as { id: number }[]).map((i) => i.id)).toEqual([(ac.body as { id: number }).id]);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});

describe('GET /submissions: rejects an invalid cursor with 422, not 500', () => {
  it('rejects a non-numeric cursor', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'sub-list-bad-cursor');
        const res = await agent.get('/submissions').query({ cursor: 'not-a-number' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('invalid_cursor');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
