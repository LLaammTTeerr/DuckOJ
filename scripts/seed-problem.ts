import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { problems, problemRevisions } from '@qhhoj/db/guarded';
import { createDb, hashJudgeToken, schema } from '@qhhoj/db';
import { buildPackage } from './lib/build-package.js';
import { putPackageArchive } from './lib/package-store.js';

/**
 * `problems/` resolved relative to this file, not `process.cwd()` — the
 * script is invoked from different working directories (a plain `tsx` run
 * from the repo root, a one-off container built from `apps/api`'s image per
 * `docs/runbook.md`) and only the former is guaranteed to have `problems/`
 * directly under the cwd.
 */
const PROBLEMS_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'problems');

/**
 * Which problem to seed — the directory name under `problems/`. Defaults to
 * `aplusb` so every existing invocation (`pnpm seed` with no args, the
 * one-off container command in docs/runbook.md, `seed-script.spec.ts`'s
 * `execFileAsync(TSX_BIN, [SEED_SCRIPT], ...)`) keeps seeding exactly what
 * it always has, unchanged.
 */
const PROBLEM_TARGET = process.argv[2] ?? 'aplusb';
const PROBLEM_DIR = join(PROBLEMS_ROOT, PROBLEM_TARGET);

/**
 * Presentational metadata (problem code, display name, statement text) is
 * deliberately kept *outside* `PROBLEM_DIR` — in a `<target>.meta.json`
 * sibling under `problems/` — rather than inside the package directory
 * itself. `buildPackage` hashes every file under `PROBLEM_DIR`
 * (`packDirectory` walks the whole tree), so anything placed inside it
 * becomes part of the package's content-addressed identity. A problem
 * statement is not test data a judge needs to grade against; it must not be
 * able to change the hash a submission is graded against.
 */
interface ProblemMeta {
  code: string;
  name: string;
  statement: string;
}

async function readProblemMeta(target: string): Promise<ProblemMeta> {
  const raw = await readFile(join(PROBLEMS_ROOT, `${target}.meta.json`), 'utf8');
  const parsed = JSON.parse(raw) as Partial<ProblemMeta>;
  if (!parsed.code || !parsed.name || !parsed.statement) {
    throw new Error(`problems/${target}.meta.json must have string 'code', 'name', and 'statement' fields`);
  }
  return { code: parsed.code, name: parsed.name, statement: parsed.statement };
}

const problemMeta = await readProblemMeta(PROBLEM_TARGET);

/**
 * The compose `judge` service's identity (`judge/judge.yml`'s `id: judge-1`).
 * `judged`'s bridge handshake and the API's archive-fetch guard both verify
 * `(name, token)` against this row — see `@qhhoj/db`'s `verifyJudgeCredential`
 * — so without it a fresh database leaves the judge authenticating nowhere,
 * retrying forever. No default: a hardcoded token here is a backdoor with a
 * changelog entry, so the operator must supply the credential that matches
 * whatever `judge/judge.yml`'s `key` actually is (`phase1-judge-key` by
 * default — see `.env.example`).
 */
const JUDGE_NODE_NAME = 'judge-1';
const JUDGE_DRIVER = 'dmoj';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const judgeToken = process.env.JUDGE_TOKEN;
if (!judgeToken) {
  console.error('JUDGE_TOKEN is required');
  process.exit(1);
}

// No default: `apps/api`'s own `PACKAGE_STORE_DIR` defaults to
// `/var/lib/qhhoj/packages` inside its own container, but this script runs
// as a *different* one-off container — silently defaulting here would write
// the archive into that container's own throwaway overlay filesystem
// instead of the named volume the real `api` service reads from, and the
// judge's later archive fetch would 404 against a `packages` row that looks
// perfectly registered. See docs/runbook.md's seeding section for the
// `-v <project>_package_store:/var/lib/qhhoj/packages` mount this requires.
const packageStoreDir = process.env.PACKAGE_STORE_DIR;
if (!packageStoreDir) {
  console.error('PACKAGE_STORE_DIR is required');
  process.exit(1);
}

const { db, close } = createDb(url);

try {
  const built = await buildPackage(PROBLEM_DIR);
  // Store the bytes before any database row references the hash — same
  // ordering rationale as `PackagesService.upload`'s doc comment: an
  // orphaned blob is harmless, a row pointing at a blob that was never
  // written fails far away, at grade time, on a judge.
  await putPackageArchive(packageStoreDir, built.hash, built.archive);

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
      code: problemMeta.code,
      name: problemMeta.name,
      statement: problemMeta.statement,
    })
    .onConflictDoNothing()
    .returning();

  const problem = (
    await db
      .select()
      .from(problems)
      .where(sql`lower(${problems.code}) = lower(${problemMeta.code})`)
      .limit(1)
  )[0]!;

  // Register the package before anything can reference its hash — the
  // revision insert/update below is a foreign key against `packages.hash`
  // once Task 12's migration lands.
  const insertedPackage = await db
    .insert(schema.packages)
    .values({ hash: built.hash, sizeBytes: built.archive.length, fileCount: built.files.length })
    .onConflictDoNothing()
    .returning();

  if (built.files.length > 0) {
    await db
      .insert(schema.packageFiles)
      .values(
        built.files.map((f) => ({
          packageHash: built.hash,
          path: f.path,
          sizeBytes: f.size,
          sha256: f.sha256,
        })),
      )
      .onConflictDoNothing();
  }

  const existingRevision = (
    await db.select().from(problemRevisions).where(eq(problemRevisions.problemId, problem.id)).limit(1)
  )[0];

  let revision;
  let revisionRepointed = false;
  if (!existingRevision) {
    revision = (
      await db
        .insert(problemRevisions)
        .values({ problemId: problem.id, version: 1, packageHash: built.hash, state: 'published' })
        .returning()
    )[0]!;
  } else if (existingRevision.packageHash !== built.hash) {
    // The upgrade path: an older run (or Phase 1's fixture) left this
    // revision pointing at a label that satisfies no package row —
    // `phase1-aplusb`, most plausibly. Repoint it at the real hash rather
    // than inserting a second revision.
    revision = (
      await db
        .update(problemRevisions)
        .set({ packageHash: built.hash })
        .where(eq(problemRevisions.id, existingRevision.id))
        .returning()
    )[0]!;
    revisionRepointed = true;
  } else {
    revision = existingRevision;
  }

  await db.update(problems).set({ currentRevisionId: revision.id }).where(eq(problems.id, problem.id));

  const insertedJudgeNode = await db
    .insert(schema.judgeNodes)
    .values({ name: JUDGE_NODE_NAME, tokenHash: hashJudgeToken(judgeToken), driver: JUDGE_DRIVER })
    .onConflictDoNothing()
    .returning();

  // Report what each step actually did rather than a single derived flag —
  // a run can create the language/driver key while finding an existing
  // revision, and that is not "nothing new".
  console.log(
    JSON.stringify({
      languageCreated: insertedLanguage.length > 0,
      driverKeyCreated: insertedDriverKey.length > 0,
      problemCreated: insertedProblem.length > 0,
      packageCreated: insertedPackage.length > 0,
      revisionCreated: existingRevision === undefined,
      revisionRepointed,
      judgeNodeCreated: insertedJudgeNode.length > 0,
      problemCode: problem.code,
      revisionId: revision.id,
      packageHash: revision.packageHash,
    }),
  );
} finally {
  await close();
}
