import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthnModule } from '../src/authn/authn.module.js';
import { CurrentActor, Public } from '../src/authn/auth.guard.js';
import type { Actor } from '../src/authz/actor.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { TEST_CONFIG } from './app.harness.js';

/**
 * A stand-in for the endpoint a future developer writes without thinking about
 * authentication at all. It carries no `@UseGuards`, no `@Public()` and no
 * `requireActor` call — exactly the shape that used to reach business logic
 * with no actor.
 */
@Controller('probe')
class ProbeController {
  @Get('unmarked')
  unmarked(): { reached: true } {
    return { reached: true };
  }

  @Get('open')
  @Public()
  open(): { reached: true } {
    return { reached: true };
  }

  /** `@CurrentActor()` on a public route: the second layer must still refuse. */
  @Get('open-but-strict')
  @Public()
  strict(@CurrentActor() actor: Actor): { userId: number } {
    return { userId: actor.userId };
  }
}

@Module({ imports: [AuthnModule], controllers: [ProbeController] })
class ProbeModule {}

describe('authentication is the default, not an opt-in', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] })
      // The guard never reaches the database on an anonymous request.
      .overrideProvider(DB)
      .useValue({})
      .overrideProvider(APP_CONFIG)
      .useValue(TEST_CONFIG)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it('rejects an anonymous request to a route nobody marked', async () => {
    const res = await request(app.getHttpServer()).get('/probe/unmarked');

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('authentication_required');
    expect(JSON.stringify(res.body)).not.toContain('reached');
  });

  it('serves an anonymous request to a route explicitly marked @Public()', async () => {
    const res = await request(app.getHttpServer()).get('/probe/open');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
  });

  it('refuses to hand a public route a missing actor through @CurrentActor()', async () => {
    const res = await request(app.getHttpServer()).get('/probe/open-but-strict');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('authentication_required');
  });
});
