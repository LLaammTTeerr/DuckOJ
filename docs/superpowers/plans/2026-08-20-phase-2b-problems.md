# Phase 2b — Problems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a problem a managed entity — owned, permissioned, editable over HTTP, and browsable on the web — on top of Phase 2a's content-addressed packages.

**Architecture:** A `ProblemAccessService` owns every read and write of guarded problem tables, exactly as `OrgAccessService` and `SubmissionAccessService` do for their domains. One visibility predicate, in `apps/api/src/authz/problem.visibility.ts`, is shared by the problem read paths *and* by the existing submission-create path — the submission path's private copy is deleted, not left alongside. Package manifests are parsed once at revision-attach time and denormalised onto `problem_revisions`, so no page view ever unpacks an archive.

**Tech Stack:** NestJS 11, Drizzle ORM, PostgreSQL 16, Zod 4 contracts, React 19 + TanStack Router/Query, `marked` + `katex` + `dompurify` for statements, Vitest with Testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-20-phase-2b-problems-design.md`

## Global Constraints

Copied verbatim from the spec §3. Every task's requirements implicitly include this section.

1. **One visibility predicate, two consumers.** `SubmissionAccessService.create`'s inline check (`apps/api/src/authz/submission.access.ts:31`, `visibility !== 'public'`) must be *replaced* by the shared predicate, not shadowed by it. Task 8 owns this and is not optional.
2. **404 over 403 on reads.** A problem the actor may not see returns `problem_not_found`. On writes against a problem the actor *can* see, 403 `problem_forbidden` is correct.
3. **`ProblemAccessService` is the only *service* importing guarded problem tables** (`problems`, `problemRevisions`, `problemMembers`, `problemOrgs`). Two files are explicitly not violations: `apps/api/src/authz/problem.visibility.ts`, which the spec mandates hold these imports so the predicate and its loader live together; and `SubmissionAccessService`, which already owns `submissions` and reaches problems only through that predicate.
4. **Statements are Markdown**, stored raw, rendered client-side, and **sanitized** before insertion into the DOM.
5. **No new hardcoded API prefix.** Every URL derives from `@duckoj/api-prefix`.
6. **Every new workspace dependency of a Dockerised app updates that Dockerfile's COPY manifest**, and `apps/api/test/dockerfile-manifest.spec.ts` stays green.
7. **Every new test must be demonstrated to fail** against unfixed or deliberately-broken code. Report the observed failure message. Phase 2a shipped three tests that could not fail; all three were caught in review, not by the suite.
8. **`corepack pnpm -r typecheck`, `-r lint`, and `-r test` are all green before any commit.** Workspace packages resolve through `dist/`, so a `pretest` build hook is required on every package — do not remove one.

### Two hazards this project has already paid for

**A green suite proves nothing about integration.** Four bugs across Phases 1 and 2a were invisible to a fully green, growing test suite: a Caddy route, a Dockerfile COPY manifest, an archive-fetch URL missing `/api/v1`, and a stale-image silent reseed. Each was found by building an image or bringing the stack up. Task 13 exists for this and is not a formality.

**A hand-written `max(x) + 1` races.** Task 1 adds the unique index *before* Task 5 relies on the pattern. If you reorder these, you ship silent duplicate revision versions.

## File structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/db/migrations/0005_*.sql` | The migration of spec §2.2–2.3 |
| `apps/api/src/authz/problem.visibility.ts` | The one visibility predicate, both forms |
| `apps/api/src/authz/problem.access.ts` | `ProblemAccessService` — every guarded problem read/write |
| `apps/api/src/problems/problems.controller.ts` | HTTP surface for problems and revisions |
| `apps/api/src/problems/problems.module.ts` | Wiring |
| `apps/api/src/admin/admin-users.controller.ts` | The `setter` grant route |
| `packages/contracts/src/problems.ts` | Zod contracts and DTOs |
| `apps/web/src/routes/problems.tsx` | List |
| `apps/web/src/routes/problem.tsx` | Detail, rendered statement |
| `apps/web/src/routes/problem-edit.tsx` | Create and edit forms |
| `apps/web/src/routes/problem-revisions.tsx` | Attach and publish |
| `apps/web/src/markdown.ts` | `renderStatement()` — marked + katex + dompurify |
| `scripts/e2e-problem.ts` | Task 13's end-to-end script |

**Modified:** `packages/db/src/schema/guarded.ts` (new tables and columns) · `apps/api/src/authz/submission.access.ts` (Task 8) · `apps/api/src/authz/authz.module.ts` · `apps/api/src/app.module.ts` · `packages/contracts/src/{index,registry}.ts` · `apps/judged/src/*` (Task 9, `CE`) · `apps/web/src/main.tsx` (routes) · `apps/api/Dockerfile` (only if a new workspace dep appears) · `docs/runbook.md` · `README.md`

### A disclosed weakness in this plan

Tasks 3–6 all edit `apps/api/src/authz/problem.access.ts`. They are sequenced deliberately and must not be parallelised. Each adds methods without touching the previous task's, so review diffs stay small — but a reviewer should read the whole file at Task 6, not just that task's diff.

---

## Task 1: Schema and migration 0005

**Files:**
- Modify: `packages/db/src/schema/guarded.ts`
- Create: `packages/db/migrations/0005_*.sql` (generated, then read)
- Test: `packages/db/test/problems-schema.spec.ts`

**Interfaces:**
- Produces: `problemRole` (pgEnum), `problemMembers`, `problemOrgs` (pgTable); `problems.createdBy`; `problemRevisions.{createdBy,notes,timeMs,memoryKb,testCount,totalPoints,checkerKind}`; `caseVerdict` gains `'CE'`.
- Consumes: nothing.

- [ ] **Step 1: Add the enum and tables to `guarded.ts`**

Append after `problemRevisions`:

```ts
export const problemRole = pgEnum('problem_role', ['author', 'curator', 'tester']);

export const problemMembers = pgTable(
  'problem_members',
  {
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: problemRole('role').notNull(),
  },
  // `role` is in the key on purpose: DMOJ's separate authors/curators
  // relations let one person hold both, and a (problem, user) key would
  // force the deferred importer to discard one of them.
  (t) => [primaryKey({ columns: [t.problemId, t.userId, t.role] })],
);

export const problemOrgs = pgTable(
  'problem_orgs',
  {
    problemId: bigint('problem_id', { mode: 'number' })
      .notNull()
      .references(() => problems.id, { onDelete: 'cascade' }),
    orgId: bigint('org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.problemId, t.orgId] })],
);
```

- [ ] **Step 2: Extend `problems` and `problemRevisions`**

In `problems`, add before `createdAt`:

```ts
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
```

In `problemRevisions`, add before `createdAt`:

