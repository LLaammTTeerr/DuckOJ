import { WebSocket } from 'ws';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp, buildAppWithRealtime } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { clearSubmissionMeter, registerAndLogin, seedProblemAndLanguage } from './submissions.fixtures.js';
import { SessionService } from '../src/authn/session.service.js';
import { SubmissionAccessService } from '../src/authz/submission.access.js';
import { MAX_SUBSCRIPTIONS } from '../src/realtime/submissions.gateway.js';
import type { Db } from '@duckoj/db';

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

/**
 * Subscribes and waits for the server's own `subscribed` ack, rather than for
 * a fixed number of milliseconds.
 *
 * The ack exists precisely because "the subscription is live" is a fact only
 * the server knows; a `setTimeout(50)` here was a guess at it, and a wrong one
 * as soon as `getVisible` grew a query (D23 added the freeze lookup). When the
 * guess was short, the `once('message')` a test attached next caught the ack
 * instead of the wake-up frame it was waiting for, and the assertion failed on
 * timing rather than on behaviour.
 */
async function subscribeAcked(socket: WebSocket, submissionId: number): Promise<void> {
  const ack = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
  socket.send(JSON.stringify({ type: 'subscribe', submissionId }));
  const parsed: unknown = JSON.parse(await ack);
  expect(parsed).toEqual({ type: 'subscribed', id: submissionId });
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

  // Cross-Site WebSocket Hijacking: a `new WebSocket()` from an attacker's
  // page is not subject to CORS, and this gateway authenticates a browser by
  // its session cookie. SameSite=Lax is the first control (it withholds the
  // cookie from a cross-site handshake); the Origin check is the standard
  // second one. TEST_CONFIG.publicOrigin is http://localhost:5173.
  it('rejects a cross-origin browser handshake even with a valid cookie', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'mallory');
        // A present-but-wrong Origin is a cross-site attempt: 403, not open.
        await expect(
          open(`${url}/ws`, { cookie, origin: 'https://evil.example' }),
        ).rejects.toThrow(/403/);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('accepts a handshake whose Origin matches the configured public origin', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'trent');
        const socket = await open(`${url}/ws`, { cookie, origin: 'http://localhost:5173' });
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

  it('reports a transient database fault distinctly from "not found", without disclosing existence', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);

      const failingSubmissions = {
        getVisible: async (): Promise<never> => {
          throw new Error('connection terminated unexpectedly');
        },
      };
      const { app, url } = await buildAppWithRealtime(db, {
        overrides: [{ provide: SubmissionAccessService, useValue: failingSubmissions }],
      });
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'gina');
        const socket = await open(`${url}/ws`, { cookie });

        const reply = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        socket.send(JSON.stringify({ type: 'subscribe', submissionId: 1 }));

        // Not `submission_not_found`: that code is an authorization outcome
        // (`getVisible` throwing `AppError`), and a transient fault is a
        // different thing entirely — reporting it the same way would read to
        // the caller as "you have no access", which is false, and would hide
        // a real operational problem behind a code nobody watches.
        const parsed = JSON.parse(await reply) as { type: string; code: string };
        expect(parsed.type).toBe('error');
        expect(parsed.code).not.toBe('submission_not_found');

        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it("acks a successful subscribe with a 'subscribed' frame — the client's cue to re-fetch", async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url } = await buildAppWithRealtime(db);
      try {
        const agent = request.agent(app.getHttpServer());
        const cookie = await registerAndLogin(agent, 'acker');
        const created = await agent
          .post('/submissions')
          .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: 'x' });

        const socket = await open(`${url}/ws`, { cookie });
        const first = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        socket.send(JSON.stringify({ type: 'subscribe', submissionId: created.body.id }));
        // Before the fix no ack existed: a publish landing between the
        // client's post-subscribe fetch and the server-side add was
        // permanently lost, and the page stayed on 'grading' forever.
        expect(JSON.parse(await first)).toEqual({ type: 'subscribed', id: created.body.id });
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
        await subscribeAcked(socket, created.body.id);

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
        await expect(open(`${url}/ws`, { cookie: 'duckoj_session=%zz' })).rejects.toThrow(/401/);

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

  // --- Fix round 1, ruling R45: the malformed-cookie input B1's test sends
  // no longer reaches a throw at all once the parser is total, so that test
  // alone cannot tell whether the upgrade handler's `.catch()` is still
  // there. Pin it against the `.catch()`'s one remaining live trigger — a
  // database error inside `sessions.resolve` / `tokens.resolve` — with a
  // fault-injection seam instead. ---

  it('answers 500 rather than crashing when authenticate itself fails (R45)', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);

      // Minted through an ordinary, unbroken app sharing the same `db`, so
      // the second connection below has a working bearer token without ever
      // making an HTTP call against the app whose `SessionService` is about
      // to be replaced with one that always throws (which would break
      // *every* cookie-authenticated HTTP route on that app too, including
      // the one `POST /auth/tokens` needs — `SessionOnlyGuard` requires a
      // session, not a bearer token, to mint one).
      const setupApp = await buildApp(db);
      let token: string;
      try {
        const agent = request.agent(setupApp.getHttpServer());
        await registerAndLogin(agent, 'frank');
        const minted = await agent.post('/auth/tokens').send({ name: 'cli', scopes: [] });
        token = minted.body.token as string;
      } finally {
        await setupApp.close();
      }

      const failingSessions = {
        resolve: async (): Promise<null> => {
          throw new Error('boom');
        },
      };
      const { app, url } = await buildAppWithRealtime(db, {
        overrides: [{ provide: SessionService, useValue: failingSessions }],
      });
      try {
        // Any cookie routes through the now-broken `SessionService`. Race the
        // upgrade against an explicit 2s timeout rather than relying on the
        // implicit rejection to arrive on its own: if the upgrade handler's
        // `.catch()` is ever removed, `open()` never settles at all (same
        // hang shape `raceOpen` exists to catch below for B2), and without
        // this race that would surface as a generic 120s per-test timeout
        // instead of a fast, legible assertion failure.
        const openOrTimeout = Promise.race([
          open(`${url}/ws`, { cookie: 'duckoj_session=whatever' }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('open() did not settle within 2000ms')), 2_000),
          ),
        ]);
        await expect(openOrTimeout).rejects.toThrow(/500/);

        // The assertion that actually catches a regression: prove the
        // SERVER survived — not just that this one connection was rejected
        // — with a second connection on the same server over a path that
        // never touches the broken `SessionService` at all.
        const socket = await open(`${url}/ws`, { authorization: `Bearer ${token}` });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close();
      } finally {
        // Bounded for the same reason as the race above: in the broken-code
        // scenario it guards against, the first connection's raw socket is
        // handed to the upgrade listener and then never `end()`ed or
        // `destroy()`ed, so it sits half-open with nothing to notice the
        // client going away — confirmed against a minimal repro that not
        // even `getHttpServer().closeAllConnections()` reaches a socket in
        // that state, since Node stops tracking it once an `'upgrade'`
        // listener claims it. `http.Server#close()` waits for every
        // connection to end, so without this bound it would hang here for
        // the rest of the outer 120s test timeout, same as `open()` did
        // above pre-fix — silently turning a fast, legible failure back into
        // a slow, generic one.
        await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
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
        await subscribeAcked(socket, created.body.id);

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

/**
 * `client.subscriptions` was append-only and unbounded: nothing but closing
 * the socket ever removed an id, and every `subscribe` frame ran a full
 * `getVisible` detail read (three queries, the source, the whole case grid)
 * to answer a yes/no question. One connection could spend a season of its
 * own submissions in a burst and hold every one of them for the life of the
 * socket.
 */
describe('submission realtime — the subscription set is bounded and releasable', () => {
  /** A logged-in agent, a socket-ready url, and `count` of its own submissions. */
  async function fixture(
    db: Db,
    username: string,
    count: number,
    overrides?: { provide: unknown; useValue: unknown }[],
  ) {
    const built = await buildAppWithRealtime(db, overrides ? { overrides } : {});
    const agent = request.agent(built.app.getHttpServer());
    const cookie = await registerAndLogin(agent, username);
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      // D80 admits one submission per person per ten seconds, and this
      // fixture needs several from one person to have several subscriptions
      // to release. Nothing here is about the meter — it has its own file.
      await clearSubmissionMeter(db);
      const created = await agent
        .post('/submissions')
        .send({ problemCode: 'aplusb', languageKey: 'cpp17', source: `int main(){}//${String(i)}` });
      ids.push(created.body.id as number);
    }
    return { ...built, agent, cookie, ids };
  }

  it('releases a subscription on `unsubscribe`, so a signal for it stops arriving', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      const { app, url, cookie, ids, publish } = await fixture(db, 'unsubber', 2);
      try {
        const socket = await open(`${url}/ws`, { cookie });
        await subscribeAcked(socket, ids[0]!);
        await subscribeAcked(socket, ids[1]!);

        const dropped = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        socket.send(JSON.stringify({ type: 'unsubscribe', submissionId: ids[0]! }));
        expect(JSON.parse(await dropped)).toEqual({ type: 'unsubscribed', id: ids[0]! });

        // The next frame this socket sees must be for the id still held, not
        // for the released one — before `unsubscribe` existed, the only way
        // to stop watching anything was to drop the connection.
        const next = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        await publish(ids[0]!);
        await publish(ids[1]!);
        expect(JSON.parse(await next)).toEqual({ type: 'submission', id: ids[1]! });

        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses a subscription past the cap, and takes one again once a slot is released', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      // The bound at 2 rather than its production 256 — the cap is injected
      // exactly so this needs three submissions, not two hundred and fifty
      // seven.
      const { app, url, cookie, ids } = await fixture(db, 'flooder', 3, [
        { provide: MAX_SUBSCRIPTIONS, useValue: 2 },
      ]);
      try {
        const socket = await open(`${url}/ws`, { cookie });
        await subscribeAcked(socket, ids[0]!);
        await subscribeAcked(socket, ids[1]!);

        const refused = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        socket.send(JSON.stringify({ type: 'subscribe', submissionId: ids[2]! }));
        // Its own code, not `submission_not_found`: this submission IS the
        // caller's, and telling them otherwise would be a lie they would act
        // on.
        expect(JSON.parse(await refused)).toEqual({ type: 'error', code: 'subscription_limit' });

        // A repeat of an id already held is re-acked and consumes no slot —
        // a client that re-subscribes on every reconnect must not be walked
        // into its own cap.
        await subscribeAcked(socket, ids[0]!);

        const released = new Promise<string>((resolve) => socket.once('message', (d) => resolve(String(d))));
        socket.send(JSON.stringify({ type: 'unsubscribe', submissionId: ids[0]! }));
        await released;
        await subscribeAcked(socket, ids[2]!);

        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('ignores a subscribe whose id is not a positive integer, rather than parking it in the set', async () => {
    await withTestDb(async (db) => {
      await seedProblemAndLanguage(db);
      // Cap of 1: if a bogus id took a slot, the real subscribe below would
      // be refused instead of acked — which is the whole point of refusing
      // an id that can never match a `notify`.
      const { app, url, cookie, ids } = await fixture(db, 'floaty', 1, [
        { provide: MAX_SUBSCRIPTIONS, useValue: 1 },
      ]);
      try {
        const socket = await open(`${url}/ws`, { cookie });
        for (const bad of [1.5, -1, 0]) {
          socket.send(JSON.stringify({ type: 'subscribe', submissionId: bad }));
        }
        await subscribeAcked(socket, ids[0]!);
        socket.close();
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
