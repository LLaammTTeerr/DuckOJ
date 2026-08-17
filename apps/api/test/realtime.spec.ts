import { WebSocket } from 'ws';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildAppWithRealtime } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { registerAndLogin, seedProblemAndLanguage } from './submissions.fixtures.js';

function open(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
  });
}

/**
 * Races `open` against a short manual timeout, returning which one happened
 * first rather than just rejecting either way. A bare
 * `expect(open(...)).rejects.toThrow()` would pass on a hang just as well as
 * on a proper rejection — the exact way B2's leaked socket (server never
 * responds, connection just sits open) would slip past a naive test.
 */
function raceOpen(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<'opened' | 'rejected' | 'timed-out'> {
  return Promise.race([
    open(url, headers).then(
      (socket) => {
        socket.close();
        return 'opened' as const;
      },
      () => 'rejected' as const,
    ),
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), timeoutMs)),
  ]);
}

describe('submission realtime', () => {
  it('rejects an unauthenticated upgrade', async () => {
    await withTestDb(async (db) => {
      const { app, url } = await buildAppWithRealtime(db);
      try {
        await expect(open(`${url}/ws`, {})).rejects.toThrow(/401/);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a session cookie on the upgrade', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'alice');
        const socket = await open(`${url}/ws`, { cookie });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a bearer token in the Authorization header', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'bob');
        const minted = await agent.post('/auth/tokens').send({ name: 'cli', scopes: [] });
        const socket = await open(`${url}/ws`, { authorization: `Bearer ${minted.body.token}` });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('rejects a credential supplied in the query string', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        await registerAndLogin(agent, 'carol');
        const minted = await agent.post('/auth/tokens').send({ name: 'cli', scopes: [] });

        // A query-string credential lands in access logs, proxy logs and
        // browser history. Phase 0 closed exactly this leak; it must not
        // reappear through a different transport.
        await expect(open(`${url}/ws?token=${minted.body.token}`, {})).rejects.toThrow(/401/);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a subscription to a submission the caller does not own', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url } = await buildAppWithRealtime(db);
      try {
        const alice = request.agent(app.getHttpServer());
        await registerAndLogin(alice, 'alice');
        const created = await alice
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' });

        const bob = request.agent(app.getHttpServer());
        const bobCookie = await registerAndLogin(bob, 'bob');
        const socket = await open(`${url}/ws`, { cookie: bobCookie });

        const reply = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        socket.send(JSON.stringify({ type: 'subscribe', submissionId: created.body.id }));

        expect(JSON.parse(await reply)).toMatchObject({ type: 'error', code: 'submission_not_found' });
        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('delivers a wake-up signal carrying no submission data', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url, publish } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'alice');
        const created = await agent
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'secret-source-marker' });

        const socket = await open(`${url}/ws`, { cookie });
        socket.send(JSON.stringify({ type: 'subscribe', submissionId: created.body.id }));
        await new Promise((r) => setTimeout(r, 50));

        const message = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        await publish(created.body.id);
        const payload = await message;

        expect(JSON.parse(payload)).toEqual({ type: 'submission', id: created.body.id });
        // The topic is a signal, not a transport. Source must never ride on it.
        expect(payload).not.toContain('secret-source-marker');
        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  // --- Controller addendum B1: the upgrade handler must not crash the process ---

  it('rejects a malformed cookie without crashing the server (B1)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url } = await buildAppWithRealtime(db);
      try {
        // `decodeURIComponent('%zz')` throws `URIError`. Reachable by an
        // unauthenticated caller with a single header; before the fix, the
        // throw inside `authenticate` had no `.catch`, so it became an
        // unhandled promise rejection and Node 22 terminates the process on
        // those by default.
        await expect(open(`${url}/ws`, { cookie: 'qhhoj_session=%zz' })).rejects.toThrow(/401/);

        // The assertion that actually catches a regression: a well-formed
        // connection made afterwards, on the same server, still succeeds.
        // Without this, a dead process would make the line above pass too
        // (rejects.toThrow matches a connection-refused error just as well
        // as a clean 401) and the test would prove nothing.
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'dave');
        const socket = await open(`${url}/ws`, { cookie });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  // --- Controller addendum B2: a non-/ws upgrade must not leak the socket ---

  it('closes an upgrade to a path other than /ws instead of leaving it open (B2)', async () => {
    await withTestDb(async (db) => {
      const { app, url } = await buildAppWithRealtime(db);
      try {
        // A bare `expect(open(...)).rejects.toThrow()` would pass whether the
        // server destroys the connection (fixed) or just never responds
        // (the bug — Node stops auto-closing an unclaimed upgrade once any
        // 'upgrade' listener is registered, so it would hang until the
        // client's own timeout, if it has one, ever fires). `raceOpen` makes
        // "hung" and "closed" distinguishable, and fails fast instead of
        // stalling the suite.
        const result = await raceOpen(`${url}/not-ws`, {}, 2_000);
        expect(result).toBe('rejected');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  // --- Additional finding beyond B1-B4: a malformed post-auth message must
  // not crash the connection either (same class as B1/B3, reachable by any
  // already-authenticated caller sending one WebSocket frame). ---

  it('survives a malformed (non-object) subscribe message', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url, publish } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'erin');
        const created = await agent
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'x' });

        const socket = await open(`${url}/ws`, { cookie });
        // `JSON.parse('null')` is valid JSON that yields `null`; the brief's
        // original `parsed.type` access on it throws a `TypeError` inside an
        // `async` method invoked as `void this.onMessage(...)` — an unhandled
        // rejection, same crash class as B1.
        socket.send('null');
        await new Promise((r) => setTimeout(r, 50));

        // Prove survival end to end: a well-formed subscribe on the SAME
        // socket afterwards still gets fed a real wake-up signal.
        socket.send(JSON.stringify({ type: 'subscribe', submissionId: created.body.id }));
        await new Promise((r) => setTimeout(r, 50));

        const message = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        await publish(created.body.id);
        expect(JSON.parse(await message)).toEqual({ type: 'submission', id: created.body.id });
        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
