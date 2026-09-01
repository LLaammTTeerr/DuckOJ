/**
 * D161 — two people, one record, and the second save is refused rather than
 * allowed to overwrite the first.
 *
 * **Driven over HTTP, end to end.** The token is a chain — the contract admits
 * `expectedVersion` and emits `version`, the validation pipe lets it through,
 * the service recomputes it under a lock — and a unit test against the service
 * alone would prove the middle of that chain while the two ends stayed broken.
 * These forms send `.strict()` bodies, so a field the schema did not learn
 * about is a 422 with nothing else touched, which is exactly the failure a
 * service-level test cannot see.
 *
 * Each case is written as the two form sessions it describes: a read that
 * yields a token, somebody else's save, and then the save that carries the
 * token from before it.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import {
  contestProblems,
  contests,
  problemMembers,
  problemSetItems,
  problemSets,
  problems,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, seedProblemAndLanguage, userIdOf } from './submissions.fixtures.js';

const MINUTE = 60_000;

/**
 * `POST /problems` is `canCreateProblem`, which is a setter or an admin — the
 * fixture users register as plain accounts, so the ones that author a problem
 * here are promoted. Nothing in this file is about that gate.
 */
async function promote(db: Db, username: string, role: 'setter' | 'admin'): Promise<void> {
  await db.update(schema.users).set({ globalRole: role }).where(eq(schema.users.username, username));
}

/** A contest this organiser runs, starting an hour from now so no D38 guard fires. */
async function seedContest(db: Db, key: string, ownerId: number, problemId: number): Promise<void> {
  const now = Date.now();
  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: key,
      startTime: new Date(now + 60 * MINUTE),
      endTime: new Date(now + 120 * MINUTE),
      format: 'icpc',
      visibility: 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });
  await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId, label: 'A', points: 100, order: 0 });
}