```ts
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    notes: text('notes'),
    /** Denormalised from the package manifest at attach time — see spec §5.1. */
    timeMs: integer('time_ms').notNull(),
    memoryKb: integer('memory_kb').notNull(),
    testCount: integer('test_count').notNull(),
    totalPoints: doublePrecision('total_points').notNull(),
    checkerKind: text('checker_kind').notNull(),
```

and give the table its constraint callback (it currently has none):

```ts
  (t) => [uniqueIndex('problem_revisions_version_idx').on(t.problemId, t.version)],
```

- [ ] **Step 3: Add `CE` to `caseVerdict`**

```ts
export const caseVerdict = pgEnum('case_verdict', [
  'AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'IR', 'CE', 'IE',
]);
```

`CE` is placed before `IE` so the enum reads worst-case-last; ordering has no
semantic meaning here because nothing compares these values.

- [ ] **Step 4: Generate the migration, then READ IT**

```bash
cd packages/db && corepack pnpm exec drizzle-kit generate
```

**This is the step the spec §10 warns about.** Open the generated SQL. It must
contain `ALTER TYPE "public"."case_verdict" ADD VALUE 'CE';`. If instead it
drops and recreates the type, **hand-write the migration** — a drop fails
against columns already using the type, and no amount of retrying the
generator will change its mind. Existing tables must not be recreated.

Also verify the two `NOT NULL` columns added to non-empty tables. `problems`
and `problem_revisions` may already hold rows from `seed-problem.ts`. If the
generated SQL adds `created_by bigint NOT NULL` with no default, it will fail
against any populated database. Resolve by adding the column nullable,
backfilling to the first admin user, then setting `NOT NULL` — write those
three statements by hand in the migration.

- [ ] **Step 5: Write the schema test**

`packages/db/test/problems-schema.spec.ts`, using the existing `withTestDb`
helper (see `packages/db/test/orgs.spec.ts` for the shape):

```ts
it('permits one user to hold two roles on the same problem', async () => {
  await withTestDb(async (db) => {
    const [user] = await db.insert(schema.users).values({
      username: 'dana', email: 'dana@example.com', passwordHash: 'x', displayName: 'Dana',
    }).returning();
    const [problem] = await db.insert(problems).values({
      code: 'p1', name: 'P1', statement: 's', createdBy: user!.id,
    }).returning();
    await db.insert(problemMembers).values([
      { problemId: problem!.id, userId: user!.id, role: 'author' },
      { problemId: problem!.id, userId: user!.id, role: 'curator' },
    ]);
    const rows = await db.select().from(problemMembers)
      .where(eq(problemMembers.problemId, problem!.id));
    expect(rows).toHaveLength(2);
  });
}, 120_000);

it('rejects a duplicate (problem, version)', async () => { /* expect(...).rejects.toThrow() */ }, 120_000);

it('accepts CE as a case verdict', async () => { /* insert a submission with verdict: 'CE' */ }, 120_000);
```

The first test is the one that proves the composite key includes `role` — it
fails with a duplicate-key error if someone "simplifies" the key later.

- [ ] **Step 6: Run the migration against real PostgreSQL and run the tests**

```bash
corepack pnpm --filter @duckoj/db test
```

Expected: all pass. If `ALTER TYPE … ADD VALUE` errors, that is the risk of
spec §10 materialising — report it and stop rather than working around it.

- [ ] **Step 7: Commit**

```bash
git add packages/db && git commit -m "feat(db): problem members, orgs, revision metadata, CE verdict"
```

---

## Task 2: The visibility predicate

**Files:**
- Create: `apps/api/src/authz/problem.visibility.ts`
- Test: `apps/api/test/problem-visibility.spec.ts`

**Interfaces:**
- Consumes: `Actor`, `isAdmin` from `./actor.js`; tables from Task 1.
- Produces: `visibleProblemsWhere(db, actor)`, `canViewProblem(actor, problem, ctx)`, `canEditProblem(actor, ctx)`, `canCreateProblem(actor)`, `loadProblemContext(db, actor, problemId)`, `type ProblemViewContext`, `type ProblemRole`.

**`loadProblemContext` lives here, not in the service.** Task 8 must call it
without depending on `ProblemAccessService`, and a second loader written later
for the submission path is exactly the duplication Global Constraint 1 exists
to prevent. Its two queries are given in Task 3 Step 3 — implement them in
this file now; this task's own suite covers only the pure predicates, and
Task 3's database tests exercise the loader.

- [ ] **Step 1: Write the failing test first**

`apps/api/test/problem-visibility.spec.ts`. `canViewProblem` is a pure
function, so this suite needs no database:

```ts
const ANON = null;
const user = (id: number): Actor => ({ userId: id, globalRole: 'user', via: 'session', scopes: [] });
const admin = (id: number): Actor => ({ ...user(id), globalRole: 'admin' });
const ctx = (over: Partial<ProblemViewContext> = {}): ProblemViewContext =>
  ({ memberRoles: [], sharedOrgIds: [], actorOrgIds: [], ...over });

// One case per cell of spec §2.4.
const CASES: Array<[string, Actor | null, ProblemVisibility, ProblemViewContext, boolean]> = [
  ['anon sees public',            ANON,     'public',  ctx(), true],
  ['anon cannot see org',         ANON,     'org',     ctx(), false],
  ['anon cannot see private',     ANON,     'private', ctx(), false],
  ['user sees public',            user(1),  'public',  ctx(), true],
  ['user cannot see org',         user(1),  'org',     ctx(), false],
  ['user cannot see private',     user(1),  'private', ctx(), false],
  ['org member sees org',         user(1),  'org',     ctx({ sharedOrgIds: [7], actorOrgIds: [7] }), true],
  ['org member cannot see private', user(1), 'private', ctx({ sharedOrgIds: [7], actorOrgIds: [7] }), false],
  ['non-shared org member cannot see org', user(1), 'org', ctx({ sharedOrgIds: [7], actorOrgIds: [8] }), false],
  ['tester sees private',         user(1),  'private', ctx({ memberRoles: ['tester'] }), true],
  ['author sees private',         user(1),  'private', ctx({ memberRoles: ['author'] }), true],
  ['curator sees private',        user(1),  'private', ctx({ memberRoles: ['curator'] }), true],
  ['admin sees private',          admin(9), 'private', ctx(), true],
];

it.each(CASES)('%s', (_name, actor, visibility, context, expected) => {
  expect(canViewProblem(actor, { id: 1, visibility }, context)).toBe(expected);
});
```

Plus edit rights:

