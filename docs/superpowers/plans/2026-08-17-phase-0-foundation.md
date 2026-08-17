# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, database, API skeleton, authentication, and the authorization pattern that every later phase depends on — with CI and a deployable Docker Compose stack.

**Architecture:** A pnpm workspace holding a NestJS API, a Drizzle/PostgreSQL data package, a Zod contracts package that generates OpenAPI and the SDK, and a minimal Vite SPA. Authentication is opaque session cookies plus personal access tokens. Authorization is centralised: guarded tables are importable only from the authorization module, enforced by ESLint, and covered by an adversarial leakage suite.

**Tech Stack:** TypeScript (ESM), Node 22, pnpm, NestJS, Drizzle ORM + drizzle-kit, PostgreSQL 16, Zod, Vitest, Testcontainers, React + Vite + TanStack Router/Query, Docker Compose + Caddy.

**Spec:** `docs/superpowers/specs/2026-08-17-foundation-design.md`

## Global Constraints

- **Node 22 LTS**, **pnpm** as the only package manager. No `npm install`, no `yarn`.
- **TypeScript, ESM everywhere.** `"type": "module"` in every package.
- **Database identifiers are `snake_case`; TypeScript identifiers are `camelCase`.** Drizzle column definitions carry the snake_case name explicitly.
- **API JSON is `camelCase`.** Timestamps are RFC 3339 UTC strings.
- **Primary keys are `bigserial`**, except `package.content_hash` (not in Phase 0).
- **Errors are RFC 9457 `application/problem+json`** with an added machine-readable `code`, and a `fields` map on validation failures.
- **Passwords are hashed with argon2id.** No other algorithm.
- **Sessions are opaque tokens stored as SHA-256 hashes.** Never JWT, never a plaintext token at rest.
- **No hand-written DTOs.** Request and response shapes come from Zod schemas in `packages/contracts`.
- **Migrations are forward-only.** Never edit a generated migration that has been committed.
- **Every task ends on a green `pnpm -r typecheck && pnpm -r lint && pnpm -r test`.**

### One deliberate widening of the spec's Phase 0

The spec lists the SDK as Phase 5 and does not mention the frontend before Phase 1. Tasks 12 and 13 nevertheless build a **minimal** SDK and SPA, for two reasons that are load-bearing rather than convenient: the deploy shape (Task 15) has Caddy serving a static bundle, which requires a bundle to exist; and spec §11's contracts-as-single-source-of-truth is unverifiable without a generated client to drift-check in CI. Phase 5 then becomes the SDK's *ergonomics and CLI*, not its existence. Nothing beyond `createClient` and two screens is built here.

### Deferred out of Phase 0 (do not build)

Idempotency-key middleware (Phase 1, when duplicate submission POSTs make it meaningful) · Redis and BullMQ (Phase 1) · MinIO and blob storage (Phase 2) · organization *management* endpoints beyond what the leakage suite needs (Phase 3) · i18n and any component library (open questions in spec §15) · rate limiting (Phase 1).

---

## File Structure

```
qhhoj/
  package.json                      workspace root, scripts
  pnpm-workspace.yaml
  tsconfig.base.json                shared compiler options
  eslint.config.js                  flat config, incl. import-boundary rules
  .prettierrc
  vitest.workspace.ts
  docker-compose.yml                postgres + api + web (Caddy)
  Caddyfile
  .github/workflows/ci.yml

  packages/db/
    src/schema/identity.ts          users, sessions, access_tokens, totp_credentials
    src/schema/guarded.ts           organizations + membership — import-restricted
    src/schema/index.ts             re-export barrel (guarded excluded)
    src/client.ts                   createDb(), Db type
    src/migrate.ts                  runMigrations()
    drizzle.config.ts
    migrations/                     generated SQL, committed
    test/harness.ts                 Testcontainers Postgres + migrations

  packages/contracts/
    src/common.ts                   pagination, problem+json envelope
    src/auth.ts                     register/login/me schemas
    src/tokens.ts                   access-token schemas
    src/orgs.ts                     organization schemas
    src/registry.ts                 OpenAPI registry + generator
    src/index.ts

  packages/sdk/
    src/generated.ts                openapi-typescript output (generated, committed)
    src/client.ts                   createClient() wrapper
    src/index.ts

  apps/api/
    src/main.ts                     bootstrap
    src/app.module.ts
    src/config/config.schema.ts     Zod-validated env
    src/config/config.module.ts
    src/common/problem.filter.ts    RFC 9457 exception filter
    src/common/zod.pipe.ts          ZodValidationPipe
    src/common/logger.ts            pino + request id
    src/health/health.controller.ts /healthz, /readyz
    src/authn/password.service.ts   argon2id
    src/authn/session.service.ts    create/resolve/revoke sessions
    src/authn/token.service.ts      personal access tokens
    src/authn/totp.service.ts       TOTP enrol/verify
    src/authn/auth.guard.ts         session-or-token → Actor
    src/authn/auth.controller.ts    register, login, logout, me
    src/authn/tokens.controller.ts  PAT CRUD
    src/authz/actor.ts              Actor type + role helpers
    src/authz/org.access.ts         visibleOrganizations(), canManageOrg()
    src/authz/authz.module.ts
    src/orgs/orgs.controller.ts     list/get — the leakage-suite surface
    test/leakage/actors.ts          actor matrix fixture
    test/leakage/orgs.spec.ts       exact-visible-set assertions

  apps/web/
    src/main.tsx  src/router.tsx  src/routes/login.tsx  src/routes/index.tsx
    src/api.ts                      SDK client instance
    vite.config.ts  index.html
```

**Why `guarded.ts` is a separate schema file:** the spec requires that no handler filters visibility by hand. That is only enforceable if the guarded tables are reachable through a distinct import path, which ESLint can then restrict to the authorization module. Tables move into `guarded.ts` as later phases add them (`problems`, `submissions`, `contests`).

---

## Task 1: Monorepo skeleton and tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `vitest.workspace.ts`, `.nvmrc`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/src/index.ts`, `packages/db/test/smoke.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace scripts `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`; the package naming convention `@qhhoj/<name>`.

- [ ] **Step 1: Write the failing smoke test**

`packages/db/test/smoke.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

describe('workspace wiring', () => {
  it('resolves the package entrypoint', () => {
    expect(PACKAGE_NAME).toBe('@qhhoj/db');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/db/test/smoke.spec.ts`
Expected: FAIL — the workspace does not exist yet, so pnpm/vitest is not installed. That failure is the signal to build the scaffolding.

- [ ] **Step 3: Create the workspace root**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

`.nvmrc`:

```
22
```

`package.json`:

```json
{
  "name": "qhhoj",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22",
    "eslint": "^9",
    "typescript-eslint": "^8",
    "prettier": "^3",
    "typescript": "^5.6",
    "vitest": "^2"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.prettierrc`:

```json
{ "singleQuote": true, "printWidth": 100, "trailingComma": "all" }
```

`vitest.workspace.ts`:

```ts
export default ['packages/*', 'apps/*'];
```

`eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/migrations/**', '**/src/generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 4: Create the first package**

`packages/db/package.json`:

```json
{
  "name": "@qhhoj/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./guarded": "./dist/schema/guarded.js"
  },
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint src test",
    "test": "vitest run"
  }
}
```

`packages/db/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/db/src/index.ts`:

```ts
export const PACKAGE_NAME = '@qhhoj/db';
```

- [ ] **Step 5: Install and run the full gate**

```bash
corepack enable
pnpm install
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

Expected: all green, one passing test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: pnpm workspace, typescript, eslint, prettier, vitest"
```

---

## Task 2: Database package — connection, migrations, identity schema

**Files:**
- Create: `packages/db/src/schema/identity.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/client.ts`, `packages/db/src/migrate.ts`, `packages/db/drizzle.config.ts`, `packages/db/test/harness.ts`
- Create: `packages/db/test/identity.spec.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/package.json`

**Interfaces:**
- Consumes: Task 1 workspace.
- Produces:
  - `createDb(url: string): Db` where `Db = PostgresJsDatabase<typeof schema>`
  - `runMigrations(url: string): Promise<void>`
  - `schema.users`, `schema.sessions`, `schema.accessTokens`, `schema.totpCredentials`
  - `withTestDb(fn: (db: Db) => Promise<void>): Promise<void>` from `test/harness.ts`

- [ ] **Step 1: Install dependencies**

```bash
pnpm --filter @qhhoj/db add drizzle-orm postgres
pnpm --filter @qhhoj/db add -D drizzle-kit @testcontainers/postgresql
```

- [ ] **Step 2: Write the failing test**

`packages/db/test/identity.spec.ts`:

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/index.js';
import { withTestDb } from './harness.js';

describe('identity schema', () => {
  it('stores and reads back a user', async () => {
    await withTestDb(async (db) => {
      const [inserted] = await db
        .insert(schema.users)
        .values({
          username: 'alice',
          email: 'alice@example.com',
          passwordHash: 'argon2id$placeholder',
          displayName: 'Alice',
        })
        .returning();

      expect(inserted?.globalRole).toBe('user');
      expect(inserted?.status).toBe('active');
      expect(inserted?.rating).toBeNull();

      const found = await db.query.users.findFirst({
        where: eq(schema.users.username, 'alice'),
      });
      expect(found?.email).toBe('alice@example.com');
    });
  }, 120_000);

  it('rejects a duplicate username differing only in case', async () => {
    await withTestDb(async (db) => {
      const base = { passwordHash: 'x', displayName: 'X' };
      await db.insert(schema.users).values({ ...base, username: 'bob', email: 'b@example.com' });
      await expect(
        db.insert(schema.users).values({ ...base, username: 'BOB', email: 'b2@example.com' }),
      ).rejects.toThrow();
    });
  }, 120_000);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/db test`
Expected: FAIL — `Cannot find module './harness.js'`.

- [ ] **Step 4: Write the schema**

`packages/db/src/schema/identity.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'pending']);
export const globalRole = pgEnum('global_role', ['user', 'setter', 'admin']);

export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: userStatus('status').notNull().default('active'),
    globalRole: globalRole('global_role').notNull().default('user'),
    displayName: text('display_name').notNull(),
    about: text('about'),
    avatarKey: text('avatar_key'),
    country: text('country'),
    timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
    locale: text('locale').notNull().default('vi'),
    rating: integer('rating'),
    maxRating: integer('max_rating'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_username_lower_idx').on(sql`lower(${t.username})`),
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sessions_token_hash_idx').on(t.tokenHash)],
);

export const accessTokens = pgTable(
  'access_tokens',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('access_tokens_token_hash_idx').on(t.tokenHash)],
);

export const totpCredentials = pgTable('totp_credentials', {
  userId: bigint('user_id', { mode: 'number' })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEnc: text('secret_enc').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

`packages/db/src/schema/index.ts`:

```ts
export * from './identity.js';
```

- [ ] **Step 5: Write the client and migration runner**

`packages/db/src/client.ts`:

```ts
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const sql = postgres(url, { max: 10 });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
```

`packages/db/src/migrate.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
```

`packages/db/src/index.ts` (replace):

```ts
export * as schema from './schema/index.js';
export { createDb, type Db } from './client.js';
export { runMigrations } from './migrate.js';
```

`packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema/index.ts', './src/schema/guarded.ts'],
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/qhhoj' },
});
```

Note: `guarded.ts` does not exist until Task 3. Create it now as an empty module so drizzle-kit does not fail:

`packages/db/src/schema/guarded.ts`:

```ts
export {};
```

- [ ] **Step 6: Write the test harness**

`packages/db/test/harness.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, runMigrations, type Db } from '../src/index.js';

