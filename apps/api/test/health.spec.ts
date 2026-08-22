import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthController } from '../src/health/health.controller.js';
import { DB } from '../src/config/config.module.js';
import { MAILER, type Mailer } from '../src/mail/mailer.js';

async function buildApp(dbStub: { execute: () => Promise<unknown> }): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DB, useValue: dbStub },
      // A stub, not `MailModule`: this suite deliberately builds the
      // controller with fakes so `readyz` can be driven into failure.
      { provide: MAILER, useValue: { kind: 'log', send: () => Promise.resolve() } as Mailer },
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
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('reports readiness when the database answers', async () => {
    app = await buildApp({ execute: async () => [{ ok: 1 }] });

    const res = await request(app.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('ok');
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