```ts
it('lets an author edit', () => expect(canEditProblem(user(1), ctx({ memberRoles: ['author'] }))).toBe(true));
it('lets a curator edit', () => expect(canEditProblem(user(1), ctx({ memberRoles: ['curator'] }))).toBe(true));
it('does NOT let a tester edit', () => expect(canEditProblem(user(1), ctx({ memberRoles: ['tester'] }))).toBe(false));
it('lets an admin edit', () => expect(canEditProblem(admin(9), ctx())).toBe(true));
it('denies a setter who is not a member', () =>
  expect(canEditProblem({ ...user(1), globalRole: 'setter' }, ctx())).toBe(false));
```

The last one matters: `setter` grants the right to *create* problems, never
the right to edit someone else's.

- [ ] **Step 2: Run it and watch it fail**

```bash
corepack pnpm --filter @duckoj/api test problem-visibility
```

Expected: `Cannot find module './problem.visibility.js'`.

- [ ] **Step 3: Implement**

```ts
import { and, eq, exists, inArray, or, sql, type SQL } from 'drizzle-orm';
import { organizations, orgMembers, problemMembers, problemOrgs, problems } from '@duckoj/db/guarded';
import type { Db } from '@duckoj/db';
import { isAdmin, type Actor } from './actor.js';

export type ProblemVisibility = 'private' | 'org' | 'public';
export type ProblemRole = 'author' | 'curator' | 'tester';

export interface ProblemViewContext {
  /** The actor's roles ON THIS PROBLEM. Empty for a non-member. */
  memberRoles: ProblemRole[];
  /** Organizations this problem is shared with. */
  sharedOrgIds: number[];
  /** Organizations the actor belongs to. */
  actorOrgIds: number[];
}

export function canViewProblem(
  actor: Actor | null,
  problem: { id: number; visibility: ProblemVisibility },
  ctx: ProblemViewContext,
): boolean {
  if (isAdmin(actor)) return true;
  // Membership outranks visibility: a tester exists precisely so a private
  // problem can be proofread before it is public.
  if (actor && ctx.memberRoles.length > 0) return true;
  if (problem.visibility === 'public') return true;
  if (problem.visibility === 'org' && actor) {
    return ctx.sharedOrgIds.some((id) => ctx.actorOrgIds.includes(id));
  }
  return false;
}

export function canEditProblem(actor: Actor | null, ctx: ProblemViewContext): boolean {
  if (isAdmin(actor)) return true;
  if (!actor) return false;
  return ctx.memberRoles.includes('author') || ctx.memberRoles.includes('curator');
}

export function canCreateProblem(actor: Actor | null): boolean {
  return actor?.globalRole === 'setter' || isAdmin(actor);
}

/**
 * The list-query form of `canViewProblem`. Kept in the same file as the
 * row-wise form on purpose: the two must agree, and agreement is easier to
 * audit when they are eight lines apart than when they live in two services.
 */
export function visibleProblemsWhere(db: Db, actor: Actor | null): SQL {
  if (isAdmin(actor)) return sql`true`;
  if (!actor) return eq(problems.visibility, 'public');

  const memberOf = db
    .select({ problemId: problemMembers.problemId })
    .from(problemMembers)
    .where(eq(problemMembers.userId, actor.userId));

  const sharedWithMyOrgs = db
    .select({ problemId: problemOrgs.problemId })
    .from(problemOrgs)
    .innerJoin(orgMembers, eq(orgMembers.orgId, problemOrgs.orgId))
    .where(eq(orgMembers.userId, actor.userId));

  return or(
    eq(problems.visibility, 'public'),
    inArray(problems.id, memberOf),
    and(eq(problems.visibility, 'org'), inArray(problems.id, sharedWithMyOrgs)),
  )!;
}
```

- [ ] **Step 4: Run the tests**

Expected: all pass.

- [ ] **Step 5: Prove the suite discriminates**

Temporarily make `canViewProblem`'s org branch unconditionally `return true`
— **including dropping its `&& actor` guard**. Re-run. Expect `anon cannot see
org`, `user cannot see org`, and `non-shared org member cannot see org` to
fail. Changing only the inner return leaves the `&& actor` guard standing and
produces two failures, not three; if you see two, you have not broken enough.
Revert. **Report the observed failures** —
a matrix test that passes under a broken predicate is worthless, and this
project has shipped three such tests before.

- [ ] **Step 6: Commit**

---

## Task 3: `ProblemAccessService` — reads

**Files:**
- Create: `apps/api/src/authz/problem.access.ts`
- Modify: `apps/api/src/authz/authz.module.ts`
- Test: `apps/api/test/problem-reads.spec.ts`

**Interfaces:**
- Consumes: Task 2's exports; `PaginationQueryDto`.
- Produces: `ProblemAccessService` with `listVisible(actor, page, q?)` and `getVisible(actor, code)`. The per-problem context comes from Task 2's `loadProblemContext`; this service does not define its own.

- [ ] **Step 1: Write the failing tests**

Against a real database (`withTestDb`-equivalent used by `apps/api/test`; copy
the harness from `apps/api/test/submissions.fixtures.ts`). Cases:

```
lists a public problem to an anonymous caller
hides an org problem from a non-member
shows an org problem to a member of a shared org
shows a private problem to its tester
returns 404 problem_not_found for a private problem the actor cannot see
paginates: 3 problems, limit 2, follow nextCursor, get the third
filters by q against both code and name, case-insensitively
reports hasPublishedRevision false and null limits for a draft-only problem
```

The seventh is the one people forget. Assert that `q: 'PLUS'` matches a
problem named `A plus B` **and** that `q: 'apl'` matches code `aplusb`.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement the two reads**

`loadProblemContext` belongs to Task 2's file. Its body is given here because
this is the task whose tests first exercise it — everything Task 2's
predicates need about one actor/problem pair, in two queries, called on every
single-problem path so authorization never depends on which handler the
request arrived through:

```ts
export async function loadProblemContext(
  db: Db, actor: Actor | null, problemId: number,
): Promise<ProblemViewContext> {
  if (!actor) return { memberRoles: [], sharedOrgIds: [], actorOrgIds: [] };
  const [roles, orgs] = await Promise.all([
    db.select({ role: problemMembers.role }).from(problemMembers)
      .where(and(eq(problemMembers.problemId, problemId), eq(problemMembers.userId, actor.userId))),
    db.select({ shared: problemOrgs.orgId, mine: orgMembers.orgId })
      .from(problemOrgs)
      .leftJoin(orgMembers, and(eq(orgMembers.orgId, problemOrgs.orgId), eq(orgMembers.userId, actor.userId)))
      .where(eq(problemOrgs.problemId, problemId)),
  ]);
  return {
    memberRoles: roles.map((r) => r.role),
    sharedOrgIds: orgs.map((o) => o.shared),
    actorOrgIds: orgs.filter((o) => o.mine !== null).map((o) => o.mine!),
  };
}
```

