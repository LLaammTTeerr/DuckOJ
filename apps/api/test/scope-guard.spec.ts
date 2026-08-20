import { Controller, Get } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Db } from '@duckoj/db';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { schema } from '@duckoj/db';
import { AuthGuard } from '../src/authn/auth.guard.js';
import { ScopeGuard } from '../src/authn/scope.guard.js';
import { RequireScope } from '../src/authn/require-scope.decorator.js';
import { SessionOnly, SessionOnlyGuard } from '../src/authn/session-only.guard.js';
import { SessionService } from '../src/authn/session.service.js';
import { TokenService } from '../src/authn/token.service.js';
import { JudgeService } from '../src/authn/judge.service.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { withTestDb } from './db.harness.js';
import { TEST_CONFIG } from './app.harness.js';

/**
 * A minimal probe controller: one route declares `@RequireScope`, one
 * declares none at all — the second is what pins deny-by-default, since a
 * route nobody annotated must still refuse a token — and one declares
 * `@SessionOnly()`, which pins that `ScopeGuard` defers to `SessionOnlyGuard`
 * on those routes instead of shadowing it with its own deny-by-default.
 */
@Controller('probe')
class ScopeProbeController {
  @Get('scoped')
  @RequireScope('submissions:write')
  scoped(): { ok: true } {
    return { ok: true };
  }

  @Get('unscoped')
  unscoped(): { ok: true } {
    return { ok: true };
  }

  @Get('session-only')
  @SessionOnly()
  sessionOnly(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Assembles a minimal application with the real global `AuthGuard` and
 * `ScopeGuard` (via `APP_GUARD`, in that registration order) protecting a
 * single probe controller — nothing from `AuthnModule`'s controllers, so
 * this is a test of the guard mechanism in isolation rather than of the real
 * routes.
 */
async function buildProbeApp(db: Db): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ScopeProbeController],
    providers: [
      SessionService,
      TokenService,
      JudgeService,
      AuthGuard,
      ScopeGuard,
      SessionOnlyGuard,
      { provide: DB, useValue: db },
      { provide: APP_CONFIG, useValue: TEST_CONFIG },
      { provide: APP_GUARD, useExisting: AuthGuard },
      { provide: APP_GUARD, useExisting: ScopeGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  return app;
}

async function makeUser(db: Db, username: string): Promise<number> {
  const [user] = await db
    .insert(schema.users)
    .values({ username, email: `${username}@e.com`, passwordHash: 'x', displayName: username })
    .returning();
  return user!.id;
}

async function sessionCookie(db: Db, userId: number): Promise<string> {
  const sessions = new SessionService(db, TEST_CONFIG);
  const { token } = await sessions.issue(userId, {});
  return `${TEST_CONFIG.sessionCookieName}=${token}`;
}

async function bearerToken(db: Db, userId: number, scopes: string[]): Promise<string> {
  const tokens = new TokenService(db);
  const { token } = await tokens.issue(userId, 'cli', scopes);
  return token;
}

describe('ScopeGuard', () => {
  it('lets a session reach a scoped route regardless of scopes', async () => {
    await withTestDb(async (db) => {
      const app = await buildProbeApp(db);
      try {
        const userId = await makeUser(db, 'aiko');
        const cookie = await sessionCookie(db, userId);
        const res = await request(app.getHttpServer()).get('/probe/scoped').set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('lets a token holding the required scope reach it', async () => {
    await withTestDb(async (db) => {
      const app = await buildProbeApp(db);
      try {
        const userId = await makeUser(db, 'bao');
        const token = await bearerToken(db, userId, ['submissions:write']);
        const res = await request(app.getHttpServer())
          .get('/probe/scoped')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a token lacking the required scope with 403 scope_required', async () => {
    await withTestDb(async (db) => {
      const app = await buildProbeApp(db);
      try {
        const userId = await makeUser(db, 'cyra');
        const token = await bearerToken(db, userId, ['problems:read']);
        const res = await request(app.getHttpServer())
          .get('/probe/scoped')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('scope_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a token with no scopes at all with 403 scope_required', async () => {
    await withTestDb(async (db) => {
      const app = await buildProbeApp(db);
      try {
        const userId = await makeUser(db, 'davi');
        const token = await bearerToken(db, userId, []);
        const res = await request(app.getHttpServer())
          .get('/probe/scoped')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('scope_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('deny by default: a token reaching a route with NO scope metadata gets 403 scope_required', async () => {
    await withTestDb(async (db) => {
      const app = await buildProbeApp(db);
      try {
        const userId = await makeUser(db, 'esha');
        // A generously-scoped token — the point is that no scope admits a
        // route nobody annotated with @RequireScope.
        const token = await bearerToken(db, userId, ['submissions:write']);
        const res = await request(app.getHttpServer())
          .get('/probe/unscoped')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('scope_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('an anonymous request to a scoped route gets 401 from AuthGuard, not 403 from ScopeGuard', async () => {
    await withTestDb(async (db) => {
      const app = await buildProbeApp(db);
      try {
        const res = await request(app.getHttpServer()).get('/probe/scoped');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('authentication_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('defers to SessionOnlyGuard: a token hitting a @SessionOnly() route gets 403 session_required, not scope_required', async () => {
    await withTestDb(async (db) => {
      const app = await buildProbeApp(db);
      try {
        const userId = await makeUser(db, 'faiz');
        // Deliberately no scopes at all: if ScopeGuard did not defer, this
        // would hit its own deny-by-default and report scope_required.
        const token = await bearerToken(db, userId, []);
        const res = await request(app.getHttpServer())
          .get('/probe/session-only')
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('session_required');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
