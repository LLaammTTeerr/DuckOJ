import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { submissions } from '@duckoj/db/guarded';
import { registerAndLogin, seedProblemAndLanguage } from './submissions.fixtures.js';

/**
 * D160 — a pupil whose language nothing can grade is told so.
 *
 * D68 writes `blocked_reason` on a job no connected judge can run, and B-30
 * found the column is read in exactly ONE place: the admin dashboard. So a
 * submission in a language the fleet cannot grade sat at `queued` with the
 * page saying "đang chờ" — true, and silent — until an operator happened to
 * look. On today's one-judge fleet that state is unreachable (the announced
 * executor set and `language_driver_keys` are exact inverses), which is
 * precisely why it needs a test rather than a live probe: it becomes
 * reachable the moment a province adds a language, narrows
 * `--only-executors`, or restarts a judge.
 */
async function submissionIdOf(db: Db, username: string): Promise<number> {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  const [row] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.userId, user!.id));
  return row!.id;
}

async function block(db: Db, submissionId: number, reason: string): Promise<void> {
  await db
    .update(schema.gradingJobs)
    .set({ blockedReason: reason })
    .where(eq(schema.gradingJobs.submissionId, submissionId));
}

describe('GET /submissions/:id — waiting for a judge that can run this language (D160)', () => {
  it('says so, without saying anything about the fleet', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'd160-pupil');
        await agent
          .post('/api/v1/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' })
          .expect(201);
        const id = await submissionIdOf(db, 'd160-pupil');

        // Freshly queued on a healthy fleet: nothing is wrong, and the field
        // must not cry wolf at every submission's first second.
        const healthy = await agent.get(`/api/v1/submissions/${String(id)}`);
        expect(healthy.status).toBe(200);
        expect(healthy.body.state).toBe('queued');
        expect(healthy.body.awaitingCapableJudge).toBe(false);

        // `judged` reconciles the reason over the queue (D68). The string is
        // an operator's sentence about the fleet.
        await block(db, id, 'no connected judge supports language cpp17');
        const blocked = await agent.get(`/api/v1/submissions/${String(id)}`);
        expect(blocked.body.awaitingCapableJudge).toBe(true);
        // Still `queued`, deliberately (D68): the job becomes runnable the
        // instant a capable judge connects, so a terminal state would need a
        // sweeper to undo and would make every query that reasons about
        // `queued` wrong.
        expect(blocked.body.state).toBe('queued');
        // And the reason string itself never reaches the pupil. It names what
        // the fleet can and cannot run; the client renders the sentence from
        // `languageKey`, which is the pupil's own choice.
        expect(JSON.stringify(blocked.body)).not.toContain('no connected judge');
        expect(JSON.stringify(blocked.body)).not.toContain('blockedReason');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('goes back to false the moment the job is claimed', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'd160-claimed');
        await agent
          .post('/api/v1/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' })
          .expect(201);
        const id = await submissionIdOf(db, 'd160-claimed');
        await block(db, id, 'no connected judge supports language cpp17');

        // `JobStore.claim` clears `blocked_reason` in the same UPDATE that
        // claims — but a job whose state moved on while a stale reason sat
        // there must not be reported as waiting either, so the state is
        // re-checked rather than assumed.
        await db
          .update(schema.gradingJobs)
          .set({ state: 'leased' })
          .where(eq(schema.gradingJobs.submissionId, id));
        const res = await agent.get(`/api/v1/submissions/${String(id)}`);
        expect(res.body.awaitingCapableJudge).toBe(false);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
