/**
 * A path parameter that is a database `bigint` id must be validated to the
 * positive *safe-integer* range before it reaches a query. A value like
 * `99999999999999999999` (twenty nines — larger than `bigint`'s
 * `9223372036854775807`, yet `Number.isInteger` returns `true` for the
 * `1e20` it parses to and it is positive) sails through `Number.isInteger`
 * guards and Nest's `ParseIntPipe`, is bound against the column, and Postgres
 * answers `22003 numeric_value_out_of_range` — surfacing as a `500
 * internal_error` instead of a client-facing validation refusal.
 *
 * `Number.isSafeInteger` is the predicate that closes it (`isSafeInteger(1e20)
 * === false`, and it also rejects `NaN`), and a Zod `.int()` schema already
 * uses it — which is why the *Zod*-validated id params (`SubmissionIdParam`,
 * `CommentIdParam`) are safe and only the hand-rolled / `ParseIntPipe` ones
 * are not. The route fuzzer cannot reach these: a junk parent segment (`code`,
 * `key`, `slug`) 404s before the id is ever bound.
 *
 * `String(99999999999999999999) === '100000000000000000000'`, a plain digit
 * string a `bigint` column rejects — deliberately not `1e21`, whose
 * `String()` is `'1e+21'` and fails a different way.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { schema } from '@duckoj/db';
import { contests, organizations, orgMembers } from '@duckoj/db/guarded';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin } from './submissions.fixtures.js';

const OVERFLOW = '99999999999999999999'; // 20 nines > 2^63-1

async function userId(db: Parameters<Parameters<typeof withTestDb>[0]>[0], username: string): Promise<number> {
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username));
  return u!.id;
}

describe('id path params are bounded to the bigint-safe range (no 500 on overflow)', () => {
  it('DELETE /auth/tokens/:id refuses an out-of-range id instead of 500', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const cookie = await registerAndLogin(request.agent(app.getHttpServer()), 'bh30tokover');
        const res = await request(app.getHttpServer())
          .delete(`/api/v1/auth/tokens/${OVERFLOW}`)
          .set('Cookie', cookie);
        expect(res.status, JSON.stringify(res.body)).not.toBe(500);
        expect(res.status).toBe(422);
      } finally {
        await app.close();
      }
    });
  });

  it('PATCH /contests/:key/clarifications/:id refuses an out-of-range id instead of 500', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const cookie = await registerAndLogin(request.agent(app.getHttpServer()), 'bh30clarover');
        const uid = await userId(db, 'bh30clarover');
        await db.insert(contests).values({
          key: 'bh30clarc',
          name: 'c',
          startTime: new Date('2020-01-01T00:00:00Z'),
          endTime: new Date('2020-01-01T05:00:00Z'),
          format: 'icpc',
          visibility: 'public',
          createdBy: uid,
        });
        const res = await request(app.getHttpServer())
          .patch(`/api/v1/contests/bh30clarc/clarifications/${OVERFLOW}`)
          .set('Cookie', cookie)
          .send({ answer: 'x', visibility: 'public' });
        expect(res.status, JSON.stringify(res.body)).not.toBe(500);
        expect(res.status).toBe(404);
      } finally {
        await app.close();
      }
    });
  });

  it('POST /orgs/:slug/requests/:id/approve refuses an out-of-range id instead of 500', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const cookie = await registerAndLogin(request.agent(app.getHttpServer()), 'bh30orgover');
        const uid = await userId(db, 'bh30orgover');
        const [org] = await db
          .insert(organizations)
          .values({ slug: 'bh30org', name: 'Org' })
          .returning({ id: organizations.id });
        await db.insert(orgMembers).values({ orgId: org!.id, userId: uid, role: 'owner' });
        const res = await request(app.getHttpServer())
          .post(`/api/v1/orgs/bh30org/requests/${OVERFLOW}/approve`)
          .set('Cookie', cookie);
        expect(res.status, JSON.stringify(res.body)).not.toBe(500);
        expect(res.status).toBe(400);
      } finally {
        await app.close();
      }
    });
  });
});
