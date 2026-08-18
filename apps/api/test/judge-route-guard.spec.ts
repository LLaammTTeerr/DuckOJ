import { Controller, Get, UseGuards } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Db } from '@qhhoj/db';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashJudgeToken, schema } from '@qhhoj/db';
import { AuthGuard } from '../src/authn/auth.guard.js';
import { JudgeGuard, JudgeRoute } from '../src/authn/judge.guard.js';
import { JudgeService } from '../src/authn/judge.service.js';
import { SessionService } from '../src/authn/session.service.js';
import { TokenService } from '../src/authn/token.service.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { withTestDb } from './db.harness.js';
import { TEST_CONFIG } from './app.harness.js';

/**
 * The real internal archive route: `@JudgeRoute()` for `AuthGuard`, plus
 * `@UseGuards(JudgeGuard)` — both required, matching
 * `InternalPackagesController`.
 */
@Controller('internal')
class GuardedProbeController {
  @Get('guarded-probe')
  @JudgeRoute()
  @UseGuards(JudgeGuard)
  guarded(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Addendum A1's binding third requirement: a route carrying `@JudgeRoute()`
 * but WITHOUT `@UseGuards(JudgeGuard)`. If the marker alone opened
 * `AuthGuard`'s door, this controller would be indistinguishable from
 * `@Public()` under another name — which is exactly what this proves is not
 * the case.
 */
@Controller('internal')
class UnguardedProbeController {
  @Get('unguarded-probe')
  @JudgeRoute()
  unguarded(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Assembles a minimal application with the real global `AuthGuard` (via
 * `APP_GUARD`) protecting a single probe controller — everything `AuthGuard`
 * itself needs (`SessionService`, `TokenService`, `JudgeService`), and
 * nothing from `AuthnModule`'s controllers, so this is a test of the guard
 * mechanism in isolation rather than of the real routes.
 */
async function buildProbeApp(
  db: Db,
  controller: new (...args: never[]) => unknown,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [controller],
    providers: [
      SessionService,
      TokenService,
      JudgeService,
      JudgeGuard,
      AuthGuard,
      { provide: DB, useValue: db },
      { provide: APP_CONFIG, useValue: TEST_CONFIG },
      { provide: APP_GUARD, useExisting: AuthGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemFilter());
  await app.init();
  return app;
}

describe('@JudgeRoute() on the global AuthGuard', () => {
  it('lets a valid judge credential through, and rejects a missing or wrong one as problem+json', async () => {
    await withTestDb(async (db) => {
      const token = 'a-real-token';
      await db
        .insert(schema.judgeNodes)
        .values({ name: 'judge-x', tokenHash: hashJudgeToken(token), driver: 'dmoj' });

      const app = await buildProbeApp(db, GuardedProbeController);
      try {
        const ok = await request(app.getHttpServer())
          .get('/internal/guarded-probe')
          .set('Authorization', `Judge judge-x:${token}`);
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ ok: true });

        const noAuth = await request(app.getHttpServer()).get('/internal/guarded-probe');
        expect(noAuth.status).toBe(401);
        expect(noAuth.headers['content-type']).toContain('application/problem+json');
        expect(noAuth.body.code).toBe('judge_unauthorized');

        const wrong = await request(app.getHttpServer())
          .get('/internal/guarded-probe')
          .set('Authorization', 'Judge judge-x:not-the-right-token');
        expect(wrong.status).toBe(401);
        expect(wrong.headers['content-type']).toContain('application/problem+json');
        expect(wrong.body.code).toBe('judge_unauthorized');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('is not reachable anonymously even without @UseGuards(JudgeGuard) — the marker alone is not @Public() in disguise', async () => {
    await withTestDb(async (db) => {
      const app = await buildProbeApp(db, UnguardedProbeController);
      try {
        const res = await request(app.getHttpServer()).get('/internal/unguarded-probe');
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.body.code).toBe('judge_unauthorized');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