describe('two teachers editing one problem (D161)', () => {
  it('refuses the second save, writes nothing, and leaves the first teacher’s statement standing', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const anh = request.agent(app.getHttpServer());
        const binh = request.agent(app.getHttpServer());
        const anhCookie = await registerAndLogin(anh, 'd161-anh');
        const binhCookie = await registerAndLogin(binh, 'd161-binh');
        await promote(db, 'd161-anh', 'setter');

        const created = await anh
          .post('/api/v1/problems')
          .set('Cookie', anhCookie)
          .send({
            code: 'd161a',
            name: 'Cộng hai số',
            statement: 'Cho a và b.',
            visibility: 'public',
          });
        expect(created.status).toBe(201);
        // Bình is an author too, which is what makes this two teachers rather
        // than one person in two tabs. (The defect does not care: a form holds
        // a copy, and which human is behind it changes nothing.)
        const shared = await anh
          .patch('/api/v1/problems/d161a')
          .set('Cookie', anhCookie)
          .send({
            members: [
              { username: 'd161-anh', role: 'author' },
              { username: 'd161-binh', role: 'author' },
            ],
          });
        expect(shared.status).toBe(200);

        // Anh opens the edit form. This is the value her form is seeded from
        // and the value it will send back on save.
        const anhOpened = await anh.get('/api/v1/problems/d161a').set('Cookie', anhCookie);
        expect(anhOpened.status).toBe(200);
        const anhVersion = anhOpened.body.version;
        expect(typeof anhVersion).toBe('string');

        // Bình rewrites the statement and saves. Anh's form knows nothing
        // about it.
        const binhOpened = await binh.get('/api/v1/problems/d161a').set('Cookie', binhCookie);
        const binhSaved = await binh
          .patch('/api/v1/problems/d161a')
          .set('Cookie', binhCookie)
          .send({
            name: 'Cộng hai số',
            statement: 'Cho hai số nguyên a và b, in ra tổng của chúng.',
            expectedVersion: binhOpened.body.version,
          });
        expect(binhSaved.status).toBe(200);

        // Anh fixes the NAME and presses Lưu. Her form sends the whole object,
        // so the body carries the statement she was seeded with — the one Bình
        // has since replaced. Before D161 this was a 200 and Bình's rewrite
        // was gone, with nothing on screen to say so.
        const anhSaved = await anh
          .patch('/api/v1/problems/d161a')
          .set('Cookie', anhCookie)
          .send({
            name: 'Cộng hai số nguyên',
            statement: 'Cho a và b.',
            expectedVersion: anhVersion,
          });
        expect(anhSaved.status).toBe(409);
        expect(anhSaved.body.code).toBe('problem_version_conflict');

        // NOTHING was written — not the statement it would have clobbered, and
        // not the name that was the only thing Anh actually changed. A partial
        // apply would be a worse outcome than either the refusal or the loss.
        const [stored] = await db
          .select({ name: problems.name, statement: problems.statement })
          .from(problems)
          .where(eq(problems.code, 'd161a'));
        expect(stored!.statement).toBe('Cho hai số nguyên a và b, in ra tổng của chúng.');
        expect(stored!.name).toBe('Cộng hai số');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('hands back a token the same form can save with again, so a second save is not a conflict with itself', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'd161-again');
        await promote(db, 'd161-again', 'setter');
        await agent
          .post('/api/v1/problems')
          .set('Cookie', cookie)
          .send({ code: 'd161b', name: 'B', statement: 's', visibility: 'public' });

        const opened = await agent.get('/api/v1/problems/d161b').set('Cookie', cookie);
        const first = await agent
          .patch('/api/v1/problems/d161b')
          .set('Cookie', cookie)
          .send({ name: 'B1', expectedVersion: opened.body.version });
        expect(first.status).toBe(200);
        // The PATCH response is a `ProblemDetail`, so it carries the token the
        // form now holds. Without this the next save from the same open form
        // would 409 against the write it had just made itself — which would
        // make the whole feature unusable rather than merely strict.
        expect(first.body.version).toEqual(expect.any(String));
        expect(first.body.version).not.toBe(opened.body.version);

        const second = await agent
          .patch('/api/v1/problems/d161b')
          .set('Cookie', cookie)
          .send({ name: 'B2', expectedVersion: first.body.version });
        expect(second.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('does not move on a save that changed nothing, and does not move on a write the form does not own', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'd161-noop');
        await promote(db, 'd161-noop', 'setter');
        await agent
          .post('/api/v1/problems')
          .set('Cookie', cookie)
          .send({ code: 'd161c', name: 'C', statement: 's', visibility: 'public' });

        const opened = await agent.get('/api/v1/problems/d161c').set('Cookie', cookie);
        const version = opened.body.version;
        // Asserted, not assumed: without it every `toBe(version)` below is
        // `undefined === undefined` and the case passes against a build that
        // has no token at all.
        expect(typeof version).toBe('string');

        // A re-save of exactly what is stored. A version COUNTER would bump
        // here and refuse the next honest save for no reason anybody could
        // explain; a content hash does not move, which is the property D161
        // chose it for.
        const noop = await agent
          .patch('/api/v1/problems/d161c')
          .set('Cookie', cookie)
          .send({ name: 'C', statement: 's', expectedVersion: version });
        expect(noop.status).toBe(200);
        expect(noop.body.version).toBe(version);

        // A write outside `UpdateProblemRequest` — the published-revision
        // pointer, which the publish path moves and this form has no field
        // for. It must not lock the setter out of the statement.
        const [problem] = await db
          .select({ id: problems.id })
          .from(problems)
          .where(eq(problems.code, 'd161c'));
        await db
          .update(problems)
          .set({ currentRevisionId: null })
          .where(eq(problems.id, problem!.id));
        const after = await agent.get('/api/v1/problems/d161c').set('Cookie', cookie);
        expect(after.body.version).toBe(version);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('leaves a PATCH that sends no token unchecked, and serves no token to a reader who may not edit', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = request.agent(app.getHttpServer());
        const stranger = request.agent(app.getHttpServer());
        const ownerCookie = await registerAndLogin(owner, 'd161-owner');
        const strangerCookie = await registerAndLogin(stranger, 'd161-stranger');
        await promote(db, 'd161-owner', 'setter');
        await owner
          .post('/api/v1/problems')
          .set('Cookie', ownerCookie)
          .send({ code: 'd161d', name: 'D', statement: 's', visibility: 'public' });

        // Absent means unchecked, deliberately (D161): this API is a
        // documented surface with tokens behind it, and refusing every PATCH
        // that had not first read a detail would break automation that never
        // had this problem. It is the honest weak point of the ruling, so it
        // is pinned rather than left to be discovered.
        const unversioned = await owner
          .patch('/api/v1/problems/d161d')
          .set('Cookie', ownerCookie)
          .send({ name: 'D-changed' });
        expect(unversioned.status).toBe(200);

        // And a reader who cannot PATCH is given no token: it would be useless
        // to them, and computing it costs a query no pupil should pay.
        const read = await stranger.get('/api/v1/problems/d161d').set('Cookie', strangerCookie);
        expect(read.status).toBe(200);
        expect(read.body.version).toBeNull();
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('two organisers editing one contest (D161)', () => {
  it('refuses the second save and leaves the problem list the first one wrote', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = request.agent(app.getHttpServer());
        const admin = request.agent(app.getHttpServer());
        const organiserCookie = await registerAndLogin(organiser, 'd161-org');
        const adminCookie = await registerAndLogin(admin, 'd161-adm');
        await promote(db, 'd161-adm', 'admin');

        await seedProblemAndLanguage(db);
        const ownerId = await userIdOf(db, 'd161-org');
        const [second] = await db
          .insert(problems)
          .values({ code: 'd161-x', name: 'X', statement: 's', visibility: 'public', createdBy: ownerId })
          .returning({ id: problems.id });
        const [first] = await db
          .select({ id: problems.id })
          .from(problems)
          .where(eq(problems.code, 'aplusb'));
        await seedContest(db, 'd161ct', ownerId, first!.id);

        // The organiser opens the edit form.
        const opened = await organiser.get('/api/v1/contests/d161ct').set('Cookie', organiserCookie);
        expect(opened.status).toBe(200);
        const organiserVersion = opened.body.version;
        expect(typeof organiserVersion).toBe('string');

        // The admin adds the second problem to the round and saves.
        const adminOpened = await admin.get('/api/v1/contests/d161ct').set('Cookie', adminCookie);
        const adminSaved = await admin
          .patch('/api/v1/contests/d161ct')
          .set('Cookie', adminCookie)
          .send({
            problems: [
              { code: 'aplusb', points: 100, partial: true },
              { code: 'd161-x', points: 100, partial: true },
            ],
            expectedVersion: adminOpened.body.version,
          });
        expect(adminSaved.status).toBe(200);

        // The organiser adjusts only the freeze. `problems` rides along
        // because this form sends the whole object, and the list it carries is
        // the one-problem list from before the admin's save. Before D161 this
        // took the second problem back out of the round with a 200.
        const organiserSaved = await organiser
          .patch('/api/v1/contests/d161ct')
          .set('Cookie', organiserCookie)
          .send({
            frozenLastMinutes: 15,
            problems: [{ code: 'aplusb', points: 100, partial: true }],
            expectedVersion: organiserVersion,
          });
        expect(organiserSaved.status).toBe(409);
        expect(organiserSaved.body.code).toBe('contest_version_conflict');

        const [contest] = await db
          .select({ id: contests.id, frozen: contests.frozenLastMinutes })
          .from(contests)
          .where(eq(contests.key, 'd161ct'));
        // Both problems still attached — the refusal held — and the freeze the
        // organiser did type is NOT applied, because a 409 writes nothing.
        const rows = await db
          .select({ id: contestProblems.id })
          .from(contestProblems)
          .where(eq(contestProblems.contestId, contest!.id));
        expect(rows).toHaveLength(2);
        expect(contest!.frozen).toBe(0);
        expect(second!.id).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('serves no token to a spectator, and accepts a save that carries the current one', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const organiser = request.agent(app.getHttpServer());
        const spectator = request.agent(app.getHttpServer());
        const organiserCookie = await registerAndLogin(organiser, 'd161-org2');
        const spectatorCookie = await registerAndLogin(spectator, 'd161-spec');
        await seedProblemAndLanguage(db);
        const ownerId = await userIdOf(db, 'd161-org2');
        const [problem] = await db
          .select({ id: problems.id })
          .from(problems)
          .where(eq(problems.code, 'aplusb'));
        await seedContest(db, 'd161ct2', ownerId, problem!.id);

        const watched = await spectator.get('/api/v1/contests/d161ct2').set('Cookie', spectatorCookie);
        expect(watched.status).toBe(200);
        expect(watched.body.version).toBeNull();

        const opened = await organiser.get('/api/v1/contests/d161ct2').set('Cookie', organiserCookie);
        const saved = await organiser
          .patch('/api/v1/contests/d161ct2')
          .set('Cookie', organiserCookie)
          .send({ name: 'Vòng tỉnh', expectedVersion: opened.body.version });
        expect(saved.status).toBe(200);
        expect(saved.body.version).not.toBe(opened.body.version);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

/**
 * D176 — the same ruling, applied to the three other forms that have the
 * shape.
 *
 * D161 was scoped to the two places the defect was found. The reasoning was
 * never about problems and contests: it was about **any form that seeds once
 * from a cached query and saves by replacement**, because that combination
 * silently overwrites a co-editor's work with a copy the form has been holding
 * since before they saved.
 *
 * Each block below is the same three beats as the two above it — a read that
 * yields a token, somebody else's save, and then the save that carries the
 * token from before it — and each asserts on the STORED state rather than on
 * the response, because "nothing was written" is the promise the 409 makes.
 */

/** An organization with two owners, which is the whole point of these cases. */
async function seedOrgWithTwoOwners(
  app: Awaited<ReturnType<typeof buildApp>>,
  db: Db,
  slug: string,
): Promise<{ anh: ReturnType<typeof request.agent>; binh: ReturnType<typeof request.agent> }> {
  const root = request.agent(app.getHttpServer());
  await registerAndLogin(root, `${slug}-root`);
  await promote(db, `${slug}-root`, 'admin');
  const created = await root
    .post('/api/v1/orgs')
    .send({ slug, name: slug, visibility: 'public', joinPolicy: 'invite' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const anh = request.agent(app.getHttpServer());
  const binh = request.agent(app.getHttpServer());
  await registerAndLogin(anh, `${slug}-anh`);
  await registerAndLogin(binh, `${slug}-binh`);
  // BOTH owners. `OrgAccessService.loadForEdit` admits an owner or an admin,
  // so two people holding this form open is not a hypothetical — it is the
  // ordinary staffing of a school on this site.
  for (const name of [`${slug}-anh`, `${slug}-binh`]) {
    const added = await root
      .post(`/api/v1/orgs/${slug}/members`)
      .send({ username: name, role: 'owner' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  }
  return { anh, binh };
}

describe("two setters editing one problem's language limits (D176)", () => {
  it('refuses the second save, writes nothing, and leaves the first setter’s refusal standing', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const anh = request.agent(app.getHttpServer());
        const binh = request.agent(app.getHttpServer());
        await registerAndLogin(anh, 'd176-ll-anh');
        await registerAndLogin(binh, 'd176-ll-binh');
        for (const name of ['d176-ll-anh', 'd176-ll-binh']) {
          await db.insert(problemMembers).values({
            problemId: (await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'aplusb')))[0]!.id,
            userId: await userIdOf(db, name),
            role: 'author',
          });
        }

        // Anh opens the tab. Her form is seeded from this, and this is the
        // token it will send back.
        const anhOpened = await anh.get('/api/v1/problems/aplusb/language-limits');
        expect(anhOpened.status).toBe(200);
        const anhVersion: unknown = anhOpened.body.version;
        expect(typeof anhVersion).toBe('string');

        // Bình decides Python cannot express the intended solution here, and
        // refuses it. Anh's tab knows nothing about it.
        //
        // `python3` is the key migration 0042 seeds it under, and it is
        // asserted rather than assumed: a map over a key no language has would
        // store no row at all, leave the token where it was, and make this
        // whole case pass against code with no check in it.
        const binhOpened = await binh.get('/api/v1/problems/aplusb/language-limits');
        expect(
          binhOpened.body.languages.map((lang: { languageKey: string }) => lang.languageKey),
        ).toContain('python3');
        const binhSaved = await binh.put('/api/v1/problems/aplusb/language-limits').send({
          limits: binhOpened.body.languages.map((lang: { languageKey: string }) => ({
            languageKey: lang.languageKey,
            timeMultiplierPct: null,
            memoryExtraKb: null,
            allowed: lang.languageKey !== 'python3',
          })),
          expectedVersion: binhOpened.body.version,
        });
        expect(binhSaved.status, JSON.stringify(binhSaved.body)).toBe(200);

        // Anh raises C++'s multiplier and saves. Her form PUTs every language,
        // and the Python row it holds still says `allowed: true` — Bình's
        // refusal, about to be replaced by a copy taken before it existed.
        const anhSaved = await anh.put('/api/v1/problems/aplusb/language-limits').send({
          limits: anhOpened.body.languages.map((lang: { languageKey: string }) => ({
            languageKey: lang.languageKey,
            timeMultiplierPct: lang.languageKey === 'cpp17' ? 150 : null,
            memoryExtraKb: null,
            allowed: true,
          })),
          expectedVersion: anhVersion,
        });
        expect(anhSaved.status).toBe(409);
        expect(anhSaved.body.code).toBe('language_limits_version_conflict');

        // The promise the 409 makes, asserted on the STORED rows: Bình's
        // refusal is still there and Anh's multiplier was not written.
        const stored = await db
          .select({
            key: schema.languages.key,
            allowed: schema.problemLanguageLimits.allowed,
            time: schema.problemLanguageLimits.timeMultiplierPct,
          })
          .from(schema.problemLanguageLimits)
          .innerJoin(
            schema.languages,
            eq(schema.languages.id, schema.problemLanguageLimits.languageId),
          );
        expect(stored).toEqual([{ key: 'python3', allowed: false, time: null }]);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('hands back a token the same tab can save with again, and leaves a PUT that sends none unchecked', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const anh = request.agent(app.getHttpServer());
        await registerAndLogin(anh, 'd176-ll-solo');
        await db.insert(problemMembers).values({
          problemId: (await db.select({ id: problems.id }).from(problems).where(eq(problems.code, 'aplusb')))[0]!.id,
          userId: await userIdOf(db, 'd176-ll-solo'),
          role: 'author',
        });

        const opened = await anh.get('/api/v1/problems/aplusb/language-limits');
        // Asserted before anything is compared to it. Without this line every
        // `toBe(opened.body.version)` below is `undefined === undefined`, and
        // the case passes against code that serves no token at all — the trap
        // F-43's own third case fell into and recorded.
        expect(typeof opened.body.version).toBe('string');
        const all = opened.body.languages.map((lang: { languageKey: string }) => ({
          languageKey: lang.languageKey,
          timeMultiplierPct: null,
          memoryExtraKb: null,
          allowed: true,
        }));

        // A save that stores exactly what was already stored is a NO-OP, not a
        // conflict — the property a content hash buys that a counter cannot,
        // and the one that keeps a double-submitted form from refusing
        // anybody.
        const noop = await anh
          .put('/api/v1/problems/aplusb/language-limits')
          .send({ limits: all, expectedVersion: opened.body.version });
        expect(noop.status).toBe(200);
        expect(noop.body.version).toBe(opened.body.version);

        // The response carries the token as it now IS, so the same open tab
        // can save again. Without that, the next save would 409 against the
        // write it had just made itself.
        const second = await anh.put('/api/v1/problems/aplusb/language-limits').send({
          limits: all.map((row: { languageKey: string }) =>
            row.languageKey === 'cpp17' ? { ...row, timeMultiplierPct: 150 } : row,
          ),
          expectedVersion: noop.body.version,
        });
        expect(second.status, JSON.stringify(second.body)).toBe(200);
        expect(second.body.version).not.toBe(noop.body.version);

        // And the honest weak point, pinned: a client that sends no token is
        // exactly as exposed as it was before D161 existed. `opened.body
        // .version` is two saves stale by now and this PUT lands anyway.
        const unchecked = await anh
          .put('/api/v1/problems/aplusb/language-limits')
          .send({ limits: all });
        expect(unchecked.status).toBe(200);
        const rows = await db.select().from(schema.problemLanguageLimits);
        expect(rows).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('two teachers editing one problem set (D176)', () => {
  it('refuses the second save and leaves the problem the first teacher added', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const { anh, binh } = await seedOrgWithTwoOwners(app, db, 'd176set');

        const made = await anh
          .post('/api/v1/orgs/d176set/sets')
          .send({ slug: 'tuan-1', name: 'Tuần 1', problems: [] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);

        // Anh opens the set to change its deadline.
        const anhOpened = await anh.get('/api/v1/orgs/d176set/sets/tuan-1');
        expect(anhOpened.status).toBe(200);
        const anhVersion: unknown = anhOpened.body.version;
        expect(typeof anhVersion).toBe('string');

        // Bình adds this week's problem. Anh's form still holds the empty
        // list.
        const binhOpened = await binh.get('/api/v1/orgs/d176set/sets/tuan-1');
        const binhSaved = await binh
          .patch('/api/v1/orgs/d176set/sets/tuan-1')
          .send({ problems: [{ code: 'aplusb', points: 100 }], expectedVersion: binhOpened.body.version });
        expect(binhSaved.status, JSON.stringify(binhSaved.body)).toBe(200);

        const anhSaved = await anh.patch('/api/v1/orgs/d176set/sets/tuan-1').send({
          name: 'Tuần một',
          problems: [],
          expectedVersion: anhVersion,
        });
        expect(anhSaved.status).toBe(409);
        expect(anhSaved.body.code).toBe('problem_set_version_conflict');

        // Asserted on the stored items, not on the response: the problem Bình
        // assigned is still in the set, and Anh's rename was not written.
        const items = await db.select({ problemId: problemSetItems.problemId }).from(problemSetItems);
        expect(items).toHaveLength(1);
        const [row] = await db.select({ name: problemSets.name }).from(problemSets);
        expect(row!.name).toBe('Tuần 1');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('serves no token to a pupil reading their homework, and does not move on a write the form does not own', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const app = await buildApp(db);
      try {
        const { anh } = await seedOrgWithTwoOwners(app, db, 'd176set2');
        const pupil = request.agent(app.getHttpServer());
        await registerAndLogin(pupil, 'd176set2-pupil');
        const root = request.agent(app.getHttpServer());
        await registerAndLogin(root, 'd176set2-admin');
        await promote(db, 'd176set2-admin', 'admin');
        const joined = await root
          .post('/api/v1/orgs/d176set2/members')
          .send({ username: 'd176set2-pupil', role: 'member' });
        expect(joined.status).toBe(201);

        const made = await anh
          .post('/api/v1/orgs/d176set2/sets')
          .send({ slug: 'tuan-1', name: 'Tuần 1', problems: [{ code: 'aplusb', points: 100 }] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);

        // A pupil may read their own homework through this route, so the 404
        // gate is not what withholds the token. `null` is (D161's rule): it is
        // useless to somebody who cannot PATCH, and it costs a query they
        // should not pay.
        const read = await pupil.get('/api/v1/orgs/d176set2/sets/tuan-1');
        expect(read.status).toBe(200);
        expect(read.body.version).toBeNull();

        // A write the form does not own does not move the token. The problem's
        // NAME is on `ProblemSetDetail.items[].name`, and it is not a field
        // `UpdateProblemSetRequest` can write — so renaming it must not lock
        // the teacher out of the deadline.
        const before = await anh.get('/api/v1/orgs/d176set2/sets/tuan-1');
        await db.update(problems).set({ name: 'A + B, đã đổi tên' }).where(eq(problems.code, 'aplusb'));
        const after = await anh.get('/api/v1/orgs/d176set2/sets/tuan-1');
        expect(after.body.items[0].name).toBe('A + B, đã đổi tên');
        expect(after.body.version).toBe(before.body.version);

        const saved = await anh
          .patch('/api/v1/orgs/d176set2/sets/tuan-1')
          .send({ name: 'Tuần một', expectedVersion: before.body.version });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('two admins editing one team roster (D176)', () => {
  it('refuses the roster save that would drop the pupil the other admin just added', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { anh, binh } = await seedOrgWithTwoOwners(app, db, 'd176team');
        const root = request.agent(app.getHttpServer());
        await registerAndLogin(root, 'd176team-admin');
        await promote(db, 'd176team-admin', 'admin');
        for (const name of ['d176team-p1', 'd176team-p2', 'd176team-p3']) {
          const pupil = request.agent(app.getHttpServer());
          await registerAndLogin(pupil, name);
          const added = await root
            .post('/api/v1/orgs/d176team/members')
            .send({ username: name, role: 'member' });
          expect(added.status, JSON.stringify(added.body)).toBe(201);
        }

        const made = await anh
          .post('/api/v1/orgs/d176team/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['d176team-p1', 'd176team-p2'] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);

        // Anh opens the team to fix its name.
        const anhOpened = await anh.get('/api/v1/orgs/d176team/teams/doi-1');
        expect(anhOpened.status).toBe(200);
        const anhVersion: unknown = anhOpened.body.version;
        expect(typeof anhVersion).toBe('string');

        // Bình adds the third pupil. Anh's form still holds the roster of two.
        const binhOpened = await binh.get('/api/v1/orgs/d176team/teams/doi-1');
        const binhSaved = await binh.patch('/api/v1/orgs/d176team/teams/doi-1').send({
          members: ['d176team-p1', 'd176team-p2', 'd176team-p3'],
          expectedVersion: binhOpened.body.version,
        });
        expect(binhSaved.status, JSON.stringify(binhSaved.body)).toBe(200);

        // Anh's save carries the whole roster, because `members` REPLACES it.
        // On contest morning this is a pupil who cannot compete.
        const anhSaved = await anh.patch('/api/v1/orgs/d176team/teams/doi-1').send({
          name: 'Đội Một',
          members: ['d176team-p1', 'd176team-p2'],
          expectedVersion: anhVersion,
        });
        expect(anhSaved.status).toBe(409);
        expect(anhSaved.body.code).toBe('team_version_conflict');

        const roster = await db.select({ userId: teamMembers.userId }).from(teamMembers);
        expect(roster).toHaveLength(3);
        const [team] = await db.select({ name: teams.name }).from(teams);
        expect(team!.name).toBe('Đội 1');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('serves no token to somebody who may read the roster but not edit it', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const { anh } = await seedOrgWithTwoOwners(app, db, 'd176team2');
        const root = request.agent(app.getHttpServer());
        await registerAndLogin(root, 'd176team2-admin');
        await promote(db, 'd176team2-admin', 'admin');
        const pupil = request.agent(app.getHttpServer());
        await registerAndLogin(pupil, 'd176team2-p1');
        const added = await root
          .post('/api/v1/orgs/d176team2/members')
          .send({ username: 'd176team2-p1', role: 'member' });
        expect(added.status).toBe(201);

        const made = await anh
          .post('/api/v1/orgs/d176team2/teams')
          .send({ slug: 'doi-1', name: 'Đội 1', members: ['d176team2-p1'] });
        expect(made.status, JSON.stringify(made.body)).toBe(201);

        // A pupil ON the team may read it — that is the strongest membership
        // `get` accepts — and gets no token, gated on the same `canEdit` the
        // response already carries.
        const read = await pupil.get('/api/v1/orgs/d176team2/teams/doi-1');
        expect(read.status).toBe(200);
        expect(read.body.canEdit).toBe(false);
        expect(read.body.version).toBeNull();

        // And the round trip an editor makes: the response's own token saves
        // again from the same open form.
        const opened = await anh.get('/api/v1/orgs/d176team2/teams/doi-1');
        const first = await anh
          .patch('/api/v1/orgs/d176team2/teams/doi-1')
          .send({ name: 'Đội Một', expectedVersion: opened.body.version });
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body.version).not.toBe(opened.body.version);
        const again = await anh
          .patch('/api/v1/orgs/d176team2/teams/doi-1')
          .send({ name: 'Đội Hai', expectedVersion: first.body.version });
        expect(again.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
