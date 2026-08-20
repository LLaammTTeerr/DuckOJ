import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { hashJudgeToken, schema } from '@duckoj/db';
import { JudgeGuard } from '../src/authn/judge.guard.js';
import { JudgeService } from '../src/authn/judge.service.js';
import { requestLogger } from '../src/common/logger.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { DB } from '../src/config/config.module.js';
import { withTestDb } from './db.harness.js';

/**
 * Stands in for Task 9's real package-fetch controller, which does not exist
 * yet — this task only owns the guard and the bridge check (see the plan's
 * cross-task row `8 → 9 | JudgeGuard`). `@UseGuards(JudgeGuard)` on a single
 * route, not a global guard, and deliberately no `@Public()`: this route is
 * every bit as protected as a `@Public()`-less route under the global
 * `AuthGuard` would be, just by a different credential.
 */
@Controller('internal')
class JudgeProbeController {
  @Get('probe')
  @UseGuards(JudgeGuard)
  probe(): { ok: true } {
    return { ok: true };
  }
}

/** Collects everything pino writes, so the test can assert on real log output. */
function captureLog(): { destination: DestinationStream; lines: () => string } {
  const chunks: string[] = [];
  return {
    destination: { write: (chunk: string) => void chunks.push(chunk) },
    lines: () => chunks.join(''),
  };
}

describe('JudgeGuard authenticates the internal package-fetch surface', () => {
  it('rejects a missing Authorization header, rejects a wrong token, accepts a seeded judge, and never logs the token', async () => {
    await withTestDb(async (db) => {
      const token = 'a-real-judge-token';
      await db.insert(schema.judgeNodes).values({
        name: 'judge-1',
        tokenHash: hashJudgeToken(token),
        driver: 'dmoj',
      });

      const log = captureLog();
      // Built inline, not via a separate `@Module()` class overridden after
      // the fact: `DB` has to live in the *same* module as `JudgeService` for
      // Nest to resolve it, and this test needs a distinct, freshly-seeded
      // `db` (from `withTestDb`) per run rather than a module-level constant.
      const moduleRef = await Test.createTestingModule({
        controllers: [JudgeProbeController],
        providers: [JudgeService, JudgeGuard, { provide: DB, useValue: db }],
      }).compile();
      const app = moduleRef.createNestApplication();
      // Not 'silent': at that level nothing is emitted and "the token is
      // absent from the log" would hold for the wrong reason.
      app.use(requestLogger('info', log.destination));
      app.useGlobalFilters(new ProblemFilter());
      await app.init();

      try {
        const noAuth = await request(app.getHttpServer()).get('/internal/probe');
        expect(noAuth.status).toBe(401);
        expect(noAuth.headers['content-type']).toContain('application/problem+json');
        expect(noAuth.body.code).toBe('judge_unauthorized');

        const wrongToken = await request(app.getHttpServer())
          .get('/internal/probe')
          .set('Authorization', 'Judge judge-1:not-the-right-token');
        expect(wrongToken.status).toBe(401);
        expect(wrongToken.headers['content-type']).toContain('application/problem+json');
        expect(wrongToken.body.code).toBe('judge_unauthorized');

        const correct = await request(app.getHttpServer())
          .get('/internal/probe')
          .set('Authorization', `Judge judge-1:${token}`);
        expect(correct.status).toBe(200);
        expect(correct.body).toEqual({ ok: true });

        const output = log.lines();

        // Positive first: prove the logger really ran, so the absence check
        // below cannot pass against an empty capture.
        expect(output).toContain('"req"');
        expect(output).toContain('[redacted]');
        expect(output).toContain('"url":"/internal/probe"');

        // The actual guarantee: no credential string from any of the three
        // requests above (no header, a wrong token, the real token) reaches
        // the log line — including the one real token that actually
        // crossed the wire.
        expect(output).not.toContain(token);
        expect(output).not.toContain('not-the-right-token');
        expect(output.toLowerCase()).not.toContain('judge judge-1:');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
