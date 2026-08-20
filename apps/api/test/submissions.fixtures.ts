import type { Agent as SupertestAgent } from 'supertest';
import { eq } from 'drizzle-orm';
import { problems, problemRevisions } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';

const PASSWORD = 'a-long-enough-password';

/**
 * Seeds the `cpp17` language (plus its `dmoj` driver key), the `aplusb`
 * problem, and a published revision with `packageHash: 'phase1-aplusb'` set
 * as the problem's current revision — the minimum a submission needs to be
 * created against.
 */
export async function seedProblemAndLanguage(db: Db): Promise<void> {
  const [language] = await db
    .insert(schema.languages)
    .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
    .returning();
  await db.insert(schema.languageDriverKeys).values({
    languageId: language!.id,
    driver: 'dmoj',
    executorKey: 'CPP17',
  });

  const owner = await insertUser(db, 'aplusb-owner');
  const [problem] = await db
    .insert(problems)
    .values({ code: 'aplusb', name: 'A+B', statement: 'Add two integers.', createdBy: owner.id })
    .returning();
  await db.insert(schema.packages).values({ hash: 'phase1-aplusb', sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: 'phase1-aplusb',
      state: 'published',
      createdBy: owner.id,
      timeMs: 1000,
      memoryKb: 256_000,
      testCount: 5,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning();
  await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problem!.id));
}

/**
 * Registers `username` then logs it in on `agent`, so it carries a session
 * cookie for its own subsequent requests, and returns that cookie as a
 * `name=value` string for callers — the WebSocket tests — that need to set it
 * as a header by hand on a client `supertest`'s agent doesn't drive.
 */
export async function registerAndLogin(agent: SupertestAgent, username: string): Promise<string> {
  await agent.post('/auth/register').send({
    username,
    email: `${username}@example.com`,
    password: PASSWORD,
    displayName: username,
  });
  const res = await agent.post('/auth/login').send({ usernameOrEmail: username, password: PASSWORD });
  const setCookie: unknown = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? (setCookie[0] as string | undefined) : (setCookie as string | undefined);
  if (!raw) throw new Error(`login for ${username} did not set a session cookie`);
  return raw.split(';')[0]!;
}

/**
 * Inserts a user directly (bypassing HTTP registration) for tests that call
 * `SubmissionAccessService` in-process and need a real `users.id` to satisfy
 * `submissions.user_id`'s foreign key — optionally with `globalRole: 'admin'`,
 * which registration can never produce.
 */
export async function insertUser(
  db: Db,
  username: string,
  globalRole: 'user' | 'admin' = 'user',
): Promise<{ id: number }> {
  const [user] = await db
    .insert(schema.users)
    .values({ username, email: `${username}@e.com`, passwordHash: 'x', displayName: username, globalRole })
    .returning({ id: schema.users.id });
  return user!;
}

/**
 * A second problem, `hidden`, `visibility: 'private'`, with its own published
 * revision — for the visibility-oracle regression test. Call after
 * `seedProblemAndLanguage`, which provides the `cpp17` language this
 * problem's submissions also need.
 */
export async function seedPrivateProblem(db: Db): Promise<void> {
  const owner = await insertUser(db, 'hidden-owner');
  const [problem] = await db
    .insert(problems)
    .values({ code: 'hidden', name: 'Hidden Problem', statement: 's', visibility: 'private', createdBy: owner.id })
    .returning();
  await db.insert(schema.packages).values({ hash: 'phase1-hidden', sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: 'phase1-hidden',
      state: 'published',
      createdBy: owner.id,
      timeMs: 1000,
      memoryKb: 256_000,
      testCount: 5,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning();
  await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problem!.id));
}