`listVisible` follows `OrgAccessService.listVisible` exactly — keyset on
`problems.id`, `limit + 1` rows, `nextCursor` from the last kept item — with
`visibleProblemsWhere(this.db, actor)` as the visibility term, plus, when `q`
is present:

```ts
or(
  sql`lower(${problems.code}) like ${'%' + q.toLowerCase() + '%'}`,
  sql`lower(${problems.name}) like ${'%' + q.toLowerCase() + '%'}`,
)
```

`q` must be escaped for `%` and `_` before interpolation, or a user searching
for `100%` gets every problem. Write a tiny `likeEscape()` beside it and test
it: `likeEscape('100%') === '100\\%'`.

Limits come from a `leftJoin` on `problemRevisions` at
`problems.currentRevisionId`; a null join yields `timeMs: null`,
`memoryKb: null`, `hasPublishedRevision: false`.

`getVisible` loads the problem by `lower(code) = lower(:code)`, builds its
context with `loadProblemContext`, and throws `new AppError(404, 'problem_not_found', 'No such problem.')`
when `canViewProblem` is false — the same 404 for "absent" and "invisible".

- [ ] **Step 4: Register in `AuthzModule`** (providers + exports).

- [ ] **Step 5: Run tests; prove one discriminates**

Break `getVisible` to skip the `canViewProblem` check. Expect the
`404 problem_not_found` case to fail. Revert and report.

- [ ] **Step 6: Commit**

---

## Task 4: `ProblemAccessService` — create and update

**Files:**
- Modify: `apps/api/src/authz/problem.access.ts`
- Test: `apps/api/test/problem-writes.spec.ts`

**Interfaces:**
- Produces: `create(actor, body)`, `update(actor, code, patch)`.

- [ ] **Step 1: Write the failing tests**

```
a setter creates a problem and is inserted as its author
a plain user creating a problem gets 403 problem_forbidden
a duplicate code (differing only in case) gets 409 problem_code_taken
an author patches the name
a tester patching gets 403 problem_forbidden
a members replacement removing the last author gets 400 problem_last_author
a members entry naming no user gets 400 problem_member_unknown
visibility 'org' with empty orgSlugs gets 400 problem_org_required
a patch containing `code` gets 400 problem_code_immutable
members and orgSlugs replace the whole set, not merge
```

The last one needs an explicit assertion: seed two members, PATCH with one,
read back exactly one.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

`create` runs one transaction: insert the problem with `createdBy: actor.userId`,
insert `problemMembers` `{ role: 'author', userId: actor.userId }`, insert any
`problemOrgs`. Catch the unique-violation on `problems_code_lower_idx` and
rethrow as `AppError(409, 'problem_code_taken', …)`; do not pre-check with a
SELECT, which races.

`update` loads the problem, builds its context with `loadProblemContext`, and — in this order —

1. `canViewProblem` false → 404 (never disclose existence),
2. `canEditProblem` false → 403,
3. validate the patch,
4. apply in one transaction, deleting and re-inserting `problemMembers` and
   `problemOrgs` wholesale when those keys are present.

Order matters and is testable: an invisible problem must 404 even for a
malformed patch, or the error code becomes an existence oracle.

Resolve `orgSlugs` and member usernames to ids *before* the transaction and
fail on the first unknown one, so a bad request never half-applies.

- [ ] **Step 4: Run tests; prove the ordering test discriminates**

Swap steps 1 and 2 so the 403 fires first. Expect the "invisible problem
returns 404 even with a bad patch" case to fail. Revert and report.

- [ ] **Step 5: Commit**

---

## Task 5: Attaching a package as a revision

**Files:**
- Modify: `apps/api/src/authz/problem.access.ts`
- Modify: `apps/api/src/packages/package.store.ts` (only if a read helper is missing)
- Test: `apps/api/test/problem-revisions.spec.ts`

**Interfaces:**
- Consumes: `PackageStore.get(hash): Promise<Buffer>` (**not** `read` — it does not exist), `parseManifest` from `@duckoj/package-format`, and the `packageFiles` table.
- Produces: `readArchiveEntry` in `@duckoj/package-format` (Step 0); `attachRevision(actor, code, { packageHash, notes })` → `{ version }`.

**Read this before writing any code.** The obvious implementation — "unpack
the archive in memory and inspect it" — does not typecheck against the real
API, and a pre-flight scan caught it in this plan's own first draft:

- `unpackArchive(archive: Buffer, destDir: string): Promise<void>` **writes to
  disk and returns nothing.** It cannot hand you file contents.
- `PackageStore` exposes `has`, `put`, `get`, `delete`. There is no `read`.

So this task takes two different routes for its two needs:

- **Path collisions come from the database, not the archive.** Phase 2a
  already stores one `package_files` row per file per hash. Query it. No
  unpack, no temp directory, and the check runs against the same list the
  hash was computed over.
- **The manifest comes from a new, narrow archive reader** (Step 0), because
  its *contents* are genuinely not in the database.

- [ ] **Step 0: Add `readArchiveEntry` to `@duckoj/package-format`**

```ts
/** Returns the bytes of one entry, or null if the archive has no such path. */
export async function readArchiveEntry(archive: Buffer, path: string): Promise<Buffer | null>;
```

Implement it beside `unpackArchive` with tar's parser and an in-memory
collector, resolving on the parser's `end` event. **Do not write
`await parse(...).end(bytes)`** — `end()` returns the stream, not a promise,
so awaiting it awaits nothing. That exact bug shipped in `unpackArchive` in
Phase 2a and was caught only in review; the fix there wraps the parser in a
`new Promise` that resolves on `'end'`. Copy that shape.

Test it: an archive containing `manifest.json` returns its bytes; a missing
path returns `null`; a 500-file archive still returns the right entry (the
Phase 2a reviewer's reproduction — a truncating implementation passes on
small fixtures and fails here).

- [ ] **Step 1: Write the failing tests**

```
attaching a valid package creates a draft revision at version 1
a second attach creates version 2
the revision records timeMs, memoryKb, testCount, totalPoints and checkerKind from the manifest
an unknown hash gets 404 package_not_found
an archive with no manifest.json gets 400 package_invalid
an archive whose paths collide case-insensitively gets 400 package_path_collision
an archive whose paths collide under NFC gets 400 package_path_collision
a tester attaching gets 403 problem_forbidden
a concurrent double attach yields versions 1 and 2, never two 1s
```

The NFC case needs a real fixture: two files named `café.txt` (NFC) and
`café.txt` (NFD). They are distinct byte sequences and distinct hashes,
and they collide on macOS. Build the fixture with explicit escapes, not by
typing the character, or your editor will normalise it and the test will
silently pass for the wrong reason.

The concurrency case runs two `attachRevision` calls with `Promise.all` and
asserts the resulting version set is exactly `{1, 2}`.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

