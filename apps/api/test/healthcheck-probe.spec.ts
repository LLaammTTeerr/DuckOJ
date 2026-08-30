/**
 * D86 — the api container's healthcheck, run for real.
 *
 * The command is not retyped here; it is **extracted from
 * `docker-compose.yml`** and executed with the same `node -e` the container
 * runs, against servers that stand in for each failure the 2026-08-30 outage
 * went through. A test that restated the probe would drift from the compose
 * file the first time either was edited, and drift is exactly how the old
 * probe survived: it looked right.
 *
 * What the old probe was —
 *
 *     fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1))
 *
 * — and why it could not see the outage: `node:cluster` has the PRIMARY bind
 * the port. With every worker dead the primary still accepted the probe's
 * connection and had nobody to hand it to, so the fetch never settled. No
 * timeout, no `.catch`: the process just sat there until compose killed it at
 * its 5 s `timeout`, which is a probe with no verdict of its own. `podman ps`
 * said `Up` throughout.
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer, type Server as SocketServer } from 'node:net';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthController } from '../src/health/health.controller.js';
import { DB } from '../src/config/config.module.js';
import { MAILER, type Mailer } from '../src/mail/mailer.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMPOSE = join(REPO, 'docker-compose.yml');

/**
 * The api service's healthcheck command, taken from `docker-compose.yml`.
 *
 * Matched on the `localhost:3000` in it, which is what distinguishes the api
 * probe from `judged`'s (3001) and the judges' (3002).
 */
function apiHealthcheckCommand(): string {
  const yaml = readFileSync(COMPOSE, 'utf8');
  const match = /"(fetch\('http:\/\/localhost:3000\/healthz'[^"]*)"/.exec(yaml);
  if (!match?.[1]) {
    throw new Error(
      'could not find the api healthcheck command in docker-compose.yml — if its shape changed, ' +
        'this extraction must change with it rather than the test being deleted',
    );
  }
  return match[1];
}

/** Runs the extracted command against `port`, and reports its exit code. */
async function probe(port: number): Promise<number> {
  const command = apiHealthcheckCommand().replace('localhost:3000', `127.0.0.1:${String(port)}`);
  const child = spawn(process.execPath, ['-e', command], { stdio: 'ignore' });
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

describe("the compose healthcheck, as docker-compose.yml actually writes it", () => {
  let app: INestApplication | undefined;
  let http: Server | undefined;
  let socket: SocketServer | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    http?.close();
    http = undefined;
    socket?.close();
    socket = undefined;
  });

  /** A bare server answering exactly `body` with `status`, on a random port. */
  async function serve(status: number, body: string): Promise<number> {
    http = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
    await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));
    return (http.address() as AddressInfo).port;
  }

  it('passes against the real HealthController', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DB,
          useValue: {
            execute: () => {
              throw new Error('liveness must not touch the database');
            },
          },
        },
        { provide: MAILER, useValue: { kind: 'log', send: () => Promise.resolve() } as Mailer },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;

    expect(await probe(port)).toBe(0);
  }, 30_000);

  /**
   * The outage itself: a socket that accepts and never answers, which is
   * precisely what the primary does with no workers behind it.
   *
   * The assertion is the exit code AND the fact that it arrives at all — the
   * old probe produced neither.
   */
  it('fails, on its own, against a port that accepts and never answers', async () => {
    socket = createSocketServer(() => {
      // Accept the connection and say nothing. Ever.
    });
    await new Promise<void>((resolve) => socket?.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as AddressInfo).port;

    const started = Date.now();
    expect(await probe(port)).toBe(1);
    // Before compose's own 5 s `timeout` would have killed it — the probe
    // decides, rather than being killed mid-question.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 30_000);

  it('fails against a body with no worker count — an image older than D86', async () => {
    expect(await probe(await serve(200, JSON.stringify({ status: 'ok' })))).toBe(1);
  }, 30_000);

  it('fails when the primary reports no live workers', async () => {
    expect(await probe(await serve(200, JSON.stringify({ status: 'ok', workers: 0 })))).toBe(1);
  }, 30_000);

  it('fails on a 200 that is not the health body at all', async () => {
    // A proxy's error page, an SPA's index.html served by a misrouted
    // fallback: 200, and nothing to do with this service being alive.
    expect(await probe(await serve(200, '<!doctype html><title>hi</title>'))).toBe(1);
  }, 30_000);

  it('fails on a 503', async () => {
    expect(await probe(await serve(503, JSON.stringify({ status: 'ok', workers: 4 })))).toBe(1);
  }, 30_000);

  it('passes on a healthy body reporting several workers', async () => {
    expect(await probe(await serve(200, JSON.stringify({ status: 'ok', workers: 4 })))).toBe(0);
  }, 30_000);
});
