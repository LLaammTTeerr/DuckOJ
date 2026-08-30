import type { Agent as SupertestAgent } from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { problemMembers, problems, problemRevisions, submissions } from '@duckoj/db/guarded';
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
  await agent
    .post('/api/v1/auth/register')
    // D26 meters registration at 5 per client IP per hour, and every request
    // in these tests comes off the same loopback socket — so a spec that
    // seeds six users would have its sixth refused 429 and its login then
    // fail with a confusing "no session cookie". Each fixture user gets its
    // own synthetic client address, which is what the test means anyway:
    // these are distinct people, not one host registering a crowd. The
    // limiter's real behaviour is exercised deliberately, with explicit
    // addresses, in `register.spec.ts`.
    .set('X-Forwarded-For', fixtureClientIp(username))
    .send({
      username,
      email: `${username}@example.com`,
      password: PASSWORD,
      displayName: username,
    });
  const res = await agent.post('/api/v1/auth/login').send({ usernameOrEmail: username, password: PASSWORD });
  const setCookie: unknown = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? (setCookie[0] as string | undefined) : (setCookie as string | undefined);
  if (!raw) throw new Error(`login for ${username} did not set a session cookie`);
  return raw.split(';')[0]!;
}

/**
 * A stable, per-username address in `198.18.0.0/15` — the RFC 2544 benchmark
 * range, which is not routable and cannot collide with a real address a test
 * might otherwise care about. Deterministic so a re-run of the same spec
 * lands on the same window.
 */
function fixtureClientIp(username: string): string {
  let hash = 0;
  for (const char of username) hash = (hash * 31 + char.charCodeAt(0)) % 65_536;
  return `198.18.${String(Math.floor(hash / 256))}.${String(hash % 256)}`;
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

/**
 * A problem with an explicit `sourceAccess`, its own published revision, and
 * no members — the corpus building block for the source-visibility tests,
 * which need several problems differing only in that flag.
 *
 * `seedProblemAndLanguage` must have run first: this reuses the `cpp17`
 * language rather than seeding a second one.
 */
export async function seedProblemWithSourceAccess(
  db: Db,
  opts: {
    code: string;
    sourceAccess?: 'private' | 'solved';
    visibility?: 'private' | 'org' | 'public';
  },
): Promise<{ id: number; revisionId: number }> {
  const owner = await insertUser(db, `${opts.code}-owner`);
  const [problem] = await db
    .insert(problems)
    .values({
      code: opts.code,
      name: opts.code,
      statement: 's',
      visibility: opts.visibility ?? 'public',
      // Left unset when the caller passes nothing, so a corpus entry can
      // exercise the migration's DEFAULT rather than a value this fixture
      // restated — design §4.3's "the default is closed".
      ...(opts.sourceAccess ? { sourceAccess: opts.sourceAccess } : {}),
      createdBy: owner.id,
    })
    .returning();
  await db.insert(schema.packages).values({ hash: `pkg-${opts.code}`, sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: `pkg-${opts.code}`,
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
  return { id: problem!.id, revisionId: revision!.id };
}

/** Grants `username` a role on a problem — author, curator or tester. */
export async function grantProblemRole(
  db: Db,
  problemId: number,
  userId: number,
  role: 'author' | 'curator' | 'tester',
): Promise<void> {
  await db.insert(problemMembers).values({ problemId, userId, role });
}

/**
 * Publishes a second revision of `problemId`, archiving the first — so a
 * submission graded `AC` against the old one is an AC on a revision that is
 * no longer current. Design §2.4 fixes "has an AC" as *not* revision-scoped,
 * and this is the fixture that lets a test tell the two readings apart.
 *
 * `totalPoints` defaults to 100 — every existing caller relies on that — but
 * is overridable: the `me`-column "best verdict" spec
 * (`2026-08-21-best-verdict-design.md` §7) calls out that a fixture where
 * every revision shares the same total cannot distinguish "maxPoints comes
 * from the submission's own revision" from "maxPoints comes from the
 * problem's current revision", because the two readings agree whenever the
 * totals happen to match. A caller that wants that distinction passes a
 * different `totalPoints` here.
 */
export async function publishNextRevision(
  db: Db,
  problemId: number,
  code: string,
  totalPoints = 100,
): Promise<number> {
  const owner = await insertUser(db, `${code}-owner-v2`);
  await db.insert(schema.packages).values({ hash: `pkg-${code}-v2`, sizeBytes: 1, fileCount: 1 });
  await db
    .update(problemRevisions)
    .set({ state: 'archived' })
    .where(eq(problemRevisions.problemId, problemId));
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId,
      version: 2,
      packageHash: `pkg-${code}-v2`,
      state: 'published',
      createdBy: owner.id,
      timeMs: 1000,
      memoryKb: 256_000,
      testCount: 5,
      totalPoints,
      checkerKind: 'wcmp',
    })
    .returning();
  await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problemId));
  return revision!.id;
}