let container: StartedPostgreSqlContainer | undefined;
let url: string | undefined;

async function ensureContainer(): Promise<string> {
  if (url) return url;
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  url = container.getConnectionUri();
  await runMigrations(url);
  return url;
}

/**
 * Runs `fn` against a migrated database inside a transaction that is always
 * rolled back, so tests share one container without sharing state.
 */
export async function withTestDb(fn: (db: Db) => Promise<void>): Promise<void> {
  const connectionUrl = await ensureContainer();
  const { db, close } = createDb(connectionUrl);
  try {
    await db
      .transaction(async (tx) => {
        await fn(tx as unknown as Db);
        throw new RollbackSignal();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RollbackSignal)) throw error;
      });
  } finally {
    await close();
  }
}

class RollbackSignal extends Error {}
```

- [ ] **Step 7: Generate the migration and run the tests**

```bash
pnpm --filter @qhhoj/db exec drizzle-kit generate --name init_identity
pnpm --filter @qhhoj/db test
```

Expected: both tests PASS. A `migrations/0000_*.sql` file exists and is committed.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(db): drizzle client, migration runner, identity schema"
```

---

## Task 3: Guarded schema — organizations and membership

**Files:**
- Modify: `packages/db/src/schema/guarded.ts`
- Create: `packages/db/test/orgs.spec.ts`

**Interfaces:**
- Consumes: `schema.users` (Task 2), `withTestDb` (Task 2).
- Produces: `organizations`, `orgMembers`, `orgJoinRequests` — importable **only** from `@qhhoj/db/guarded`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/orgs.spec.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { organizations, orgMembers } from '../src/schema/guarded.js';
import { schema } from '../src/index.js';
import { withTestDb } from './harness.js';

describe('organization schema', () => {
  it('defaults to private visibility and links members with a role', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({
          username: 'carol',
          email: 'carol@example.com',
          passwordHash: 'x',
          displayName: 'Carol',
        })
        .returning();
      const [org] = await db
        .insert(organizations)
        .values({ slug: 'qhh', name: 'QHH' })
        .returning();

      expect(org?.visibility).toBe('private');
      expect(org?.joinPolicy).toBe('request');

      await db
        .insert(orgMembers)
        .values({ orgId: org!.id, userId: user!.id, role: 'owner' });

      const membership = await db
        .select()
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, org!.id), eq(orgMembers.userId, user!.id)));

      expect(membership[0]?.role).toBe('owner');
    });
  }, 120_000);

  it('rejects a duplicate slug differing only in case', async () => {
    await withTestDb(async (db) => {
      await db.insert(organizations).values({ slug: 'club', name: 'Club' });
      await expect(
        db.insert(organizations).values({ slug: 'CLUB', name: 'Club 2' }),
      ).rejects.toThrow();
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/db test orgs`
Expected: FAIL — `organizations` is not exported from `guarded.js`.

- [ ] **Step 3: Write the guarded schema**

`packages/db/src/schema/guarded.ts` (replace the placeholder):

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

export const orgVisibility = pgEnum('org_visibility', ['public', 'private']);
export const orgJoinPolicy = pgEnum('org_join_policy', ['open', 'request', 'invite']);
export const orgRole = pgEnum('org_role', ['owner', 'admin', 'member']);
export const joinRequestState = pgEnum('join_request_state', ['pending', 'approved', 'rejected']);

export const organizations = pgTable(
  'organizations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    about: text('about'),
    visibility: orgVisibility('visibility').notNull().default('private'),
    joinPolicy: orgJoinPolicy('join_policy').notNull().default('request'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_lower_idx').on(sql`lower(${t.slug})`)],
);

export const orgMembers = pgTable(
  'org_members',
  {
    orgId: bigint('org_id', { mode: 'number' })
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const orgJoinRequests = pgTable('org_join_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orgId: bigint('org_id', { mode: 'number' })
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  state: joinRequestState('state').notNull().default('pending'),
  decidedBy: bigint('decided_by', { mode: 'number' }).references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});
```

**Deliberately not re-exported from `src/schema/index.ts`.** The only import path is `@qhhoj/db/guarded`, which Task 11 restricts by ESLint.

- [ ] **Step 4: Generate the migration and run the tests**

```bash
pnpm --filter @qhhoj/db exec drizzle-kit generate --name organizations
pnpm --filter @qhhoj/db test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): organizations, membership, join requests as guarded schema"
```

---

## Task 4: Contracts package — envelope, pagination, OpenAPI generation

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/common.ts`, `packages/contracts/src/auth.ts`, `packages/contracts/src/registry.ts`, `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/common.spec.ts`

**Interfaces:**
- Consumes: Task 1 workspace.
- Produces:
  - `ProblemDetails` Zod schema and `ProblemDetailsDto` type
  - `cursorPage<T>(item: T)` → schema with `{ items, nextCursor }`
  - `RegisterRequest`, `LoginRequest`, `MeResponse` schemas
  - `openApiDocument()` returning an OpenAPI 3.1 object
  - `registry` — the `OpenAPIRegistry` later tasks register paths on

- [ ] **Step 1: Install dependencies**

```bash
pnpm --filter @qhhoj/contracts add zod @asteasolutions/zod-to-openapi
```

- [ ] **Step 2: Write the failing test**

`packages/contracts/test/common.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cursorPage, ProblemDetails, openApiDocument } from '../src/index.js';

describe('common contracts', () => {
  it('validates a problem+json body', () => {
    const parsed = ProblemDetails.parse({
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      fields: { email: ['must be an email'] },
    });
    expect(parsed.status).toBe(422);
  });

  it('builds a cursor page schema around an item schema', () => {
    const page = cursorPage(z.object({ id: z.number() }));
    const parsed = page.parse({ items: [{ id: 1 }], nextCursor: null });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextCursor).toBeNull();
  });

  it('emits an OpenAPI 3.1 document', () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('QHH Online Judge API');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/contracts test`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the package**

`packages/contracts/package.json`:

```json
{
  "name": "@qhhoj/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint src test",
    "test": "vitest run",
    "openapi": "tsx scripts/emit-openapi.ts"
  }
}
```

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/contracts/src/common.ts`:

```ts
import { z } from 'zod';

export const ProblemDetails = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Machine-readable, stable across wording changes. */
  code: z.string(),
  /** Present only on validation failures. */
  fields: z.record(z.string(), z.array(z.string())).optional(),
});
export type ProblemDetailsDto = z.infer<typeof ProblemDetails>;

export const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQueryDto = z.infer<typeof PaginationQuery>;

export function cursorPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const Timestamp = z.string().datetime({ offset: true });
```

`packages/contracts/src/auth.ts`:

```ts
import { z } from 'zod';
import { Timestamp } from './common.js';

export const Username = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/, 'may contain letters, digits, dot, underscore and hyphen only');

export const Password = z.string().min(10).max(256);

export const RegisterRequest = z.object({
  username: Username,
  email: z.string().email(),
  password: Password,
  displayName: z.string().min(1).max(64),
});
export type RegisterRequestDto = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  usernameOrEmail: z.string().min(1),
  password: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginRequestDto = z.infer<typeof LoginRequest>;

export const MeResponse = z.object({
  id: z.number().int(),
  username: z.string(),
  email: z.string(),
  displayName: z.string(),
  globalRole: z.enum(['user', 'setter', 'admin']),
  locale: z.string(),
  timezone: z.string(),
  totpEnabled: z.boolean(),
  createdAt: Timestamp,
});
export type MeResponseDto = z.infer<typeof MeResponse>;

export const LoginResponse = z.object({ user: MeResponse });
```

`packages/contracts/src/registry.ts`:

```ts
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

export const registry = new OpenAPIRegistry();

export function openApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'QHH Online Judge API', version: '1.0.0' },
    servers: [{ url: '/api/v1' }],
  });
}
```

`packages/contracts/src/index.ts`:

```ts
export * from './common.js';
export * from './auth.js';
export * from './registry.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @qhhoj/contracts test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(contracts): problem+json envelope, cursor pagination, auth schemas, openapi generator"
```

---

## Task 5: API bootstrap — config, logging, health

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/config/config.schema.ts`, `apps/api/src/config/config.module.ts`, `apps/api/src/common/logger.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/health/health.module.ts`
- Create: `apps/api/test/health.spec.ts`, `apps/api/test/config.spec.ts`

**Interfaces:**
- Consumes: `@qhhoj/db` `createDb`.
- Produces:
  - `AppConfig` type and `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
  - `ConfigModule` providing `APP_CONFIG` injection token
  - `DB` injection token resolving to `Db`
  - `GET /healthz` → `{ status: 'ok' }`; `GET /readyz` → 200 or 503

- [ ] **Step 1: Install dependencies**

```bash
pnpm --filter @qhhoj/api add @nestjs/common @nestjs/core @nestjs/platform-express \
  reflect-metadata rxjs pino pino-http zod drizzle-orm \
  @qhhoj/db@workspace:* @qhhoj/contracts@workspace:*
pnpm --filter @qhhoj/api add -D @nestjs/testing supertest @types/supertest tsx
```

- [ ] **Step 2: Create the package manifest**

`apps/api/package.json`:

```json
{
  "name": "@qhhoj/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint src test",
    "test": "vitest run",
    "build": "tsc -b",
    "dev": "tsx watch src/main.ts"
  }
}
```

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src"],
  "references": [{ "path": "../../packages/db" }, { "path": "../../packages/contracts" }]
}
```

- [ ] **Step 3: Write the failing config test**

`apps/api/test/config.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.schema.js';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SESSION_TTL_HOURS: '720',
  TOTP_ENC_KEY: 'a'.repeat(64),
  PUBLIC_ORIGIN: 'http://localhost:5173',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.sessionTtlHours).toBe(720);
  });

  it('throws with the offending keys when the environment is invalid', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a TOTP key that is not 32 bytes of hex', () => {
    expect(() => loadConfig({ ...valid, TOTP_ENC_KEY: 'short' })).toThrow(/TOTP_ENC_KEY/);
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/api test config`
Expected: FAIL — module not found.

- [ ] **Step 5: Write the config**

`apps/api/src/config/config.schema.ts`:

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().default('qhhoj_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(720),
  TOTP_ENC_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'must be 32 bytes of lowercase hex'),
  PUBLIC_ORIGIN: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  sessionCookieName: string;
  sessionTtlHours: number;
  totpEncKey: Buffer;
  publicOrigin: string;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${detail}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    sessionCookieName: e.SESSION_COOKIE_NAME,
    sessionTtlHours: e.SESSION_TTL_HOURS,
    totpEncKey: Buffer.from(e.TOTP_ENC_KEY, 'hex'),
    publicOrigin: e.PUBLIC_ORIGIN,
    logLevel: e.LOG_LEVEL,
  };
}
```

- [ ] **Step 6: Run the config test**

Run: `pnpm --filter @qhhoj/api test config`
Expected: PASS (3 tests).

- [ ] **Step 7: Write the failing health test**

`apps/api/test/health.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthModule } from '../src/health/health.module.js';
import { DB } from '../src/config/config.module.js';

describe('health endpoints', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] })
      .overrideProvider(DB)
      .useValue({ execute: async () => [{ ok: 1 }] })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => app.close());

  it('reports liveness without touching dependencies', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports readiness when the database answers', async () => {
    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('ok');
  });
});
```

- [ ] **Step 8: Write the modules**

`apps/api/src/config/config.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { createDb, type Db } from '@qhhoj/db';
import { loadConfig, type AppConfig } from './config.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig(process.env) },
    {
      provide: DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Db => createDb(config.databaseUrl).db,
    },
  ],
  exports: [APP_CONFIG, DB],
})
export class ConfigModule {}
```

`apps/api/src/health/health.controller.ts`:

```ts
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@qhhoj/db';
import { DB } from '../config/config.module.js';

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException('database unreachable');
    }
    return { status: 'ok', database: 'ok' };
  }
}
```

`apps/api/src/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/common/logger.ts`:

```ts
import { randomUUID } from 'node:crypto';
// Named import, not default: under NodeNext resolution a default import of
// pino-http fails with TS2349 (no call signatures). Both names point at the
// same function object at runtime.
import { pinoHttp } from 'pino-http';

export function requestLogger(level: string) {
  return pinoHttp({
    level,
    genReqId: (req, res) => {
      const existing = req.headers['x-request-id'];
      const id = typeof existing === 'string' && existing.length > 0 ? existing : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  });
}
```

`apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';

@Module({ imports: [ConfigModule, HealthModule] })
export class AppModule {}
```

`apps/api/src/main.ts`:

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.schema.js';
import { requestLogger } from './common/logger.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(requestLogger(config.logLevel));
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  app.enableCors({ origin: config.publicOrigin, credentials: true });
  await app.listen(config.port);
}