```ts
async attachRevision(actor: Actor, code: string, input: { packageHash: string; notes?: string }) {
  const { problem, ctx } = await this.loadForEdit(actor, code);   // 404 then 403, as Task 4

  // The `packages` row is the authority on existence; the store is where the
  // bytes live. Check the row, because a hash with no row is `package_not_found`
  // even if orphaned bytes happen to survive in the store.
  const paths = await this.db.select({ path: packageFiles.path })
    .from(packageFiles).where(eq(packageFiles.packageHash, input.packageHash));
  if (paths.length === 0) {
    throw new AppError(404, 'package_not_found', 'No such package.');
  }
  assertNoPathCollisions(paths);                                   // Step 4

  const entry = await readArchiveEntry(await this.store.get(input.packageHash), 'manifest.json');
  if (!entry) throw new AppError(400, 'package_invalid', 'Package has no manifest.json.');
  let manifest;
  try {
    manifest = parseManifest(JSON.parse(entry.toString('utf8')));
  } catch (e) {
    throw new AppError(400, 'package_invalid', (e as Error).message);
  }

  // Read-then-insert races; the unique index of Task 1 turns that race into a
  // constraint violation. Retry rather than surfacing a 500 — the second
  // attempt reads the winner's version and succeeds.
  //
  // Use `onConflictDoNothing().returning()` and retry on an EMPTY result. Do
  // NOT catch the unique-violation error instead: inside a transaction, a
  // constraint violation aborts the whole transaction, so every later
  // statement — including the retry's own `max(version)` read — fails with
  // `25P02 current transaction is aborted`. The test harness wraps each case
  // in one transaction, so the catch-based version fails there even though it
  // would appear to work in production. `onConflictDoNothing` never raises,
  // so it works in both.
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = (await this.maxVersion(problem.id)) + 1;
    {
      await this.db.insert(problemRevisions).onConflictDoNothing().returning().values({
        problemId: problem.id, version: next, packageHash: input.packageHash,
        state: 'draft', createdBy: actor.userId, notes: input.notes ?? null,
        timeMs: manifest.limits.timeMs, memoryKb: manifest.limits.memoryKb,
        testCount: manifest.tests.length,
        totalPoints: manifest.tests.reduce((s, t) => s + t.points, 0),
        checkerKind: manifest.checker.kind,
      });
      return { version: next };
    } catch (e) {
    }
  }
  throw new AppError(409, 'revision_conflict', 'Too many concurrent attaches.');
}
```

- [ ] **Step 4: Implement `assertNoPathCollisions`**

```ts
function assertNoPathCollisions(files: Array<{ path: string }>): void {
  const seen = new Map<string, string>();
  for (const f of files) {
    // Two independent collapses. A judge on a case-insensitive filesystem
    // loses the first of a case pair; HFS+/APFS normalise to NFD, losing the
    // first of a normalisation pair. Either way the materialised directory
    // re-hashes to something other than the stored hash.
    const key = f.path.normalize('NFC').toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined && prior !== f.path) {
      throw new AppError(400, 'package_path_collision',
        `Paths "${prior}" and "${f.path}" collide on a case-insensitive or normalising filesystem.`);
    }
    seen.set(key, f.path);
  }
}
```

- [ ] **Step 5: Wire `PackageStore` into `ProblemAccessService`**

The service now needs the store in its constructor. `PackageStore` is
provided by `PackagesModule` (see `apps/api/src/packages/packages.module.ts`);
`AuthzModule` must import it, or the provider must be moved somewhere both
can reach. **Check for a circular import** — if `PackagesModule` imports
`AuthzModule`, use `forwardRef` or lift the store provider into a shared
module, and say in the report which you did and why.

- [ ] **Step 6: Run tests; prove the collision test discriminates**

Remove the `assertNoPathCollisions` call. Expect both collision cases to fail
with "expected 400, got 201". Revert and report.

Seed the store blob and the `packages`/`package_files` rows **directly**.
Do not try to build the fixture by uploading: `POST /packages` already
rejects a colliding or manifest-less package, so upload cannot produce the
state this check is supposed to catch. The check reads the database, not the
archive. Write the two names with explicit escapes
(`'café.txt'` and `'café.txt'`), never by typing the character:
an editor that normalises on save makes the test pass for the wrong reason.

- [ ] **Step 7: Commit**

---

## Task 6: Publishing

**Files:**
- Modify: `apps/api/src/authz/problem.access.ts`
- Test: `apps/api/test/problem-publish.spec.ts`

**Interfaces:**
- Produces: `publishRevision(actor, code, version)` → `{ version }`, `listRevisions(actor, code)`.

- [ ] **Step 1: Write the failing tests**

```
publishing a draft sets it published and points current_revision_id at it
publishing a second revision archives the first
a submission made against the archived revision still reads back its own revision
publishing an already-published revision is a 200 no-op
publishing an archived revision rolls back to it
an unknown version gets 404 revision_not_found
a tester publishing gets 403 problem_forbidden
listRevisions is 404 for a plain user, and lists drafts for a tester
```

The third is the one that justifies archiving at all. Create a submission
against revision 1, publish revision 2, then read the submission and assert
its `revisionId` is still revision 1's.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

```ts
return this.db.transaction(async (tx) => {
  const target = /* select by (problemId, version), else 404 revision_not_found */;
  if (target.state !== 'published') {
    await tx.update(problemRevisions)
      .set({ state: 'archived' })
      .where(and(eq(problemRevisions.problemId, problem.id), eq(problemRevisions.state, 'published')));
    await tx.update(problemRevisions).set({ state: 'published' }).where(eq(problemRevisions.id, target.id));
  }
  await tx.update(problems).set({ currentRevisionId: target.id }).where(eq(problems.id, problem.id));
  return { version };
});
```

Archiving is safe because `submissions.revisionId` pins the revision that
graded each submission; the archived row stays referenced and readable
forever. Setting `currentRevisionId` unconditionally makes the
already-published case an idempotent no-op rather than a special branch.

- [ ] **Step 4: Run tests; prove one discriminates**

Delete the archive-previous `update`. Expect "publishing a second revision
archives the first" to fail. Revert and report.

- [ ] **Step 5: Commit**

---

## Task 7: Contracts, controller, and the `/api/v1` fix

