import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthController } from '../src/health/health.controller.js';
import { DB } from '../src/config/config.module.js';
import { MAILER, type Mailer } from '../src/mail/mailer.js';

/**
 * A transport that reports its kind and refuses to be used.
 *
 * `send` throwing is the assertion in `readyz reports mail configuration
 * without dialling anything`: a readiness probe runs every ten seconds under
 * `docker-compose.yml`, and one that opened an SMTP connection would be
 * traffic against somebody else's relay six times a minute — and would hang
 * on a firewalled host, which is the failure `READY_TIMEOUT_MS` exists to
 * prevent for the database.
 */
function mailerStub(kind: 'smtp' | 'log'): Mailer {
  return {
    kind,
    send: () => {
      throw new Error('readyz opened a mail connection');
    },
  };
}

async function buildApp(
  dbStub: { execute: () => Promise<unknown> },
  mailer: Mailer = mailerStub('log'),
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DB, useValue: dbStub },
      // A stub, not `MailModule`: this suite deliberately builds the
      // controller with fakes so `readyz` can be driven into failure.
      { provide: MAILER, useValue: mailer },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('health endpoints', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app.close();
  });

  it('reports liveness without touching dependencies', async () => {
    app = await buildApp({
      execute: async () => {
        throw new Error('should not be called');
      },
    });

    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    // D86: the body carries the live worker count the compose healthcheck
    // requires. One process answering its own probe is one worker.
    expect(res.body).toEqual({ status: 'ok', workers: 1 });
  });

  it('reports readiness when the database answers', async () => {
    app = await buildApp({ execute: async () => [{ ok: 1 }] });

    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('ok');
  });

  /**
   * F-40 — `readyz` names the mail transport, and that field is how a monitor
   * finds out this deployment delivers nothing. It was already reported and
   * asserted by nothing, which is how a field quietly stops being sent.
   */
  it('reports which mail transport this deployment resolved', async () => {
    app = await buildApp({ execute: async () => [{ ok: 1 }] });
    expect((await request(app.getHttpServer()).get('/readyz')).body).toEqual({
      status: 'ok',
      database: 'ok',
      // `log` is a legitimate development configuration and a broken
      // production one; the probe reports it and refuses to judge.
      mail: 'log',
    });
  });

  it('says `smtp` when one is configured, and dials nothing to find out', async () => {
    app = await buildApp({ execute: async () => [{ ok: 1 }] }, mailerStub('smtp'));
    const res = await request(app.getHttpServer()).get('/readyz');
    // `mailerStub.send` throws, so a 200 here is itself the proof that the
    // probe read configuration rather than opening a connection.
    expect(res.status).toBe(200);
    expect(res.body.mail).toBe('smtp');
  });

  it('reports 503 when the database is unreachable', async () => {
    app = await buildApp({
      execute: async () => {
        throw new Error('connection refused');
      },
    });

    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(503);
  });
});