void bootstrap();
```

- [ ] **Step 9: Run the tests**

Run: `pnpm --filter @qhhoj/api test`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(api): nest bootstrap, zod-validated config, pino request logging, health endpoints"
```

---

## Task 6: RFC 9457 error filter and Zod validation pipe

**Files:**
- Create: `apps/api/src/common/problem.filter.ts`, `apps/api/src/common/zod.pipe.ts`, `apps/api/src/common/app.error.ts`
- Create: `apps/api/test/problem.spec.ts`
- Modify: `apps/api/src/main.ts`

**Interfaces:**
- Consumes: `ProblemDetails` from `@qhhoj/contracts`.
- Produces:
  - `class AppError extends Error { status: number; code: string; detail?: string; fields?: Record<string, string[]> }`
  - `ProblemFilter` — global exception filter emitting `application/problem+json`
  - `ZodValidationPipe` — `new ZodValidationPipe(schema)` for `@Body`/`@Query`

- [ ] **Step 1: Write the failing test**

`apps/api/test/problem.spec.ts`:

```ts
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/common/app.error.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { ZodValidationPipe } from '../src/common/zod.pipe.js';

const Body_ = z.object({ email: z.string().email(), age: z.number().int().min(0) });

@Controller('t')
class TestController {
  @Get('boom')
  boom(): never {
    throw new AppError(409, 'org_slug_taken', 'That slug is already in use.');
  }

  @Get('unknown')
  unknown(): never {
    throw new Error('kaboom');
  }

  @Post('validate')
  validate(@Body(new ZodValidationPipe(Body_)) body: z.infer<typeof Body_>) {
    return body;
  }
}

@Module({ controllers: [TestController] })
class TestModule {}

describe('problem+json error handling', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it('renders an AppError as problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/t/boom');
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('org_slug_taken');
    expect(res.body.status).toBe(409);
  });

  it('never leaks an internal message', async () => {
    const res = await request(app.getHttpServer()).get('/t/unknown');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('kaboom');
  });

  it('reports field-level validation failures', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/validate')
      .send({ email: 'nope', age: -1 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.fields.email).toBeDefined();
    expect(res.body.fields.age).toBeDefined();
  });

  it('passes a valid body through unchanged', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/validate')
      .send({ email: 'a@b.com', age: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ email: 'a@b.com', age: 3 });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/api test problem`
Expected: FAIL — `app.error.js` not found.

- [ ] **Step 3: Write the implementation**

`apps/api/src/common/app.error.ts`:

```ts
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly fields?: Record<string, string[]>,
  ) {
    super(detail ?? code);
    this.name = 'AppError';
  }
}
```

`apps/api/src/common/zod.pipe.ts`:

```ts
import type { PipeTransform } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from './app.error.js';

@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const fields: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      (fields[key] ??= []).push(issue.message);
    }
    throw new AppError(422, 'validation_failed', 'The request body failed validation.', fields);
  }
}
```

`apps/api/src/common/problem.filter.ts`:

```ts
import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ProblemDetailsDto } from '@qhhoj/contracts';
import { AppError } from './app.error.js';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const problem = this.toProblem(exception, req.originalUrl);
    if (problem.status >= 500) this.logger.error(exception);

    res.status(problem.status).type('application/problem+json').send(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetailsDto {
    if (exception instanceof AppError) {
      return {
        type: 'about:blank',
        title: TITLES[exception.status] ?? 'Error',
        status: exception.status,
        code: exception.code,
        instance,
        ...(exception.detail ? { detail: exception.detail } : {}),
        ...(exception.fields ? { fields: exception.fields } : {}),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: 'about:blank',
        title: TITLES[status] ?? 'Error',
        status,
        code: snakeCode(TITLES[status] ?? 'error'),
        instance,
      };
    }
    return {
      type: 'about:blank',
      title: TITLES[500]!,
      status: 500,
      code: 'internal_error',
      instance,
    };
  }
}

function snakeCode(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '_');
}
```

- [ ] **Step 4: Register the filter globally**

In `apps/api/src/main.ts`, after `app.use(requestLogger(...))` add:

```ts
app.useGlobalFilters(new ProblemFilter());
```

and the import:

```ts
import { ProblemFilter } from './common/problem.filter.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @qhhoj/api test problem`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): rfc 9457 problem+json filter and zod validation pipe"
```

---

## Task 7: Password hashing and registration

**Files:**
- Create: `apps/api/src/authn/password.service.ts`, `apps/api/src/authn/auth.service.ts`, `apps/api/src/authn/auth.controller.ts`, `apps/api/src/authn/authn.module.ts`
- Create: `apps/api/test/register.spec.ts`, `apps/api/test/db.harness.ts`, `apps/api/test/app.harness.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `schema.users`, `DB`, `AppError`, `ZodValidationPipe`, `RegisterRequest`.
- Produces:
  - `PasswordService.hash(plain: string): Promise<string>` and `.verify(hash: string, plain: string): Promise<boolean>`
  - `AuthService.register(input: RegisterRequestDto): Promise<MeResponseDto>`
  - `POST /api/v1/auth/register` → 201 `MeResponse`
  - `buildApp(db: Db): Promise<INestApplication>` and `TEST_CONFIG: AppConfig` from `test/app.harness.ts` — used by Tasks 8, 9 and 10
  - `withTestDb` from `test/db.harness.ts` — used by every later API test

- [ ] **Step 1: Install argon2**

```bash
pnpm --filter @qhhoj/api add @node-rs/argon2
```

- [ ] **Step 2: Write the failing test**

`apps/api/test/register.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PasswordService } from '../src/authn/password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an argon2id hash that is not the plaintext', async () => {
    const hash = await service.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('correct horse battery');
    await expect(service.verify(hash, 'correct horse battery')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('correct horse battery');
    await expect(service.verify(hash, 'wrong horse battery')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('salts — the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([service.hash('same'), service.hash('same')]);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/api test register`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the password service**

`apps/api/src/authn/password.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/** OWASP-recommended argon2id parameters: 19 MiB, 2 iterations, 1 lane. */
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, OPTIONS);
  }

  async verify(hashed: string, plain: string): Promise<boolean> {
    try {
      return await verify(hashed, plain, OPTIONS);
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 5: Run the password tests**

Run: `pnpm --filter @qhhoj/api test register`
Expected: PASS (5 tests).

- [ ] **Step 6: Add the registration test**

Append to `apps/api/test/register.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';

describe('POST /auth/register', () => {
  it('creates a user and returns the profile without the password', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        username: 'dave',
        email: 'dave@example.com',
        password: 'a-long-enough-password',
        displayName: 'Dave',
      });
      expect(res.status).toBe(201);
      expect(res.body.username).toBe('dave');
      expect(res.body.globalRole).toBe('user');
      expect(JSON.stringify(res.body)).not.toContain('password');
      await app.close();
    });
  }, 120_000);

  it('rejects a duplicate username with 409 and a stable code', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const body = {
        username: 'erin',
        email: 'erin@example.com',
        password: 'a-long-enough-password',
        displayName: 'Erin',
      };
      await request(app.getHttpServer()).post('/auth/register').send(body);
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ ...body, email: 'erin2@example.com' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('username_taken');
      await app.close();
    });
  }, 120_000);

  it('rejects a short password with 422 and a field message', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        username: 'frank',
        email: 'frank@example.com',
        password: 'short',
        displayName: 'Frank',
      });
      expect(res.status).toBe(422);
      expect(res.body.fields.password).toBeDefined();
      await app.close();
    });
  }, 120_000);
});
```

Create `apps/api/test/db.harness.ts` — a verbatim copy of `packages/db/test/harness.ts`. It is duplicated rather than imported because test directories are outside each package's `exports` map, and widening `@qhhoj/db`'s public surface to expose test infrastructure would be worse than sixteen duplicated lines.

Also create `apps/api/test/app.harness.ts`, shared by every API endpoint spec:

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { Db } from '@qhhoj/db';
import { AuthnModule } from '../src/authn/authn.module.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import type { AppConfig } from '../src/config/config.schema.js';

export const TEST_CONFIG: AppConfig = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: 'postgres://unused',
  sessionCookieName: 'qhhoj_session',
  sessionTtlHours: 720,
  totpEncKey: Buffer.alloc(32, 1),
  publicOrigin: 'http://localhost:5173',
  logLevel: 'silent',
};

export async function buildApp(db: Db): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AuthnModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    .compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  return app;
}
```

Import `buildApp` from this file in the registration spec rather than defining it locally.

- [ ] **Step 7: Write the registration service and controller**

