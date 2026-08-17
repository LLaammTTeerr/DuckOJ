import type { Agent as SupertestAgent } from 'supertest';
import { eq } from 'drizzle-orm';
import { problems, problemRevisions } from '@qhhoj/db/guarded';
import { schema, type Db } from '@qhhoj/db';

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

  const [problem] = await db
    .insert(problems)
    .values({ code: 'aplusb', name: 'A+B', statement: 'Add two integers.' })
    .returning();
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: 'phase1-aplusb',
      state: 'published',
    })
    .returning();
  await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problem!.id));
}

/** Registers `username` then logs it in on `agent`, so it carries a session cookie. */
export async function registerAndLogin(agent: SupertestAgent, username: string): Promise<void> {
  await agent.post('/auth/register').send({
    username,
    email: `${username}@example.com`,
    password: PASSWORD,
    displayName: username,
  });
  await agent.post('/auth/login').send({ usernameOrEmail: username, password: PASSWORD });
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
  const [problem] = await db
    .insert(problems)
    .values({ code: 'hidden', name: 'Hidden Problem', statement: 's', visibility: 'private' })
    .returning();
  const [revision] = await db
    .insert(problemRevisions)
    .values({ problemId: problem!.id, version: 1, packageHash: 'phase1-hidden', state: 'published' })
    .returning();
  await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problem!.id));
}