**Files:**
- Create: `packages/contracts/src/problems.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/registry.ts`
- Create: `apps/api/src/problems/problems.controller.ts`, `problems.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `packages/contracts/test/route-coverage.spec.ts`
- Test: `apps/api/test/problems-http.spec.ts`, `packages/contracts/test/registry.spec.ts`

**This is the largest task in the phase** — contracts, controller, the eleven
unregistered legacy routes, a drift test, and a served docs viewer. If it
proves unwieldy, split at Step 5: Steps 1-4 and 8 are the problems surface,
Steps 5-7 are the OpenAPI debt. The drift test (Step 6) is the piece worth
keeping under any split, because it is what stops the gap reopening.

**Interfaces:**
- Produces: `CreateProblemRequest`, `UpdateProblemRequest`, `AttachRevisionRequest`, `ProblemListQuery`, `ProblemSummary`, `ProblemDetail`, `RevisionSummary` and their DTO types.

- [ ] **Step 1: Write the contracts**

```ts
export const PROBLEM_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const ProblemVisibility = z.enum(['private', 'org', 'public']);
export const ProblemRole = z.enum(['author', 'curator', 'tester']);
export const ProblemMember = z.object({ username: z.string().min(1), role: ProblemRole });

export const CreateProblemRequest = z.object({
  code: z.string().regex(PROBLEM_CODE),
  name: z.string().min(1).max(200),
  // 256 KiB: far above any real statement, far below anything that hurts.
  statement: z.string().max(262_144),
  visibility: ProblemVisibility.default('private'),
  orgSlugs: z.array(z.string()).default([]),
});

export const UpdateProblemRequest = z
  .object({
    name: z.string().min(1).max(200).optional(),
    statement: z.string().max(262_144).optional(),
    visibility: ProblemVisibility.optional(),
    orgSlugs: z.array(z.string()).optional(),
    members: z.array(ProblemMember).optional(),
  })
  // Rejecting an unknown key is what turns "code is immutable" from a comment
  // into a rule: a PATCH carrying `code` fails loudly instead of silently
  // renaming nothing.
  .strict();

export const ProblemListQuery = PaginationQuery.extend({ q: z.string().max(100).optional() });
export const AttachRevisionRequest = z.object({
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  notes: z.string().max(4096).optional(),
});
```

`UpdateProblemRequest.strict()` makes a stray `code` a 400 from the validation
pipe. Confirm the resulting error code is `problem_code_immutable` or map it
in the controller — the spec names that code and a test asserts it.

- [ ] **Step 2: Fix `registry.ts:9`**

Replace the hardcoded `'/api/v1'` with `API_PREFIX` imported from
`@duckoj/api-prefix`. Add `@duckoj/api-prefix` to `packages/contracts`'s
dependencies **and to the COPY manifest of every Dockerfile that builds
contracts** — `dockerfile-manifest.spec.ts` will fail otherwise, which is the
point of that test.

Add to `packages/contracts/test/registry.spec.ts`:

```ts
it('derives the OpenAPI server URL from API_PREFIX, not a literal', () => {
  expect(registry.servers[0].url).toBe(API_PREFIX);
});
```

Comparing against the imported constant rather than the string `'/api/v1'` is
deliberate: Phase 2a shipped an assertion comparing two hardcoded literals,
which could not fail.

- [ ] **Step 3: Write the controller**

Follow `orgs.controller.ts` exactly: `@Public()` per handler on the two read
routes, `@MaybeActor()` there, `@CurrentActor()` on writes, `ZodValidationPipe`
on every body and query, and **no authorization logic in the controller** —
every method is a one-line delegation to `ProblemAccessService`.

- [ ] **Step 4: Write the HTTP tests**

Over real HTTP with `supertest`, following `apps/api/test/orgs.spec.ts`:

```
GET /problems is 200 for an anonymous caller and lists only public problems
GET /problems/:code is 404 for a private problem, anonymously
POST /problems is 401 without credentials
POST /problems is 403 for a plain user
POST /problems is 201 for a setter
PATCH with an unknown field is 400 problem_code_immutable
the OpenAPI document lists every problem route under API_PREFIX
```

- [ ] **Step 5: Backfill the eleven unregistered routes**

The contracts registry documents **7 of 18** live non-internal routes. These
eleven exist in Nest controllers and appear nowhere in `openapi.json`, which
also means they are absent from the generated SDK:

```
POST   /auth/register        POST   /auth/tokens
POST   /auth/logout          GET    /auth/tokens
POST   /auth/totp/begin      DELETE /auth/tokens/{id}
POST   /auth/totp/confirm    DELETE /auth/totp
GET    /orgs/{slug}          GET    /healthz
                             GET    /readyz