`apps/api/src/authn/auth.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import type { MeResponseDto, RegisterRequestDto } from '@qhhoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { PasswordService } from './password.service.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly passwords: PasswordService,
  ) {}

  async register(input: RegisterRequestDto): Promise<MeResponseDto> {
    await this.assertAvailable('username', input.username);
    await this.assertAvailable('email', input.email);

    const [user] = await this.db
      .insert(schema.users)
      .values({
        username: input.username,
        email: input.email,
        displayName: input.displayName,
        passwordHash: await this.passwords.hash(input.password),
      })
      .returning();

    return toMe(user!, false);
  }

  private async assertAvailable(field: 'username' | 'email', value: string): Promise<void> {
    const column = field === 'username' ? schema.users.username : schema.users.email;
    const existing = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${column}) = lower(${value})`)
      .limit(1);
    if (existing.length > 0) {
      throw new AppError(409, `${field}_taken`, `That ${field} is already registered.`);
    }
  }
}

export function toMe(
  user: typeof schema.users.$inferSelect,
  totpEnabled: boolean,
): MeResponseDto {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    globalRole: user.globalRole,
    locale: user.locale,
    timezone: user.timezone,
    totpEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}
```

`apps/api/src/authn/auth.controller.ts`:

```ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { RegisterRequest, type MeResponseDto, type RegisterRequestDto } from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AuthService } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @HttpCode(201)
  register(
    @Body(new ZodValidationPipe(RegisterRequest)) body: RegisterRequestDto,
  ): Promise<MeResponseDto> {
    return this.auth.register(body);
  }
}
```

`apps/api/src/authn/authn.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
  exports: [AuthService, PasswordService],
})
export class AuthnModule {}
```

Add `AuthnModule` to `imports` in `apps/api/src/app.module.ts`.

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @qhhoj/api test register`
Expected: PASS (8 tests).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): argon2id password hashing and user registration"
```

---

## Task 8: Sessions — login, logout, me

**Files:**
- Create: `apps/api/src/authn/session.service.ts`, `apps/api/src/authn/auth.guard.ts`, `apps/api/src/authz/actor.ts`
- Create: `apps/api/test/session.spec.ts`
- Modify: `apps/api/src/authn/auth.controller.ts`, `apps/api/src/authn/auth.service.ts`, `apps/api/src/authn/authn.module.ts`, `apps/api/src/main.ts`

**Interfaces:**
- Consumes: `schema.sessions`, `PasswordService`, `AppConfig`.
- Produces:
  - `interface Actor { userId: number; globalRole: 'user'|'setter'|'admin'; via: 'session'|'token'; scopes: string[] }`
  - `SessionService.issue(userId, meta): Promise<{ token: string; expiresAt: Date }>`
  - `SessionService.resolve(token): Promise<Actor | null>`
  - `SessionService.revoke(token): Promise<void>`
  - `AuthGuard` attaching `req.actor`; `@CurrentActor()` param decorator
  - `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`

- [ ] **Step 1: Install the cookie parser**

```bash
pnpm --filter @qhhoj/api add cookie-parser
pnpm --filter @qhhoj/api add -D @types/cookie-parser
```

- [ ] **Step 2: Write the failing test**

`apps/api/test/session.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { schema } from '@qhhoj/db';
import { SessionService } from '../src/authn/session.service.js';
import { withTestDb } from './db.harness.js';

const config = { sessionTtlHours: 720 } as never;

