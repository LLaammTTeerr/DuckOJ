import { eq, sql } from 'drizzle-orm';
import { problems, problemRevisions } from '@qhhoj/db/guarded';
import { createDb, schema } from '@qhhoj/db';

/**
 * The problem's content hash. Phase 1 has no package system, so this is a
 * fixed label rather than a digest — but the GradingJob carries it, and the
 * DMOJ driver maps it to an on-disk code. That keeps the seam the spec
 * requires: nothing above the driver ever learns a problem directory name.
 */
const PACKAGE_HASH = 'phase1-aplusb';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, close } = createDb(url);

try {
  const insertedLanguage = await db
    .insert(schema.languages)
    .values({ key: 'cpp17', name: 'C++17', extension: 'cpp' })
    .onConflictDoNothing()
    .returning();

  const language = (
    await db.select().from(schema.languages).where(eq(schema.languages.key, 'cpp17')).limit(1)
  )[0]!;

  const insertedDriverKey = await db
    .insert(schema.languageDriverKeys)
    .values({ languageId: language.id, driver: 'dmoj', executorKey: 'CPP17' })
    .onConflictDoNothing()
    .returning();

  const insertedProblem = await db
    .insert(problems)
    .values({
      code: 'aplusb',
      name: 'A plus B',
      statement: 'Read two integers a and b from standard input. Print a + b.',
    })
    .onConflictDoNothing()
    .returning();

  const problem = (
    await db.select().from(problems).where(sql`lower(${problems.code}) = 'aplusb'`).limit(1)
  )[0]!;

  const existingRevision = (
    await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, problem.id)).limit(1)
  )[0];

  const revision =
    existingRevision ??
    (
      await db
        .insert(problemRevisions)
        .values({ problemId: problem.id, version: 1, packageHash: PACKAGE_HASH, state: 'published' })
        .returning()
    )[0]!;

  await db.update(problems).set({ currentRevisionId: revision.id }).where(eq(problems.id, problem.id));

  // Report what each step actually did rather than a single derived flag —
  // a run can create the language/driver key while finding an existing
  // revision, and that is not "nothing new".
  console.log(
    JSON.stringify({
      languageCreated: insertedLanguage.length > 0,
      driverKeyCreated: insertedDriverKey.length > 0,
      problemCreated: insertedProblem.length > 0,
      revisionCreated: existingRevision === undefined,
      problemCode: problem.code,
      revisionId: revision.id,
      packageHash: revision.packageHash,
    }),
  );
} finally {
  await close();
}
