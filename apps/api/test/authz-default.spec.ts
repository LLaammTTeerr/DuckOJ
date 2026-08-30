import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthnModule } from '../src/authn/authn.module.js';
import { CurrentActor, Public } from '../src/authn/auth.guard.js';
import { SessionService } from '../src/authn/session.service.js';
import type { Actor } from '../src/authz/actor.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { TEST_CONFIG } from './app.harness.js';
import { MailModule } from '../src/mail/mail.module.js';

/**
 * The first `Set-Cookie` header, or a failure naming the response.
 *
 * `headers['set-cookie']` is `string[] | undefined`, and indexing it is
 * unchecked under `noUncheckedIndexedAccess` — a response that set no cookie
 * would otherwise fail here as `undefined is not a string`, several
 * assertions away from the reason.
 */
function firstSetCookie(res: { headers: Record<string, unknown>; status: number }): string {
  const raw = res.headers['set-cookie'];
  if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
    throw new Error(`no Set-Cookie on a ${String(res.status)} response`);
  }
  return raw[0];
}

const LIVE_SESSION = 'a-live-session-token';
const SIGNED_IN: Actor = { userId: 7, globalRole: 'user', via: 'session', scopes: [] };

/** Resolves exactly one token, so "stale cookie" and "live cookie" are both reachable without a database. */
const sessions = {
  resolve: async (token: string): Promise<Actor | null> =>
    token === LIVE_SESSION ? SIGNED_IN : null,
  revoke: async (): Promise<void> => undefined,
} as unknown as SessionService;

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

@Module({ imports: [MailModule, AuthnModule], controllers: [ProbeController] })
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
      .overrideProvider(SessionService)
      .useValue(sessions)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
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

  // Without this, a guard that rejected unconditionally would pass every other
  // test in this file. The mechanism has to let the right requests through.
  it('lets an authenticated request through to an unmarked route', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/unmarked')
      .set('Cookie', `${TEST_CONFIG.sessionCookieName}=${LIVE_SESSION}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
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

  /**
   * The guard treats an unresolvable *bearer* token as an error but an
   * unresolvable *cookie* as anonymous. This test exists to make the second
   * half expensive to delete: symmetric rejection would 401 exactly the caller
   * `/auth/logout` is `@Public()` for — someone whose session already expired
   * and whose cookie still needs clearing.
   */
  it('still logs out a caller whose session cookie is already dead', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/logout')
      // A browser, which is who this test is about, sends `Origin` on every
      // unsafe method — and since D82 a cookie-bearing write that does not is
      // refused `403 csrf_origin` before `AuthGuard` runs at all. Stated here
      // rather than stamped by the harness because this file assembles its own
      // application; the subject is still `AuthGuard`'s cookie/bearer
      // asymmetry, and it must not be decided by a missing header.
      .set('Origin', TEST_CONFIG.publicOrigin)
      .set('Cookie', `${TEST_CONFIG.sessionCookieName}=a-stale-token-that-resolves-to-nothing`);

    expect(res.status).toBe(204);
    expect(firstSetCookie(res)).toMatch(new RegExp(`^${TEST_CONFIG.sessionCookieName}=;`));
  });
});