describe('SessionService', () => {
  it('issues a token that resolves to the owning actor', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'gina', email: 'g@e.com', passwordHash: 'x', displayName: 'G' })
        .returning();
      const service = new SessionService(db, config);

      const { token } = await service.issue(user!.id, {});
      const actor = await service.resolve(token);

      expect(actor?.userId).toBe(user!.id);
      expect(actor?.via).toBe('session');
    });
  }, 120_000);

  it('stores only a hash — the raw token never appears in the table', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'hana', email: 'h@e.com', passwordHash: 'x', displayName: 'H' })
        .returning();
      const service = new SessionService(db, config);

      const { token } = await service.issue(user!.id, {});
      const rows = await db.select().from(schema.sessions);

      expect(rows[0]?.tokenHash).not.toBe(token);
      expect(rows.map((r) => r.tokenHash)).not.toContain(token);
    });
  }, 120_000);

  it('returns null for an unknown token', async () => {
    await withTestDb(async (db) => {
      const service = new SessionService(db, config);
      expect(await service.resolve('nonsense')).toBeNull();
    });
  }, 120_000);

  it('returns null for an expired session', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'ivan', email: 'i@e.com', passwordHash: 'x', displayName: 'I' })
        .returning();
      const service = new SessionService(db, { sessionTtlHours: -1 } as never);
      const { token } = await service.issue(user!.id, {});
      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);

  it('revokes a session immediately', async () => {
    await withTestDb(async (db) => {
      const [user] = await db
        .insert(schema.users)
        .values({ username: 'jane', email: 'j@e.com', passwordHash: 'x', displayName: 'J' })
        .returning();
      const service = new SessionService(db, config);
      const { token } = await service.issue(user!.id, {});
      await service.revoke(token);
      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/api test session`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the actor type and session service**

`apps/api/src/authz/actor.ts`:

```ts
export interface Actor {
  userId: number;
  globalRole: 'user' | 'setter' | 'admin';
  via: 'session' | 'token';
  scopes: string[];
}

export function isAdmin(actor: Actor | null): boolean {
  return actor?.globalRole === 'admin';
}
```

`apps/api/src/authn/session.service.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import { APP_CONFIG, DB } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { Actor } from '../authz/actor.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issue(userId: number, meta: SessionMeta): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 3_600_000);
    await this.db.insert(schema.sessions).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<Actor | null> {
    const rows = await this.db
      .select({ userId: schema.users.id, globalRole: schema.users.globalRole })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(
        and(
          eq(schema.sessions.tokenHash, hashToken(token)),
          gt(schema.sessions.expiresAt, new Date()),
          eq(schema.users.status, 'active'),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row ? { userId: row.userId, globalRole: row.globalRole, via: 'session', scopes: [] } : null;
  }

  async revoke(token: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
  }
}
```

- [ ] **Step 5: Run the session tests**

Run: `pnpm --filter @qhhoj/api test session`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the guard and wire up login/logout/me**

`apps/api/src/authn/auth.guard.ts`:

```ts
import { createParamDecorator, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';
import type { Actor } from '../authz/actor.js';
import { SessionService } from './session.service.js';

export interface AuthedRequest extends Request {
  actor?: Actor;
}

/** Attaches `req.actor` when credentials are present. Does not itself reject. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const cookie = req.cookies?.[this.config.sessionCookieName] as string | undefined;
    if (cookie) {
      const actor = await this.sessions.resolve(cookie);
      if (actor) req.actor = actor;
    }
    return true;
  }
}

export const CurrentActor = createParamDecorator((_data, context: ExecutionContext): Actor | null => {
  return context.switchToHttp().getRequest<AuthedRequest>().actor ?? null;
});

export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new AppError(401, 'authentication_required', 'You must be signed in.');
  return actor;
}
```

Add to `apps/api/src/authn/auth.service.ts`:

```ts
  async login(usernameOrEmail: string, password: string): Promise<typeof schema.users.$inferSelect> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(
        sql`lower(${schema.users.username}) = lower(${usernameOrEmail})
            or lower(${schema.users.email}) = lower(${usernameOrEmail})`,
      )
      .limit(1);

    const user = rows[0];
    if (!user) {
      // Burn comparable time when the account does not exist, so response
      // latency does not disclose which usernames are registered.
      await this.passwords.hash(password);
      throw new AppError(401, 'invalid_credentials', 'Incorrect username or password.');
    }
    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok || user.status !== 'active') {
      throw new AppError(401, 'invalid_credentials', 'Incorrect username or password.');
    }
    return user;
  }

  async loadUser(userId: number): Promise<typeof schema.users.$inferSelect> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) throw new AppError(401, 'authentication_required', 'You must be signed in.');
    return user;
  }
```

and widen the existing drizzle import at the top of the file to `import { eq, sql } from 'drizzle-orm';`.

Replace `apps/api/src/authn/auth.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  LoginRequest,
  RegisterRequest,
  type LoginRequestDto,
  type MeResponseDto,
  type RegisterRequestDto,
} from '@qhhoj/contracts';
import { Inject, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import type { Actor } from '../authz/actor.js';
import { AuthService, toMe } from './auth.service.js';
import { SessionService } from './session.service.js';
import { AuthGuard, CurrentActor, requireActor } from './auth.guard.js';

@Controller('auth')
@UseGuards(AuthGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('register')
  @HttpCode(201)
  register(
    @Body(new ZodValidationPipe(RegisterRequest)) body: RegisterRequestDto,
  ): Promise<MeResponseDto> {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequest)) body: LoginRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: MeResponseDto }> {
    const user = await this.auth.login(body.usernameOrEmail, body.password);
    const { token, expiresAt } = await this.sessions.issue(user.id, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.cookie(this.config.sessionCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
      path: '/',
      expires: expiresAt,
    });
    return { user: toMe(user, false) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = req.cookies?.[this.config.sessionCookieName] as string | undefined;
    if (token) await this.sessions.revoke(token);
    res.clearCookie(this.config.sessionCookieName, { path: '/' });
  }

  @Get('me')
  async me(@CurrentActor() actor: Actor | null): Promise<MeResponseDto> {
    const user = await this.auth.loadUser(requireActor(actor).userId);
    return toMe(user, false);
  }
}
```

Register `SessionService` and `AuthGuard` as providers in `authn.module.ts` and export `SessionService`.

In `apps/api/src/main.ts`, before the global prefix:

```ts
import cookieParser from 'cookie-parser';
// ...
app.use(cookieParser());
```

- [ ] **Step 7: Add the endpoint test**

Append to `apps/api/test/session.spec.ts`:

```ts
describe('login / logout / me', () => {
  it('logs in, reads me with the cookie, then logs out and is rejected', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());

      await agent.post('/auth/register').send({
        username: 'kim',
        email: 'kim@example.com',
        password: 'a-long-enough-password',
        displayName: 'Kim',
      });

      const login = await agent
        .post('/auth/login')
        .send({ usernameOrEmail: 'kim', password: 'a-long-enough-password' });
      expect(login.status).toBe(200);
      expect(login.headers['set-cookie'][0]).toContain('HttpOnly');

      const me = await agent.get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.username).toBe('kim');

      expect((await agent.post('/auth/logout')).status).toBe(204);
      expect((await agent.get('/auth/me')).status).toBe(401);
      await app.close();
    });
  }, 120_000);

  it('rejects a wrong password with invalid_credentials, not user_not_found', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      await agent.post('/auth/register').send({
        username: 'lee',
        email: 'lee@example.com',
        password: 'a-long-enough-password',
        displayName: 'Lee',
      });
      const res = await agent
        .post('/auth/login')
        .send({ usernameOrEmail: 'lee', password: 'wrong-password-here' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      await app.close();
    });
  }, 120_000);

  it('gives the same code for an unknown user as for a wrong password', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ usernameOrEmail: 'nobody', password: 'whatever-password' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      await app.close();
    });
  }, 120_000);
});
```

Add these imports at the top of the same spec file:

```ts
import request from 'supertest';
import { buildApp } from './app.harness.js';
```

`buildApp` already installs `cookie-parser`, which the agent-based cookie flow above depends on.

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @qhhoj/api test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): opaque session cookies with login, logout and me"
```

---

## Task 9: TOTP two-factor authentication

**Files:**
- Create: `apps/api/src/authn/totp.service.ts`, `apps/api/src/authn/totp.controller.ts`
- Create: `apps/api/test/totp.spec.ts`
- Modify: `apps/api/src/authn/auth.service.ts`, `apps/api/src/authn/auth.controller.ts`, `apps/api/src/authn/authn.module.ts`

**Interfaces:**
- Consumes: `schema.totpCredentials`, `AppConfig.totpEncKey`.
- Produces:
  - `TotpService.beginEnrolment(userId): Promise<{ secret: string; otpauthUrl: string }>`
  - `TotpService.confirmEnrolment(userId, code): Promise<void>`
  - `TotpService.isEnabled(userId): Promise<boolean>`
  - `TotpService.verify(userId, code): Promise<boolean>`
  - `POST /auth/totp/begin`, `POST /auth/totp/confirm`, `DELETE /auth/totp`
  - Login gains a `totp_required` 401 when a confirmed credential exists and no code was supplied.

- [ ] **Step 1: Install otplib**

```bash
pnpm --filter @qhhoj/api add @otplib/preset-default
```

- [ ] **Step 2: Write the failing test**

`apps/api/test/totp.spec.ts`:

```ts
import { authenticator } from '@otplib/preset-default';
import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@qhhoj/db';
import { TotpService } from '../src/authn/totp.service.js';
import type { AppConfig } from '../src/config/config.schema.js';
import { TEST_CONFIG } from './app.harness.js';
import { withTestDb } from './db.harness.js';

const config: AppConfig = { ...TEST_CONFIG, totpEncKey: Buffer.alloc(32, 7) };

async function makeUser(db: Db, username: string): Promise<number> {
  const [user] = await db
    .insert(schema.users)
    .values({ username, email: `${username}@e.com`, passwordHash: 'x', displayName: username })
    .returning();
  return user!.id;
}

describe('TotpService', () => {
  it('is disabled until enrolment is confirmed', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'mia');
      const service = new TotpService(db, config);

      await service.beginEnrolment(userId);
      expect(await service.isEnabled(userId)).toBe(false);
    });
  }, 120_000);

  it('confirms with a valid code and then verifies', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'nina');
      const service = new TotpService(db, config);

      const { secret } = await service.beginEnrolment(userId);
      await service.confirmEnrolment(userId, authenticator.generate(secret));

      expect(await service.isEnabled(userId)).toBe(true);
      expect(await service.verify(userId, authenticator.generate(secret))).toBe(true);
    });
  }, 120_000);

  it('rejects an incorrect confirmation code', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'omar');
      const service = new TotpService(db, config);
      await service.beginEnrolment(userId);
      await expect(service.confirmEnrolment(userId, '000000')).rejects.toThrow(/invalid_totp_code/);
    });
  }, 120_000);

  it('stores the secret encrypted, not in plaintext', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'pia');
      const service = new TotpService(db, config);
      const { secret } = await service.beginEnrolment(userId);

      const rows = await db.select().from(schema.totpCredentials);
      expect(rows[0]?.secretEnc).not.toContain(secret);
    });
  }, 120_000);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/api test totp`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the service**

`apps/api/src/authn/totp.service.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { authenticator } from '@otplib/preset-default';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import { APP_CONFIG, DB } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { AppError } from '../common/app.error.js';

const ISSUER = 'QHH Online Judge';

@Injectable()
export class TotpService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async beginEnrolment(userId: number): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = authenticator.generateSecret();
    const secretEnc = this.encrypt(secret);
    await this.db
      .insert(schema.totpCredentials)
      .values({ userId, secretEnc })
      .onConflictDoUpdate({
        target: schema.totpCredentials.userId,
        set: { secretEnc, confirmedAt: null },
      });
    return { secret, otpauthUrl: authenticator.keyuri(String(userId), ISSUER, secret) };
  }

  async confirmEnrolment(userId: number, code: string): Promise<void> {
    const secret = await this.secretFor(userId);
    if (!secret || !authenticator.verify({ token: code, secret })) {
      throw new AppError(422, 'invalid_totp_code', 'That code is not valid.');
    }
    await this.db
      .update(schema.totpCredentials)
      .set({ confirmedAt: new Date() })
      .where(eq(schema.totpCredentials.userId, userId));
  }

  async disable(userId: number): Promise<void> {
    await this.db.delete(schema.totpCredentials).where(eq(schema.totpCredentials.userId, userId));
  }

  async isEnabled(userId: number): Promise<boolean> {
    const rows = await this.db
      .select({ confirmedAt: schema.totpCredentials.confirmedAt })
      .from(schema.totpCredentials)
      .where(eq(schema.totpCredentials.userId, userId))
      .limit(1);
    return rows[0]?.confirmedAt != null;
  }

  async verify(userId: number, code: string): Promise<boolean> {
    if (!(await this.isEnabled(userId))) return true;
    const secret = await this.secretFor(userId);
    return secret ? authenticator.verify({ token: code, secret }) : false;
  }

  private async secretFor(userId: number): Promise<string | null> {
    const rows = await this.db
      .select({ secretEnc: schema.totpCredentials.secretEnc })
      .from(schema.totpCredentials)
      .where(eq(schema.totpCredentials.userId, userId))
      .limit(1);
    return rows[0] ? this.decrypt(rows[0].secretEnc) : null;
  }

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.totpEncKey, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }

  private decrypt(payload: string): string {
    const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.config.totpEncKey, iv!);
    decipher.setAuthTag(tag!);
    return Buffer.concat([decipher.update(enc!), decipher.final()]).toString('utf8');
  }
}
```

- [ ] **Step 5: Gate login on TOTP**

In `apps/api/src/authn/auth.controller.ts`, inside `login`, after `const user = await this.auth.login(...)`:

```ts
    if (await this.totp.isEnabled(user.id)) {
      if (!body.totpCode) {
        throw new AppError(401, 'totp_required', 'A two-factor code is required.');
      }
      if (!(await this.totp.verify(user.id, body.totpCode))) {
        throw new AppError(401, 'invalid_totp_code', 'That code is not valid.');
      }
    }
```

and return `toMe(user, await this.totp.isEnabled(user.id))` from both `login` and `me`. Inject `TotpService` into the controller and register it in `authn.module.ts`.

`apps/api/src/authn/totp.controller.ts`:

```ts
import { Body, Controller, Delete, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import type { Actor } from '../authz/actor.js';
import { AuthGuard, CurrentActor, requireActor } from './auth.guard.js';
import { TotpService } from './totp.service.js';

const ConfirmRequest = z.object({ code: z.string().regex(/^\d{6}$/) });

@Controller('auth/totp')
@UseGuards(AuthGuard)
export class TotpController {
  constructor(private readonly totp: TotpService) {}

  @Post('begin')
  @HttpCode(200)
  begin(@CurrentActor() actor: Actor | null): Promise<{ secret: string; otpauthUrl: string }> {
    return this.totp.beginEnrolment(requireActor(actor).userId);
  }

  @Post('confirm')
  @HttpCode(204)
  confirm(
    @CurrentActor() actor: Actor | null,
    @Body(new ZodValidationPipe(ConfirmRequest)) body: z.infer<typeof ConfirmRequest>,
  ): Promise<void> {
    return this.totp.confirmEnrolment(requireActor(actor).userId, body.code);
  }

  @Delete()
  @HttpCode(204)
  disable(@CurrentActor() actor: Actor | null): Promise<void> {
    return this.totp.disable(requireActor(actor).userId);
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @qhhoj/api test totp`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): totp two-factor enrolment and login gate"
```

---

## Task 10: Personal access tokens

**Files:**
- Create: `apps/api/src/authn/token.service.ts`, `apps/api/src/authn/tokens.controller.ts`
- Create: `apps/api/test/tokens.spec.ts`
- Modify: `apps/api/src/authn/auth.guard.ts`, `apps/api/src/authn/authn.module.ts`, `packages/contracts/src/tokens.ts`, `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `schema.accessTokens`, `hashToken` from `session.service.ts`.
- Produces:
  - `TokenService.issue(userId, name, scopes, expiresAt?): Promise<{ id: number; token: string }>`
  - `TokenService.resolve(token): Promise<Actor | null>`
  - `TokenService.list(userId)`, `TokenService.revoke(userId, id)`
  - `POST /auth/tokens`, `GET /auth/tokens`, `DELETE /auth/tokens/:id`
  - `AuthGuard` now also accepts `Authorization: Bearer <token>`

- [ ] **Step 1: Write the failing test**

`apps/api/test/tokens.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@qhhoj/db';
import { TokenService } from '../src/authn/token.service.js';
import { withTestDb } from './db.harness.js';

async function makeUser(db: Db, username: string): Promise<number> {
  const [user] = await db
    .insert(schema.users)
    .values({ username, email: `${username}@e.com`, passwordHash: 'x', displayName: username })
    .returning();
  return user!.id;
}

describe('TokenService', () => {
  it('issues a token that resolves to a token-backed actor', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'quin');
      const service = new TokenService(db);
      const { token } = await service.issue(userId, 'cli', ['submissions:write']);

      const actor = await service.resolve(token);
      expect(actor?.userId).toBe(userId);
      expect(actor?.via).toBe('token');
      expect(actor?.scopes).toEqual(['submissions:write']);
    });
  }, 120_000);

  it('stores only a hash', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'rosa');
      const service = new TokenService(db);
      const { token } = await service.issue(userId, 'cli', []);
      const rows = await db.select().from(schema.accessTokens);
      expect(rows[0]?.tokenHash).not.toBe(token);
    });
  }, 120_000);

  it('returns null for a revoked token', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'sami');
      const service = new TokenService(db);
      const { id, token } = await service.issue(userId, 'cli', []);
      await service.revoke(userId, id);
      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);

  it('returns null for an expired token', async () => {
    await withTestDb(async (db) => {
      const userId = await makeUser(db, 'tara');
      const service = new TokenService(db);
      const { token } = await service.issue(userId, 'cli', [], new Date(Date.now() - 1000));
      expect(await service.resolve(token)).toBeNull();
    });
  }, 120_000);

  it('does not let one user revoke another user\'s token', async () => {
    await withTestDb(async (db) => {
      const owner = await makeUser(db, 'uma');
      const other = await makeUser(db, 'vlad');
      const service = new TokenService(db);
      const { id, token } = await service.issue(owner, 'cli', []);
      await service.revoke(other, id);
      expect(await service.resolve(token)).not.toBeNull();
    });
  }, 120_000);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/api test tokens`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the service**

`apps/api/src/authn/token.service.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import { DB } from '../config/config.module.js';
import type { Actor } from '../authz/actor.js';
import { hashToken } from './session.service.js';

export const TOKEN_PREFIX = 'qhh_';

@Injectable()
export class TokenService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async issue(
    userId: number,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ): Promise<{ id: number; token: string }> {
    const token = TOKEN_PREFIX + randomBytes(24).toString('base64url');
    const [row] = await this.db
      .insert(schema.accessTokens)
      .values({ userId, name, scopes, tokenHash: hashToken(token), expiresAt: expiresAt ?? null })
      .returning({ id: schema.accessTokens.id });
    return { id: row!.id, token };
  }

  async resolve(token: string): Promise<Actor | null> {
    const rows = await this.db
      .select({
        id: schema.accessTokens.id,
        userId: schema.users.id,
        globalRole: schema.users.globalRole,
        scopes: schema.accessTokens.scopes,
      })
      .from(schema.accessTokens)
      .innerJoin(schema.users, eq(schema.users.id, schema.accessTokens.userId))
      .where(
        and(
          eq(schema.accessTokens.tokenHash, hashToken(token)),
          or(isNull(schema.accessTokens.expiresAt), gt(schema.accessTokens.expiresAt, new Date())),
          eq(schema.users.status, 'active'),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    await this.db
      .update(schema.accessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.accessTokens.id, row.id));
    return { userId: row.userId, globalRole: row.globalRole, via: 'token', scopes: row.scopes };
  }

  list(userId: number) {
    return this.db
      .select({
        id: schema.accessTokens.id,
        name: schema.accessTokens.name,
        scopes: schema.accessTokens.scopes,
        lastUsedAt: schema.accessTokens.lastUsedAt,
        expiresAt: schema.accessTokens.expiresAt,
        createdAt: schema.accessTokens.createdAt,
      })
      .from(schema.accessTokens)
      .where(eq(schema.accessTokens.userId, userId));
  }

  async revoke(userId: number, id: number): Promise<void> {
    await this.db
      .delete(schema.accessTokens)
      .where(and(eq(schema.accessTokens.id, id), eq(schema.accessTokens.userId, userId)));
  }
}
```

- [ ] **Step 4: Teach the guard about bearer tokens**

In `apps/api/src/authn/auth.guard.ts`, add `import { TokenService } from './token.service.js';`, then replace the constructor and `canActivate`:

```ts
  constructor(
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) {
      const actor = await this.tokens.resolve(header.slice('Bearer '.length));
      if (actor) req.actor = actor;
      return true;
    }

    const cookie = req.cookies?.[this.config.sessionCookieName] as string | undefined;
    if (cookie) {
      const actor = await this.sessions.resolve(cookie);
      if (actor) req.actor = actor;
    }
    return true;
  }
```

- [ ] **Step 5: Add the contracts and controller**

`packages/contracts/src/tokens.ts`:

```ts
import { z } from 'zod';
import { Timestamp } from './common.js';

export const CreateTokenRequest = z.object({
  name: z.string().min(1).max(64),
  scopes: z.array(z.string()).default([]),
  expiresAt: Timestamp.optional(),
});
export type CreateTokenRequestDto = z.infer<typeof CreateTokenRequest>;

export const CreateTokenResponse = z.object({
  id: z.number().int(),
  /** Returned exactly once, at creation. */
  token: z.string(),
});

export const TokenSummary = z.object({
  id: z.number().int(),
  name: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
```

Add `export * from './tokens.js';` to `packages/contracts/src/index.ts`.

`apps/api/src/authn/tokens.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { CreateTokenRequest, type CreateTokenRequestDto } from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import type { Actor } from '../authz/actor.js';
import { AuthGuard, CurrentActor, requireActor } from './auth.guard.js';
import { TokenService } from './token.service.js';

@Controller('auth/tokens')
@UseGuards(AuthGuard)
export class TokensController {
  constructor(private readonly tokens: TokenService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentActor() actor: Actor | null,
    @Body(new ZodValidationPipe(CreateTokenRequest)) body: CreateTokenRequestDto,
  ): Promise<{ id: number; token: string }> {
    return this.tokens.issue(
      requireActor(actor).userId,
      body.name,
      body.scopes,
      body.expiresAt ? new Date(body.expiresAt) : undefined,
    );
  }

  @Get()
  list(@CurrentActor() actor: Actor | null) {
    return this.tokens.list(requireActor(actor).userId);
  }

  @Delete(':id')
  @HttpCode(204)
  revoke(
    @CurrentActor() actor: Actor | null,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.tokens.revoke(requireActor(actor).userId, id);
  }
}
```

Register `TokenService` and `TokensController` in `authn.module.ts`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @qhhoj/api test tokens`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): personal access tokens with bearer authentication"
```

---

## Task 11: Authorization module and the import-boundary rule

**Files:**
- Create: `apps/api/src/authz/org.access.ts`, `apps/api/src/authz/authz.module.ts`, `apps/api/src/orgs/orgs.controller.ts`, `apps/api/src/orgs/orgs.module.ts`
- Modify: `eslint.config.js`, `apps/api/src/app.module.ts`, `packages/contracts/src/orgs.ts`, `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `organizations`, `orgMembers` from `@qhhoj/db/guarded`; `Actor`.
- Produces:
  - `OrgAccessService.listVisible(actor, page): Promise<{ items: OrgSummaryDto[]; nextCursor: string | null }>`
  - `OrgAccessService.getVisible(actor, slug): Promise<OrgSummaryDto>` — throws 404 for an invisible private org
  - `OrgAccessService.roleIn(actor, orgId): Promise<'owner'|'admin'|'member'|null>`
  - `GET /orgs`, `GET /orgs/:slug`
  - An ESLint rule making `@qhhoj/db/guarded` importable only from `apps/api/src/authz/**`

- [ ] **Step 1: Write the contract**

`packages/contracts/src/orgs.ts`:

```ts
import { z } from 'zod';
import { Timestamp, cursorPage } from './common.js';

export const OrgSummary = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  about: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  joinPolicy: z.enum(['open', 'request', 'invite']),
  createdAt: Timestamp,
});
export type OrgSummaryDto = z.infer<typeof OrgSummary>;

export const OrgPage = cursorPage(OrgSummary);
```

Add `export * from './orgs.js';` to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing test**

`apps/api/test/leakage/orgs.spec.ts` — deliberately asserts the **exact** visible set, not merely that access is denied:

```ts
import { describe, expect, it } from 'vitest';
import { organizations, orgMembers } from '@qhhoj/db/guarded';
import type { Db } from '@qhhoj/db';
import { schema } from '@qhhoj/db';
import { OrgAccessService } from '../../src/authz/org.access.js';
import type { Actor } from '../../src/authz/actor.js';
import { withTestDb } from '../db.harness.js';

async function seed(db: Db) {
  const [member] = await db
    .insert(schema.users)
    .values({ username: 'm', email: 'm@e.com', passwordHash: 'x', displayName: 'M' })
    .returning();
  const [outsider] = await db
    .insert(schema.users)
    .values({ username: 'o', email: 'o@e.com', passwordHash: 'x', displayName: 'O' })
    .returning();
  const [admin] = await db
    .insert(schema.users)
    .values({
      username: 'a',
      email: 'a@e.com',
      passwordHash: 'x',
      displayName: 'A',
      globalRole: 'admin',
    })
    .returning();

  const [pub] = await db
    .insert(organizations)
    .values({ slug: 'open-club', name: 'Open Club', visibility: 'public' })
    .returning();
  const [priv] = await db
    .insert(organizations)
    .values({ slug: 'secret-club', name: 'Secret Club', visibility: 'private' })
    .returning();

  await db.insert(orgMembers).values({ orgId: priv!.id, userId: member!.id, role: 'member' });

  return {
    actors: {
      anonymous: null,
      member: { userId: member!.id, globalRole: 'user', via: 'session', scopes: [] } as Actor,
      outsider: { userId: outsider!.id, globalRole: 'user', via: 'session', scopes: [] } as Actor,
      admin: { userId: admin!.id, globalRole: 'admin', via: 'session', scopes: [] } as Actor,
    },
    slugs: { pub: pub!.slug, priv: priv!.slug },
  };
}

const EXPECTED_VISIBLE: Record<string, string[]> = {
  anonymous: ['open-club'],
  member: ['open-club', 'secret-club'],
  outsider: ['open-club'],
  admin: ['open-club', 'secret-club'],
};

describe('organization visibility leakage matrix', () => {
  it('shows each actor exactly the organizations it may see', async () => {
    await withTestDb(async (db) => {
      const { actors } = await seed(db);
      const service = new OrgAccessService(db);

      for (const [name, actor] of Object.entries(actors)) {
        const page = await service.listVisible(actor, { limit: 50 });
        expect(page.items.map((o) => o.slug).sort(), `actor: ${name}`).toEqual(
          EXPECTED_VISIBLE[name]!.slice().sort(),
        );
      }
    });
  }, 120_000);

  it('returns 404 — not 403 — for a private org an actor cannot see', async () => {
    await withTestDb(async (db) => {
      const { actors, slugs } = await seed(db);
      const service = new OrgAccessService(db);

      await expect(service.getVisible(actors.outsider, slugs.priv)).rejects.toMatchObject({
        status: 404,
        code: 'organization_not_found',
      });
      await expect(service.getVisible(null, slugs.priv)).rejects.toMatchObject({ status: 404 });
    });
  }, 120_000);

  it('lets a member and an admin fetch the private org', async () => {
    await withTestDb(async (db) => {
      const { actors, slugs } = await seed(db);
      const service = new OrgAccessService(db);

      expect((await service.getVisible(actors.member, slugs.priv)).slug).toBe('secret-club');
      expect((await service.getVisible(actors.admin, slugs.priv)).slug).toBe('secret-club');
    });
  }, 120_000);

  it('reports membership role only for actual members', async () => {
    await withTestDb(async (db) => {
      const { actors, slugs } = await seed(db);
      const service = new OrgAccessService(db);
      const org = await service.getVisible(actors.member, slugs.priv);

      expect(await service.roleIn(actors.member, org.id)).toBe('member');
      expect(await service.roleIn(actors.outsider, org.id)).toBeNull();
      expect(await service.roleIn(null, org.id)).toBeNull();
    });
  }, 120_000);
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/api test leakage`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the access service**

`apps/api/src/authz/org.access.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { organizations, orgMembers } from '@qhhoj/db/guarded';
import type { Db } from '@qhhoj/db';
import type { OrgSummaryDto, PaginationQueryDto } from '@qhhoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { isAdmin, type Actor } from './actor.js';

/**
 * The ONLY module permitted to import `@qhhoj/db/guarded`. Every read of an
 * organization anywhere in the API goes through here, so visibility cannot be
 * forgotten at a call site.
 */
@Injectable()
export class OrgAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** An org is visible when it is public, the actor is a member, or the actor is an admin. */
  private visibilityCondition(actor: Actor | null) {
    if (isAdmin(actor)) return sql`true`;
    if (!actor) return eq(organizations.visibility, 'public');
    const memberOrgIds = this.db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, actor.userId));
    return or(eq(organizations.visibility, 'public'), inArray(organizations.id, memberOrgIds))!;
  }

  async listVisible(
    actor: Actor | null,
    page: Pick<PaginationQueryDto, 'limit'> & { cursor?: string },
  ): Promise<{ items: OrgSummaryDto[]; nextCursor: string | null }> {
    const after = page.cursor ? Number(page.cursor) : 0;
    const rows = await this.db
      .select()
      .from(organizations)
      .where(and(this.visibilityCondition(actor), gt(organizations.id, after)))
      .orderBy(asc(organizations.id))
      .limit(page.limit + 1);

    const items = rows.slice(0, page.limit).map(toOrgSummary);
    const nextCursor = rows.length > page.limit ? String(items.at(-1)!.id) : null;
    return { items, nextCursor };
  }

  async getVisible(actor: Actor | null, slug: string): Promise<OrgSummaryDto> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(and(this.visibilityCondition(actor), sql`lower(${organizations.slug}) = lower(${slug})`))
      .limit(1);

    // 404 rather than 403: a private organization must not disclose its existence.
    if (!rows[0]) {
      throw new AppError(404, 'organization_not_found', 'No such organization.');
    }
    return toOrgSummary(rows[0]);
  }

  async roleIn(actor: Actor | null, orgId: number): Promise<'owner' | 'admin' | 'member' | null> {
    if (!actor) return null;
    const rows = await this.db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, actor.userId)))
      .limit(1);
    return rows[0]?.role ?? null;
  }
}

function toOrgSummary(row: typeof organizations.$inferSelect): OrgSummaryDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    about: row.about,
    visibility: row.visibility,
    joinPolicy: row.joinPolicy,
    createdAt: row.createdAt.toISOString(),
  };
}
```

`apps/api/src/authz/authz.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { OrgAccessService } from './org.access.js';

@Module({
  imports: [ConfigModule],
  providers: [OrgAccessService],
  exports: [OrgAccessService],
})
export class AuthzModule {}
```

`apps/api/src/orgs/orgs.controller.ts`:

```ts
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PaginationQuery, type OrgSummaryDto, type PaginationQueryDto } from '@qhhoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { AuthGuard, CurrentActor } from '../authn/auth.guard.js';
import type { Actor } from '../authz/actor.js';
import { OrgAccessService } from '../authz/org.access.js';

@Controller('orgs')
@UseGuards(AuthGuard)
export class OrgsController {
  constructor(private readonly orgs: OrgAccessService) {}

  @Get()
  list(
    @CurrentActor() actor: Actor | null,
    @Query(new ZodValidationPipe(PaginationQuery)) query: PaginationQueryDto,
  ): Promise<{ items: OrgSummaryDto[]; nextCursor: string | null }> {
    return this.orgs.listVisible(actor, query);
  }

  @Get(':slug')
  get(@CurrentActor() actor: Actor | null, @Param('slug') slug: string): Promise<OrgSummaryDto> {
    return this.orgs.getVisible(actor, slug);
  }
}
```

`apps/api/src/orgs/orgs.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { OrgsController } from './orgs.controller.js';

@Module({ imports: [AuthnModule, AuthzModule], controllers: [OrgsController] })
export class OrgsModule {}
```

Add `AuthzModule` and `OrgsModule` to `app.module.ts` imports.

- [ ] **Step 5: Run the leakage tests**

Run: `pnpm --filter @qhhoj/api test leakage`
Expected: PASS (4 tests).

- [ ] **Step 6: Add the ESLint import-boundary rule**

Replace `eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const GUARDED_MESSAGE =
  'Guarded tables may only be imported from apps/api/src/authz/**. ' +
  'Add a method to the relevant *.access.ts service instead of querying directly — ' +
  'see spec §8, "No handler filters visibility by hand".';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/migrations/**', '**/src/generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: '@qhhoj/db/guarded', message: GUARDED_MESSAGE }] },
      ],
    },
  },
  {
    files: ['apps/api/src/authz/**/*.ts', 'apps/api/test/**/*.ts', 'packages/db/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
```

- [ ] **Step 7: Prove the rule actually fires**

```bash
cat > /tmp/violation.ts <<'EOF'
import { organizations } from '@qhhoj/db/guarded';
export const t = organizations;
EOF
cp /tmp/violation.ts apps/api/src/orgs/violation.ts
pnpm lint
```

Expected: FAIL, citing `no-restricted-imports` with the guarded message. Then:

```bash
rm apps/api/src/orgs/violation.ts
pnpm lint
```

Expected: PASS. **Do not skip this step** — a boundary rule that silently matches nothing is worse than no rule, because it advertises a guarantee it does not provide.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(api): centralised org visibility with an enforced import boundary"
```

---

## Task 12: OpenAPI emission and the SDK package

**Files:**
- Create: `packages/contracts/scripts/emit-openapi.ts`, `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`
- Create: `packages/sdk/test/client.spec.ts`
- Modify: `packages/contracts/src/auth.ts`, `packages/contracts/src/orgs.ts` (register paths)

**Interfaces:**
- Consumes: `registry`, `openApiDocument` from `@qhhoj/contracts`.
- Produces:
  - `openapi.json` at the repo root (generated, committed)
  - `packages/sdk/src/generated.ts` (generated by `openapi-typescript`, committed)
  - `createClient({ baseUrl, token? })` returning a typed `openapi-fetch` client

- [ ] **Step 1: Create the SDK package, then install dependencies**

`packages/sdk/package.json`:

```json
{
  "name": "@qhhoj/sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint src test",
    "test": "vitest run",
    "generate": "openapi-typescript ../../openapi.json -o src/generated.ts"
  }
}
```

`packages/sdk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "lib": ["ES2023", "DOM"] },
  "include": ["src"]
}
```

```bash
pnpm --filter @qhhoj/contracts add -D tsx
pnpm --filter @qhhoj/sdk add openapi-fetch
pnpm --filter @qhhoj/sdk add -D openapi-typescript
```

- [ ] **Step 2: Register the paths**

Append to `packages/contracts/src/auth.ts`:

```ts
import { registry } from './registry.js';
import { ProblemDetails } from './common.js';

registry.registerPath({
  method: 'post',
  path: '/auth/login',
  summary: 'Sign in and receive a session cookie',
  request: { body: { content: { 'application/json': { schema: LoginRequest } } } },
  responses: {
    200: { description: 'Signed in', content: { 'application/json': { schema: LoginResponse } } },
    401: {
      description: 'Invalid credentials or a TOTP code is required',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/auth/me',
  summary: 'The signed-in user',
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: MeResponse } } },
    401: {
      description: 'Not signed in',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    },
  },
});
```

Append to `packages/contracts/src/orgs.ts`:

```ts
import { registry } from './registry.js';