/**
 * Inserts a submission row directly, with an optional verdict — bypassing
 * `SubmissionAccessService.create` (and therefore its problem-visibility
 * check and its grading job), so a corpus can contain a graded submission on
 * a problem the seeder is not a member of.
 *
 * `points`/`maxPoints` are only ever written when `verdict` is also given,
 * and default to `null` unless the caller passes them explicitly — the
 * `me`-column "best verdict" fixtures (`problem-me-verdict.spec.ts`) need to
 * pin exact scores against a specific revision's total, not whatever value
 * would otherwise pass every OTHER test in this file that never asserts on
 * points at all. This deliberately does NOT mirror `event-writer.ts`'s
 * "points/maxPoints always set together" rule — `'CE'`/`'IE'` exist on this
 * union precisely so a caller can build the fixtures that DON'T set them
 * together (a real CE writes `points: 0` with no `maxPoints`; a real IE
 * writes neither), matching what `event-writer.ts` actually does for those
 * two verdicts. `state` follows the verdict the same way `event-writer.ts`
 * does: `'errored'` for `IE`, `'done'` for everything else.
 */
export async function insertGradedSubmission(
  db: Db,
  opts: {
    userId: number;
    problemId: number;
    revisionId?: number;
    verdict?: 'AC' | 'WA' | 'CE' | 'IE';
    points?: number;
    maxPoints?: number;
  },
): Promise<number> {
  const [language] = await db
    .select({ id: schema.languages.id })
    .from(schema.languages)
    .where(eq(schema.languages.key, 'cpp17'));
  let revisionId = opts.revisionId;
  if (revisionId === undefined) {
    const [problem] = await db
      .select({ currentRevisionId: problems.currentRevisionId })
      .from(problems)
      .where(eq(problems.id, opts.problemId));
    if (!problem?.currentRevisionId) throw new Error(`no published revision for problem ${opts.problemId}`);
    revisionId = problem.currentRevisionId;
  }
  const [row] = await db
    .insert(submissions)
    .values({
      userId: opts.userId,
      problemId: opts.problemId,
      revisionId,
      languageId: language!.id,
      source: `src-${opts.userId}-${opts.problemId}`,
      ...(opts.verdict
        ? {
            verdict: opts.verdict,
            state: opts.verdict === 'IE' ? ('errored' as const) : ('done' as const),
            points: opts.points,
            maxPoints: opts.maxPoints,
          }
        : {}),
    })
    .returning({ id: submissions.id });
  return row!.id;
}

/** The `users.id` for a username — every fixture below keys off it. */
export async function userIdOf(db: Db, username: string): Promise<number> {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username));
  if (!user) throw new Error(`no such user: ${username}`);
  return user.id;
}

/**
 * Clears D80's submission meter for every user.
 *
 * `POST /submissions` admits one submission per person per ten seconds. Some
 * tests here need one person to submit three, five or seven times in a row —
 * a pagination corpus, a list/read agreement set — and none of them is about
 * the meter. Waiting ten real seconds between posts would add a minute to the
 * suite to prove nothing; suppressing the limiter in the harness would hide it
 * from every test that does not opt out, which is the wrong default (a test
 * that submits repeatedly as one person is testing behaviour this meter
 * changes, and it should have to say so).
 *
 * So: an explicit line, at the point where the fiction is introduced. It
 * deletes the attempt rows and the D47 refusal markers together, since a
 * marker under a prefixed purpose is bookkeeping for the same key.
 */
export async function clearSubmissionMeter(db: Db): Promise<void> {
  await db
    .delete(schema.rateEvents)
    .where(sql`${schema.rateEvents.purpose} in ('submission', 'refused:submission')`);
}
