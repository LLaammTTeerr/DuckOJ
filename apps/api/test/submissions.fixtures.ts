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