registry.registerPath({
  method: 'get',
  path: '/orgs',
  summary: 'Organizations visible to the caller',
  responses: {
    200: { description: 'A page of organizations', content: { 'application/json': { schema: OrgPage } } },
  },
});
```

- [ ] **Step 3: Write the emitter**

`packages/contracts/scripts/emit-openapi.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '../src/index.js';

const target = fileURLToPath(new URL('../../../openapi.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
console.log(`wrote ${target}`);
```

- [ ] **Step 4: Write the failing SDK test**

`packages/sdk/test/client.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/index.js';

describe('createClient', () => {
  it('resolves paths against the configured base url', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createClient({ baseUrl: 'http://api.test/api/v1', fetch: fetchMock });

    await client.GET('/auth/me');

    const req = fetchMock.mock.calls[0]?.[0] as Request;
    expect(req.url).toBe('http://api.test/api/v1/auth/me');
  });

  it('attaches a bearer token when one is supplied', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createClient({
      baseUrl: 'http://api.test/api/v1',
      token: 'qhh_abc',
      fetch: fetchMock,
    });

    await client.GET('/auth/me');

    const req = fetchMock.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('authorization')).toBe('Bearer qhh_abc');
  });
});
```

- [ ] **Step 5: Generate types and write the client**

```bash
pnpm --filter @qhhoj/contracts openapi
pnpm --filter @qhhoj/sdk exec openapi-typescript ../../openapi.json -o src/generated.ts
```

`packages/sdk/src/client.ts`:

```ts
import createOpenApiClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated.js';

