// B5, item 6: what the probes do when the database is not merely broken but
// **unresponsive**.
//
// `health.spec.ts` already covers a database that *rejects* — a stub whose
// `execute` throws — and that path was always fine: 503, immediately. A dead
// port behaves the same way, because a TCP RST comes back in microseconds
// (measured against `postgres://…@127.0.0.1:1/…`: rejected in 7 ms). Both are
// the easy outage.
//
// The hard one is a database that accepts and then says nothing: a network
// partition, a host that drops packets, a Postgres wedged on its own locks.
// `readyz` awaited `db.execute` with **no deadline of its own**, and neither
// postgres.js nor drizzle imposes a statement timeout, so on that path the
// probe did not answer 503 — it did not answer at all. Measured against a
// blackholing address, the query had still not settled after 15 s; a query
// that hangs *after* connecting has no bound whatsoever.
//
// That is worse than a wrong answer in two ways. An orchestrator sees a probe
// *timeout*, which is indistinguishable from the API process being wedged, so
// the diagnosis points at the wrong container — precisely when an operator is
// reading probes to find out which one is sick. And every hanging probe holds
// one of the pool's ten connections for as long as it hangs, so a probe on a
// 10 s interval can exhaust the pool and take healthy read traffic down with
// it.
//
// A readiness probe's contract is to answer. `ready()` now races the check
// against its own deadline and reports 503 when the deadline wins, which is
// the honest answer: a database that has not replied in `READY_TIMEOUT_MS` is
// not one this instance is ready to serve from, whatever it is doing.
//
// Redis is deliberately still not consulted. `RedisSubscriber` retries in the
// background by design (`app.harness.ts` points its default config at an
// unreachable port for exactly this reason) and every HTTP route works without
// it — only live submission updates degrade, into polling. A readiness probe
// that failed on Redis would pull a fully serviceable API instance out of
// rotation over a cosmetic feature.
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthController, READY_TIMEOUT_MS } from '../src/health/health.controller.js';
import { DB } from '../src/config/config.module.js';
import { MAILER, type Mailer } from '../src/mail/mailer.js';

async function buildApp(dbStub: { execute: () => Promise<unknown> }): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DB, useValue: dbStub },
      { provide: MAILER, useValue: { kind: 'log', send: () => Promise.resolve() } as Mailer },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** Never settles — a partitioned or wedged database, without needing one. */
const hangs = { execute: () => new Promise<never>(() => {}) };

describe('the probes under an unresponsive database', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('readyz answers 503 on its own deadline instead of hanging with the query', async () => {
    app = await buildApp(hangs);

    const startedAt = Date.now();
    const res = await request(app.getHttpServer()).get('/readyz');
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ statusCode: 503 });
    // Generous, but far inside "forever": without the deadline this request
    // never completes, and the failure is the runner's own timeout with no
    // useful message attached.
    expect(elapsed).toBeLessThan(READY_TIMEOUT_MS * 3);
  });

  it('healthz still reports liveness while the database hangs', async () => {
    // The split is the point, and the Compose healthcheck probes exactly this
    // one: if liveness consulted the database, a database outage would
    // restart every otherwise-healthy API container — turning one incident
    // into two.
    app = await buildApp(hangs);
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    // D86 added the live worker count to this body; it is still computed
    // without touching anything, which is what this test is about.
    expect(res.body).toEqual({ status: 'ok', workers: 1 });
  });

  it('the deadline is short enough to be useful to a probe interval', () => {
    // A readiness deadline longer than the interval an orchestrator probes on
    // just moves the pile-up rather than preventing it.
    expect(READY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(READY_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