```

Register each against the schemas its controller already validates with. Do
not invent new shapes — every one of these has a Zod contract already, or
takes no body.

- [ ] **Step 6: Add the drift test that stops this recurring**

`packages/contracts/test/route-coverage.spec.ts`. Registering a route in a
Nest controller and registering it in the contracts registry are two
independent acts, and nothing has ever enforced that they agree — which is
exactly how the count reached 7 of 18 silently.

Parse `apps/api/src/**/*.controller.ts` for `@Controller` prefixes and
`@Get`/`@Post`/`@Patch`/`@Delete` paths, convert `:param` to `{param}`,
exclude anything under an `internal/` controller, and assert the resulting
set equals the document's paths. Model it on
`apps/api/test/dockerfile-manifest.spec.ts`, which does the same job for
Dockerfile COPY lines and has already caught a real break.

**Prove it discriminates:** delete one registration, confirm the test names
the missing route, restore.

- [ ] **Step 7: Serve the document and a viewer**

`GET /openapi.json` returning `openApiDocument()`, and `GET /docs` rendering
it. Both `@Public()`.

Serve the viewer's assets **from the API**, not a CDN — the compose stack has
no guarantee of outbound network, and a docs page that silently fails to load
offline is worse than none. Scalar's standalone bundle or Redoc's are both
single files; vendor one.

Serving the document from the running API rather than shipping the committed
`openapi.json` is the point: the file on disk can drift from the build, and
the endpoint cannot.

**Add a Caddy route for `/docs` and `/openapi.json` if the current config
does not already proxy them.** A route that works locally and 404s behind
Caddy is this project's single most repeated integration bug — Phase 1's
`/ws` and Phase 2a's archive-fetch URL were both exactly this. Task 13 checks
it against the live stack.

- [ ] **Step 8: Register the module, run all gates, commit**

---

## Task 8: Delete the submission path's private visibility check

**Files:**
- Modify: `apps/api/src/authz/submission.access.ts`
- Test: `apps/api/test/submission-problem-visibility.spec.ts`

**Interfaces:**
- Consumes: Task 2's `canViewProblem` and `loadProblemContext`, both already
  exported from `problem.visibility.ts`. `SubmissionAccessService` must NOT
  depend on `ProblemAccessService` — the shared thing is the predicate module,
  not the service.

**This task is the reason the phase has a Global Constraint about it.** It is
not cleanup. Skipping it ships a problem an org member can see in the list and
cannot submit to.

- [ ] **Step 1: Write the failing test FIRST, and name it for its purpose**

`apps/api/test/submission-problem-visibility.spec.ts`:

```ts
// This suite exists to fail if anyone reintroduces a second visibility
// implementation in the submission path. It is not about submissions.
describe('submission create honours problem visibility', () => {
  it('accepts a submission from a member of an org the problem is shared with', async () => {
    // org O, user U in O, problem P visibility 'org' shared with O, published revision
    // expect POST /submissions -> 201
  });
  it('rejects a submission to an org problem from a non-member', async () => {
    // expect 404 problem_not_found
  });
  it('accepts a submission from a tester of a private problem', async () => {
    // expect 201
  });
  it('rejects a submission to a private problem from a stranger', async () => {
    // expect 404 problem_not_found
  });
});
```

- [ ] **Step 2: Run it against the CURRENT code and record the failures**

Expected: cases 1 and 3 fail with 404, because `submission.access.ts:31` reads
`problem.visibility !== 'public'`. **Paste the actual failure output into the
task report.** That output is the evidence this task was needed.

- [ ] **Step 3: Replace the inline check**

Delete this, including its now-wrong comment:

```ts
if (!problem?.currentRevisionId || (problem.visibility !== 'public' && !isAdmin(actor))) {
```

Replace with a `canViewProblem` call over `loadProblemContext`. Keep the
`currentRevisionId` half — "no published revision" is a separate condition
from "not visible", and both still answer `problem_not_found` so neither
becomes an existence oracle.

- [ ] **Step 4: Re-run both this suite and the full `apps/api` suite**

The existing submission tests must stay green. If one breaks, it was asserting
the old behaviour and needs its expectation corrected, not the code reverted —
say so explicitly in the report rather than quietly editing a test.

- [ ] **Step 5: Grep for a third copy**

```bash
git grep -n "visibility" -- apps/api/src | grep -v problem.visibility.ts
```

Expect hits only in org code. Any problem-visibility comparison outside
`problem.visibility.ts` is a violation of Global Constraint 1 — fix it here.

- [ ] **Step 6: Commit**

---

## Task 9: `CE` end to end

**Files:**
- Modify: `apps/judged/src/` (the file mapping DMOJ results to verdicts — find
  it with `git grep -n "'IE'" -- apps/judged/src`)
- Test: extend the existing driver/event-writer suite

**Interfaces:**
- Consumes: Task 1's enum member.
- Produces: a compile failure recorded as `CE`, not `IE`.

- [ ] **Step 1: Find the current mapping and read it**

Phase 1 recorded this as "a compile error is reported as verdict `IE` because
`case_verdict` has no `CE` member". Confirm that is still literally what the
code does before changing anything — the ledger entry is a year of
assumptions old by codebase standards.

- [ ] **Step 2: Write the failing test**

Drive the existing DMOJ fake driver to emit a compile-error packet and assert
the submission's `verdict` is `'CE'` and its `compileOutput` is non-empty.
Expected failure: `expected 'CE', received 'IE'`.

- [ ] **Step 3: Implement the mapping**

Only the compile-error path changes. A genuine internal error must still be
`IE` — add an assertion for that in the same suite so the two do not merge.

- [ ] **Step 4: Run `apps/judged` and `apps/api` suites; commit**

---

## Task 10: Granting the `setter` role

**Files:**
- Create: `apps/api/src/admin/admin-users.controller.ts`, `admin.module.ts`
- Modify: `apps/api/src/app.module.ts`, `packages/contracts/src/index.ts`
- Test: `apps/api/test/admin-users.spec.ts`

**Interfaces:**
- Produces: `PATCH /admin/users/:username` with body `{ globalRole }`.

- [ ] **Step 1: Write the failing tests**

```
an admin grants setter and the target can then create a problem
a non-admin gets 403
a setter cannot grant themselves admin
an unknown username gets 404 user_not_found
granting a role the enum does not contain is 400
```

The first is an integration test on purpose: grant, then actually
`POST /problems` as the newly-promoted user and expect 201. A test that only
asserts the column changed would pass while `Actor.globalRole` is still read
from a cached session.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Admin-only, enforced by a check on `isAdmin(actor)` in the service, not by a
route decorator alone. Update `users.globalRole` by
`lower(username) = lower(:username)`.

**Check whether a live session caches `globalRole`.** Read
`SessionService.resolve` (or equivalent). If the role is baked into a cached
session payload, a freshly-granted setter keeps the old role until re-login,
and test 1 will catch it. Fix by reading the role from the database on each
resolve, or by invalidating that user's sessions on a role change — decide,
implement, and record which in the report.

- [ ] **Step 4: Document the bootstrap in `docs/runbook.md`**

The first admin cannot be created by this endpoint. Add the SQL:

```sql
UPDATE users SET global_role = 'admin' WHERE lower(username) = lower('yourname');
```

- [ ] **Step 5: Run gates; commit**

---

## Task 11: Web — problem list and problem page

**Files:**
- Create: `apps/web/src/markdown.ts`, `apps/web/src/routes/problems.tsx`, `apps/web/src/routes/problem.tsx`
- Modify: `apps/web/src/main.tsx`, `apps/web/package.json`
- Test: `apps/web/test/markdown.spec.ts`, `apps/web/test/problems.spec.tsx`

**Interfaces:**
- Consumes: the regenerated `@duckoj/sdk` (run the SDK generation step first —
  see `packages/sdk`'s scripts; the contracts of Task 7 must be in the
  registry before this task starts).

- [ ] **Step 1: Add dependencies**

`marked`, `katex`, `dompurify`. All three are pure JS with no native build.
Update `apps/web/package.json`, then run `corepack pnpm install`.

- [ ] **Step 2: Write `renderStatement` and its test FIRST**

```ts
export function renderStatement(markdown: string): string;
```

Tests, and these are the whole point of the function:

```ts
it('renders markdown', () => expect(renderStatement('# Hi')).toContain('<h1'));
it('renders inline maths', () => expect(renderStatement('$x^2$')).toContain('katex'));
it('strips a script tag', () => expect(renderStatement('<script>alert(1)</script>')).not.toContain('<script'));
it('strips an onerror handler', () =>
  expect(renderStatement('<img src=x onerror="alert(1)">')).not.toContain('onerror'));
it('strips a javascript: href', () =>
  expect(renderStatement('[x](javascript:alert(1))')).not.toContain('javascript:'));
```

The last three are the reason this file exists. Run them against a version
that skips `DOMPurify.sanitize` and confirm all three fail — **an XSS test
that passes without the sanitizer is testing nothing**, and this is exactly
the shape of untestable test the last phase shipped three of.

- [ ] **Step 3: Build the two routes**

`/problems`: a search box bound to `q`, a table of code/name/limits, and a
"load more" button driven by `nextCursor`. Use TanStack Query as the existing
routes do.

`/problems/:code`: name, limits, the rendered statement via
`dangerouslySetInnerHTML={{ __html: renderStatement(statement) }}`, and a link
to `/submit?problem=<code>`. A 404 renders "No such problem." — the same text
for absent and invisible, matching the API.

- [ ] **Step 4: Component tests**

Render the list with a mocked SDK: assert rows appear, assert the search box
re-queries, assert "load more" appends rather than replaces. For the detail
page, assert the statement HTML lands in the document and that a statement
containing `<script>` does not produce a script element.

- [ ] **Step 5: Run `apps/web` gates; commit**

---

## Task 12: Web — authoring

**Files:**
- Create: `apps/web/src/routes/problem-edit.tsx`, `apps/web/src/routes/problem-revisions.tsx`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/test/problem-edit.spec.tsx`

- [ ] **Step 1: Build the create/edit form**

Fields: code (create only, disabled on edit), name, statement (a plain
`<textarea>` with a live preview pane using `renderStatement`), visibility
(select), org slugs (comma-separated text input is acceptable this phase).

**No member editor.** Spec §1 puts it in Phase 3 with the user picker. Render
the current members read-only.

- [ ] **Step 2: Build the revisions screen**

A table of version / state / limits / test count / notes, a text input for a
package hash with an "Attach" button, and a "Publish" button per draft or
archived revision. Show the server's error `code` verbatim on failure — a
setter pasting a bad hash needs to see `package_not_found`, not "Something
went wrong".

- [ ] **Step 3: Tests**

```
the code field is disabled on the edit route and enabled on the new route
the preview pane updates as the statement changes
a failed attach shows the server error code
publish is not offered for the already-published revision
```

- [ ] **Step 4: Run gates; commit**

---

## Task 13: End to end against the live stack

**Files:**
- Create: `scripts/e2e-problem.ts`
- Modify: `docs/runbook.md`

**This task finds what the unit suites cannot.** Four bugs across two phases
were invisible to a green suite and immediately visible here.

- [ ] **Step 1: Bring the stack up from empty**

```bash
scripts/compose-up.sh
```

The `POSTGRES_USER`/`POSTGRES_DB` rename to `duckoj` means any surviving
volume is unusable; start from no volume at all.

- [ ] **Step 2: Write `scripts/e2e-problem.ts`**

Following `scripts/e2e-submit.ts`. The full path, over real HTTP against the
running stack:

1. Register a user; promote them to `setter` with the bootstrap SQL, then via
   `PATCH /admin/users/:username` for a second user (exercising both paths).
2. `POST /problems` — a private problem.
3. `scripts/package-build.ts` a fixture directory, `POST /packages`.
4. `POST /problems/:code/revisions` with the hash; assert the denormalised
   limits come back.
5. `POST …/publish`.
6. `PATCH /problems/:code` to `public`.
7. `POST /submissions` against it; poll until `done`; assert `AC`.
8. Submit deliberately uncompilable source; assert the verdict is **`CE`**,
   not `IE` — this is Task 9's proof against a real judge rather than a fake
   driver.

Exit non-zero with a clear message on any failed step. No step may be
silently skipped.

- [ ] **Step 3: Run it and paste the real output into the report**

- [ ] **Step 4: Check the web app in a browser against the live stack**

Load `/problems`, open the problem, confirm the statement renders and maths
displays. A React route that 404s against the real Caddy config is exactly
the Phase 1 `/ws` bug in a new place.

- [ ] **Step 5: Record anything found in the runbook; commit**

---

## Task 14: Documentation

**Files:**
- Modify: `README.md`, `docs/runbook.md`

- [ ] **Step 1: `README.md` — add "Phase 2b delivers" and "Phase 2b does not deliver"**

Mirror the existing Phase 0/1/2a sections exactly in tone and structure. The
"does not deliver" section must name: the member-management UI, package upload
from the browser, tags, contests, deletion, and scheduling policy.

- [ ] **Step 2: `docs/runbook.md` — add a "Phase 2b: authoring a problem" section**

The operator-facing walkthrough: bootstrap an admin with SQL, grant a setter,
create a problem, build and upload a package, attach, publish. Real commands,
copy-pasteable.

- [ ] **Step 3: Update "Known issues carried into Phase 2b"**

Retitle it for Phase 3 and remove the three items this phase fixed (CE,
`registry.ts`, path collisions). Leave the rest, and add anything Task 13
surfaced.

- [ ] **Step 4: Commit**

---

## Task 15: Phase 2b acceptance

- [ ] **Step 1: Clean-tree gate**

```bash
git clean -ndx | head       # inspect first — never run -f without reading this
rm -rf packages/*/dist apps/*/dist
corepack pnpm install --frozen-lockfile
corepack pnpm -r typecheck && corepack pnpm -r lint && corepack pnpm -r test
```

Deleting `dist/` first is not optional: three times across two phases a
package passed only because a stale `dist/` was on disk.

- [ ] **Step 2: Verify every acceptance criterion below, individually**

Not "the suite is green" — each line, with the command or observation that
shows it.

- [ ] **Step 3: Write the ledger**

`docs/superpowers/ledgers/2026-08-20-phase-2b-problems-ledger.md`, in the
shape of the Phase 2a ledger: a deferred-work table at the top, then the
rulings verbatim from the SDD progress file. Commit it.

- [ ] **Step 4: Report, and stop for the integration decision**

---

## Acceptance criteria

1. A setter can create a problem, attach a package, publish it, and a student can submit to it and get `AC` — verified against the live stack, not mocks.
2. A compile error reports `CE`, verified against a real judge.
3. `git grep -n "visibility" -- apps/api/src | grep -v problem.visibility.ts` shows no problem-visibility comparison outside the shared predicate.
4. An org member can both *see* and *submit to* an org-visible problem — the same actor, both paths, in one test.
5. A private problem returns `problem_not_found`, never 403, to a caller who may not see it.
6. `renderStatement` strips `<script>`, `onerror`, and `javascript:` hrefs, and each of those tests fails without the sanitizer.
7. A package whose paths collide case-insensitively or under NFC is rejected at attach time with `package_path_collision`.
8. Two concurrent attaches produce versions 1 and 2, never two 1s.
9. `registry.servers[0].url` is `API_PREFIX`, asserted against the imported constant.
9b. Every non-internal Nest route appears in the OpenAPI document — 18 of 18, not 7 — and deleting one registration makes `route-coverage.spec.ts` name it.
9c. `GET /docs` and `GET /openapi.json` are reachable **through Caddy** on the live stack, with the viewer's assets served locally rather than from a CDN.
10. `apps/api/test/dockerfile-manifest.spec.ts` is green, and deleting a COPY line makes it fail.
11. All gates green from a clean tree with every `dist/` deleted.
12. Every test added by this phase has been demonstrated to fail against broken code, with the failure output recorded in its task report.