export interface ClientOptions {
  baseUrl: string;
  /** Personal access token for SDK/CLI use. Browsers rely on the session cookie instead. */
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export function createClient(options: ClientOptions) {
  const client = createOpenApiClient<paths>({
    baseUrl: options.baseUrl,
    credentials: 'include',
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  if (options.token) {
    const auth: Middleware = {
      onRequest({ request }) {
        request.headers.set('authorization', `Bearer ${options.token}`);
        return request;
      },
    };
    client.use(auth);
  }

  return client;
}
```

`packages/sdk/src/index.ts`:

```ts
export { createClient, type ClientOptions } from './client.js';
export type { paths, components } from './generated.js';
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @qhhoj/sdk test`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(sdk): openapi emission and typed fetch client"
```

---

## Task 13: Minimal web SPA

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/api.ts`, `apps/web/src/router.tsx`, `apps/web/src/routes/login.tsx`, `apps/web/src/routes/index.tsx`
- Create: `apps/web/test/login.spec.tsx`

**Interfaces:**
- Consumes: `createClient` from `@qhhoj/sdk`.
- Produces: a Vite build at `apps/web/dist`, served by Caddy in Task 15.

**Scope note:** deliberately unstyled and minimal. Its only job is to prove the contracts → OpenAPI → SDK → frontend loop compiles and works end to end. The component library and i18n library are open questions in spec §15 and are **not** decided here.

- [ ] **Step 1: Create the web package, then install dependencies**

`apps/web/package.json`:

```json
{
  "name": "@qhhoj/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -b",
    "lint": "eslint src test",
    "test": "vitest run",
    "dev": "vite",
    "build": "vite build"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "composite": false,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

```bash
pnpm --filter @qhhoj/web add react react-dom @tanstack/react-router @tanstack/react-query @qhhoj/sdk@workspace:*
pnpm --filter @qhhoj/web add -D vite @vitejs/plugin-react @types/react @types/react-dom \
  @testing-library/react @testing-library/user-event jsdom
```

- [ ] **Step 2: Write the failing test**

`apps/web/test/login.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginForm } from '../src/routes/login.js';

describe('LoginForm', () => {
  it('submits the entered credentials', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<LoginForm onSubmit={onSubmit} error={null} />);

    await userEvent.type(screen.getByLabelText(/username or email/i), 'kim');
    await userEvent.type(screen.getByLabelText(/^password/i), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      usernameOrEmail: 'kim',
      password: 'a-long-enough-password',
      totpCode: undefined,
    });
  });

  it('shows the server error message', () => {
    render(<LoginForm onSubmit={vi.fn()} error="Incorrect username or password." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect username or password.');
  });

  it('reveals the TOTP field only when the server asks for it', async () => {
    const { rerender } = render(<LoginForm onSubmit={vi.fn()} error={null} />);
    expect(screen.queryByLabelText(/two-factor code/i)).toBeNull();

    rerender(<LoginForm onSubmit={vi.fn()} error="A two-factor code is required." needsTotp />);
    expect(screen.getByLabelText(/two-factor code/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @qhhoj/web test`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the app**

`apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: false, setupFiles: ['./test/setup.ts'] },
});
```

`apps/web/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

(install with `pnpm --filter @qhhoj/web add -D @testing-library/jest-dom`)

`apps/web/src/api.ts`:

```ts
import { createClient } from '@qhhoj/sdk';

export const api = createClient({
  baseUrl: `${import.meta.env.VITE_API_ORIGIN ?? ''}/api/v1`,
});
```

`apps/web/src/routes/login.tsx`:

```tsx
import { useState, type FormEvent } from 'react';

export interface LoginValues {
  usernameOrEmail: string;
  password: string;
  totpCode: string | undefined;
}

export function LoginForm(props: {
  onSubmit: (values: LoginValues) => Promise<void>;
  error: string | null;
  needsTotp?: boolean;
}) {
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    void props.onSubmit({
      usernameOrEmail,
      password,
      totpCode: totpCode === '' ? undefined : totpCode,
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      {props.error ? <p role="alert">{props.error}</p> : null}
      <label htmlFor="identifier">Username or email</label>
      <input
        id="identifier"
        value={usernameOrEmail}
        onChange={(e) => setUsernameOrEmail(e.target.value)}
      />
      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {props.needsTotp ? (
        <>
          <label htmlFor="totp">Two-factor code</label>
          <input id="totp" inputMode="numeric" value={totpCode} onChange={(e) => setTotpCode(e.target.value)} />
        </>
      ) : null}
      <button type="submit">Sign in</button>
    </form>
  );
}
```

`apps/web/src/routes/index.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';

export function Home() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.GET('/auth/me');
      return data ?? null;
    },
  });

  if (me.isLoading) return <p>Loading…</p>;
  if (!me.data) return <p>Not signed in.</p>;
  return <p>Signed in as {me.data.displayName}.</p>;
}
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QHH Online Judge</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Home } from './routes/index.js';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Home />
    </QueryClientProvider>
  </StrictMode>,
);
```

**Router note:** TanStack Router is installed and is the spec's choice, but Phase 0 has two screens and wiring a route tree here would be scaffolding without a consumer. Routing is introduced in Phase 1, when the walking skeleton adds problem and submission screens.

- [ ] **Step 5: Run the tests and the build**

```bash
pnpm --filter @qhhoj/web test
pnpm --filter @qhhoj/web exec vite build
```

Expected: 3 tests PASS, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): minimal spa proving the contracts to sdk to frontend loop"
```

---

## Task 14: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: workspace scripts from Task 1.
- Produces: a CI gate on push and pull request.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm -r typecheck

      - name: Lint
        run: pnpm -r lint

      - name: Test
        run: pnpm -r test
        env:
          # Testcontainers uses the Docker daemon preinstalled on the runner.
          TESTCONTAINERS_RYUK_DISABLED: 'true'

      - name: Verify OpenAPI and SDK are up to date
        run: |
          pnpm --filter @qhhoj/contracts openapi
          pnpm --filter @qhhoj/sdk exec openapi-typescript ../../openapi.json -o src/generated.ts
          git diff --exit-code -- openapi.json packages/sdk/src/generated.ts

      - name: Build
        run: pnpm --filter @qhhoj/web exec vite build
```

The regeneration check matters: `openapi.json` and `generated.ts` are committed artifacts, and a contract change that was not regenerated would silently leave the SDK describing an API that no longer exists.

- [ ] **Step 2: Verify locally before pushing**

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r lint && pnpm -r test
pnpm --filter @qhhoj/contracts openapi
pnpm --filter @qhhoj/sdk exec openapi-typescript ../../openapi.json -o src/generated.ts
git diff --exit-code -- openapi.json packages/sdk/src/generated.ts
```

Expected: all green, no diff.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "ci: typecheck, lint, test, contract-drift check and build"
```

---

## Task 15: Deployment shape

**Files:**
- Create: `apps/api/Dockerfile`, `Caddyfile`, `docker-compose.yml`, `.env.example`, `scripts/migrate.ts`
- Modify: `packages/db/package.json` (add a `migrate` script)

**Interfaces:**
- Consumes: everything above.
- Produces: `docker compose up` bringing PostgreSQL, migrations, the API, and the static SPA online on VPS-1.

**Scope note:** Redis, MinIO, `judged`, and `worker` are **not** here. Redis and the worker arrive in Phase 1 with BullMQ; MinIO arrives in Phase 2 with packages. Adding them now would be configuration with nothing behind it.

- [ ] **Step 1: Write the migration entrypoint**

`scripts/migrate.ts`:

```ts
import { runMigrations } from '@qhhoj/db';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

await runMigrations(url);
console.log('migrations applied');
```

Add to `packages/db/package.json` scripts: `"migrate": "tsx ../../scripts/migrate.ts"`.

- [ ] **Step 2: Write the API Dockerfile**

`apps/api/Dockerfile`:

```dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm -r typecheck

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
```

- [ ] **Step 3: Write the Caddyfile**

`Caddyfile`:

```
{$SITE_ADDRESS:localhost} {
	encode gzip zstd

	handle /api/* {
		reverse_proxy api:3000
	}

	handle /healthz {
		reverse_proxy api:3000
	}

	handle {
		root * /srv/web
		try_files {path} /index.html
		file_server
	}
}
```

- [ ] **Step 4: Write the compose file**

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: qhhoj
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: qhhoj
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U qhhoj']
      interval: 5s
      timeout: 5s
      retries: 10

  migrate:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    command: ['pnpm', '--filter', '@qhhoj/db', 'migrate']
    environment:
      DATABASE_URL: postgres://qhhoj:${POSTGRES_PASSWORD}@postgres:5432/qhhoj
    depends_on:
      postgres: { condition: service_healthy }
    restart: 'no'

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    environment:
      NODE_ENV: production
      PORT: '3000'
      DATABASE_URL: postgres://qhhoj:${POSTGRES_PASSWORD}@postgres:5432/qhhoj
      TOTP_ENC_KEY: ${TOTP_ENC_KEY:?set TOTP_ENC_KEY}
      PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:-http://localhost}
      LOG_LEVEL: info
    depends_on:
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1))"]
      interval: 10s
      timeout: 5s
      retries: 6

  caddy:
    image: caddy:2-alpine
    environment:
      SITE_ADDRESS: ${SITE_ADDRESS:-localhost}
    ports: ['80:80', '443:443']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./apps/web/dist:/srv/web:ro
      - caddydata:/data
    depends_on:
      api: { condition: service_healthy }

volumes:
  pgdata:
  caddydata:
```

`.env.example`:

```bash
POSTGRES_PASSWORD=change-me
# 32 bytes of lowercase hex: openssl rand -hex 32
TOTP_ENC_KEY=0000000000000000000000000000000000000000000000000000000000000000
PUBLIC_ORIGIN=http://localhost
SITE_ADDRESS=localhost
```

Add `.env` to `.gitignore` (already present from the spec commit).

- [ ] **Step 5: Verify the stack comes up**

```bash
cp .env.example .env
sed -i "s/^TOTP_ENC_KEY=.*/TOTP_ENC_KEY=$(openssl rand -hex 32)/" .env
pnpm --filter @qhhoj/web exec vite build
docker compose up -d --build
sleep 20
curl -fsS http://localhost/healthz
curl -fsS -X POST http://localhost/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"admin","email":"admin@example.com","password":"a-long-enough-password","displayName":"Admin"}'
```

Expected: `{"status":"ok"}` then a 201 with the created profile. Then `docker compose down`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: docker compose deployment with caddy, migrations and postgres"
```

---

## Task 16: Phase 0 acceptance

**Files:**
- Create: `docs/runbook.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a documented, reproducible local setup and an explicit statement of what Phase 0 does and does not deliver.

- [ ] **Step 1: Run the complete gate from a clean checkout**

```bash
git clean -xdf -e .env
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

Expected: all green. Record the total test count in the commit message.

- [ ] **Step 2: Write the runbook**

`docs/runbook.md`:

```markdown
# Runbook

## Local development

    corepack enable
    pnpm install
    docker compose up -d postgres
    export DATABASE_URL=postgres://qhhoj:dev@localhost:5432/qhhoj
    pnpm --filter @qhhoj/db migrate
    pnpm --filter @qhhoj/api exec tsx watch src/main.ts
    pnpm --filter @qhhoj/web exec vite

## Adding a database table

1. Add it to `packages/db/src/schema/identity.ts`, or to `guarded.ts` if reads
   must be visibility-filtered.
2. `pnpm --filter @qhhoj/db exec drizzle-kit generate --name <change>`
3. Commit the generated SQL. Never edit a migration that is already committed.

## Adding an endpoint

1. Add the Zod schema to `packages/contracts`, and register the path.
2. Implement the controller in `apps/api`, validating with `ZodValidationPipe`.
3. Regenerate: `pnpm --filter @qhhoj/contracts openapi` then the SDK types.
   CI fails if these are stale.

## Reading a guarded table

You cannot import `@qhhoj/db/guarded` outside `apps/api/src/authz/**`; ESLint
will stop you. Add a method to the relevant `*.access.ts` service instead. This
is deliberate — see spec §8.

## Deploying

    pnpm --filter @qhhoj/web exec vite build
    docker compose up -d --build

Migrations run automatically before the API starts.
```

- [ ] **Step 3: Write the README**

Replace `README.md`:

```markdown
# QHH Online Judge

A ground-up rewrite of the QHH Online Judge: a TypeScript monorepo with a
NestJS API, a PostgreSQL data layer, a typed SDK, and a React frontend.

- Design: `docs/superpowers/specs/2026-08-17-foundation-design.md`
- Runbook: `docs/runbook.md`

## Phase 0 delivers

Monorepo and tooling · PostgreSQL schema for identity and organizations ·
authentication by session cookie, personal access token, and TOTP ·
RFC 9457 errors · centralised authorization with an enforced import boundary ·
OpenAPI-generated SDK · a minimal SPA · CI · a Docker Compose deployment.

## Phase 0 does not deliver

Problems, submissions, judging, contests, or ratings. Those are Phases 1–4.
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: runbook and readme; phase 0 acceptance"
```

---

## Acceptance criteria for Phase 0

- [ ] `pnpm -r typecheck && pnpm -r lint && pnpm -r test` is green from a clean checkout.
- [ ] A user can register, sign in, read `/auth/me`, and sign out — verified by test, and by curl against the Compose stack.
- [ ] TOTP can be enrolled, confirmed, and required at login.
- [ ] A personal access token authenticates a request and can be revoked.
- [ ] The organization leakage matrix passes, asserting exact visible sets for anonymous, member, outsider, and admin actors.
- [ ] Importing `@qhhoj/db/guarded` outside `apps/api/src/authz/**` fails `pnpm lint` — **demonstrated**, not assumed (Task 11, Step 7).
- [ ] A stale `openapi.json` or `generated.ts` fails CI.
- [ ] `docker compose up -d --build` yields a healthy stack with migrations applied.
- [ ] No plaintext session token, access token, or TOTP secret exists anywhere in the database.
