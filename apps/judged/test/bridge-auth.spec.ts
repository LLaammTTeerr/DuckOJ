import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPacketDecoder, encodePacket } from '@duckoj/judge-protocol';
import { hashJudgeToken, type JudgeCredentialRef } from '@duckoj/db';
import { BridgeServer } from '../src/drivers/dmoj/bridge-server.js';

/**
 * A minimal judge: speaks the real wire format, runs no sandbox. Mirrors
 * `dmoj-driver.spec.ts`'s `fakeJudge`, with two differences these tests
 * specifically need: a configurable `id`/`key` (the pair under test), and an
 * `isClosed()` flag — the property "the connection was closed" is exactly
 * what a rejected handshake must produce, not merely "no more packets
 * arrived".
 */
function fakeJudge(port: number, id: string, key: string) {
  const received: Record<string, unknown>[] = [];
  let socket: Socket;
  let closed = false;
  const ready = new Promise<void>((resolve) => {
    socket = connect(port, '127.0.0.1', () => {
      socket.write(encodePacket({ name: 'handshake', problems: [], executors: {}, id, key }));
      resolve();
    });
    const decoder = createPacketDecoder({
      onPacket: (p) => received.push(p as Record<string, unknown>),
      onError: () => {},
    });
    socket.on('data', (c) => decoder.push(c));
    socket.on('close', () => {
      closed = true;
    });
    // Teardown, or the server destroying a rejected connection, can produce
    // an ECONNRESET on this end; without a listener that is an unhandled
    // 'error' event that crashes the worker instead of an expected side
    // effect of the very behaviour under test.
    socket.on('error', () => {});
  });
  return {
    ready,
    received,
    isClosed: () => closed,
    send: (p: unknown) => socket!.write(encodePacket(p)),
    close: () => socket!.destroy(),
  };
}

describe('BridgeServer authentication', () => {
  let server: BridgeServer | undefined;
  let judge: ReturnType<typeof fakeJudge> | undefined;

  afterEach(async () => {
    judge?.close();
    judge = undefined;
    await server?.close();
    server = undefined;
  });

  it('answers handshake-success when the key verifies', async () => {
    const verifyJudge = vi.fn(async () => true);
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', 'phase1-judge-key');
    await judge.ready;

    await vi.waitFor(() => expect(judge!.received.map((p) => p.name)).toContain('handshake-success'), 10_000);
    expect(verifyJudge).toHaveBeenCalledWith('judge-1', 'phase1-judge-key');
    // The registration is the property that actually matters: a verified
    // judge must be reachable via `broadcast()`, not merely told "success".
    expect(server.judgeCount()).toBe(1);
  }, 30_000);

  it('records last-seen liveness on a successful handshake', async () => {
    // `judge_nodes.lastSeen` gets written on handshake and heartbeat (design
    // §8) — proven here at the mechanism level, the same way
    // `verifyJudge`'s own invocation is proven above: a spy in place of
    // `@duckoj/db`'s real `touchJudgeLastSeen`, since this file has no
    // database and does not need one to prove the bridge calls the right
    // thing at the right moment.
    const verifyJudge = vi.fn(async () => true);
    const recordLastSeen = vi.fn(async () => {});
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge,
      recordLastSeen,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', 'phase1-judge-key');
    await judge.ready;

    await vi.waitFor(() => expect(judge!.received.map((p) => p.name)).toContain('handshake-success'), 10_000);
    await vi.waitFor(() => expect(recordLastSeen).toHaveBeenCalledWith('judge-1'), 10_000);
  }, 30_000);

  it('records last-seen liveness again on a ping-response, the design-specified heartbeat', async () => {
    const verifyJudge = vi.fn(async () => true);
    const recordLastSeen = vi.fn(async () => {});
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge,
      recordLastSeen,
      // The handshake's own write opens the throttle window (D68), so with
      // the production 15 s value a heartbeat this soon after it is
      // correctly suppressed. Zero here isolates the heartbeat's own effect,
      // which is what this test is about.
      lastSeenThrottleMs: 0,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', 'phase1-judge-key');
    await judge.ready;
    await vi.waitFor(() => expect(judge!.received.map((p) => p.name)).toContain('handshake-success'), 10_000);
    // The handshake itself already produced one call — isolate the
    // heartbeat's own effect by counting from here.
    const callsAfterHandshake = recordLastSeen.mock.calls.length;

    judge.send({ name: 'ping-response', when: 0, time: 0 });

    await vi.waitFor(() => expect(recordLastSeen.mock.calls.length).toBeGreaterThan(callsAfterHandshake), 10_000);
    expect(recordLastSeen).toHaveBeenLastCalledWith('judge-1');
  }, 30_000);

  it('writes at most one liveness row per throttle window, however chatty the judge', async () => {
    // The rule this asserts CHANGED with D68: the durable write used to fire
    // on the handshake and `ping-response` alone, which under-reported a
    // judge that was mid-grade and streaming test-case packets. Any packet
    // may now refresh it — and the throttle is the only thing standing
    // between that and one UPDATE per test case, so it is what gets pinned.
    const verifyJudge = vi.fn(async () => true);
    const recordLastSeen = vi.fn(async () => {});
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge,
      recordLastSeen,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', 'phase1-judge-key');
    await judge.ready;
    await vi.waitFor(() => expect(judge!.received.map((p) => p.name)).toContain('handshake-success'), 10_000);
    await vi.waitFor(() => expect(recordLastSeen).toHaveBeenCalledTimes(1), 10_000);

    for (let i = 0; i < 5; i++) judge.send({ name: 'supported-problems', problems: [['aplusb', 0]] });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(recordLastSeen).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('refreshes liveness from any packet once the window has passed', async () => {
    const verifyJudge = vi.fn(async () => true);
    const recordLastSeen = vi.fn(async () => {});
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge,
      recordLastSeen,
      lastSeenThrottleMs: 0,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', 'phase1-judge-key');
    await judge.ready;
    await vi.waitFor(() => expect(recordLastSeen).toHaveBeenCalledTimes(1), 10_000);

    // Not a heartbeat, and that is the point: a judge sending anything at
    // all is a judge the dashboard must not be calling offline (D47's 90 s).
    judge.send({ name: 'supported-problems', problems: [['aplusb', 0]] });

    await vi.waitFor(() => expect(recordLastSeen).toHaveBeenCalledTimes(2), 10_000);
    expect(recordLastSeen).toHaveBeenLastCalledWith('judge-1');
  }, 30_000);

  it('closes the connection when the key does not verify, and registers nothing', async () => {
    const verifyJudge = vi.fn(async () => false);
    // The other half of the property above: an unauthenticated caller must
    // not be able to write to `judge_nodes` — however harmlessly — just by
    // presenting a name. `recordLastSeen` staying uncalled on every
    // rejection path in this file is what proves that.
    const recordLastSeen = vi.fn(async () => {});
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge,
      recordLastSeen,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', 'wrong-key');
    await judge.ready;

    await vi.waitFor(() => expect(judge!.isClosed()).toBe(true), 10_000);
    // No handshake-success and no other packet — the bridge sends nothing
    // to a rejected judge.
    expect(judge.received).toHaveLength(0);
    expect(server.judgeCount()).toBe(0);

    // The registration is what matters, because an unregistered connection
    // cannot be handed a submission: prove it by broadcasting into a bridge
    // that (from its own accounting) holds no live judge, and confirming
    // nothing further reaches this — already closed — socket.
    const receivedBeforeBroadcast = judge.received.length;
    server.broadcast({ name: 'terminate-submission' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(judge.received.length).toBe(receivedBeforeBroadcast);

    expect(recordLastSeen).not.toHaveBeenCalled();
  }, 30_000);

  it('does not register a judge whose verification throws', async () => {
    const verifyJudge = vi.fn(async () => {
      // Simulates a database blip during verification.
      throw new Error('db blip');
    });
    const recordLastSeen = vi.fn(async () => {});
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge,
      recordLastSeen,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', 'phase1-judge-key');
    await judge.ready;

    // A database blip must fail closed: an outage in verification is a
    // rejection, never a silent admission. Same three properties as the
    // "does not verify" case above, this time with the check throwing
    // rather than resolving false.
    await vi.waitFor(() => expect(judge!.isClosed()).toBe(true), 10_000);
    expect(judge.received).toHaveLength(0);
    expect(server.judgeCount()).toBe(0);
    expect(recordLastSeen).not.toHaveBeenCalled();

    const receivedBeforeBroadcast = judge.received.length;
    server.broadcast({ name: 'terminate-submission' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(judge.received.length).toBe(receivedBeforeBroadcast);
  }, 30_000);

  it('logs the rejection with the judge id, and never the key', async () => {
    // Distinctive enough that an accidental substring match (e.g. inside a
    // stack frame path) would be implausible.
    const secretKey = 'super-secret-do-not-log-me';
    const verifyJudge = vi.fn(async () => false);
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge,
    });
    const port = await server.listen(0);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      judge = fakeJudge(port, 'judge-1', secretKey);
      await judge.ready;
      await vi.waitFor(() => expect(judge!.isClosed()).toBe(true), 10_000);

      const lines = errorSpy.mock.calls.map((call) => String(call[0]));
      const rejectionLine = lines.find((line) => line.includes('judge handshake rejected'));

      // Presence: an operator staring at a silent connect/reject loop has
      // something to grep for, naming which judge was rejected.
      expect(rejectionLine).toBeDefined();
      expect(rejectionLine).toContain('judge-1');

      // Absence: across every line this test produced, not just the
      // rejection one — the key must never reach a log line at all.
      expect(lines.join('\n')).not.toContain(secretKey);
    } finally {
      errorSpy.mockRestore();
    }
  }, 30_000);
});

/**
 * Revocation reaches a judge that is ALREADY connected (D81).
 *
 * `verifyJudge` runs once, at the handshake, and B11 recorded the
 * consequence: `judge:node revoke` burned the token hash and the revoked
 * judge kept its socket for as long as it stayed connected — indefinitely,
 * since the bridge pings it and it answers. The mitigation everyone leaned on
 * ("its package fetches 401, so the work fails") is not a mitigation: it is
 * every submission dispatched to that judge failing instead of being graded,
 * which is worse than not dispatching at all.
 *
 * The check is a poll, not a `LISTEN`/`NOTIFY` — see D81.
 */
describe('BridgeServer revalidates connected judges', () => {
  let server: BridgeServer | undefined;
  let judge: ReturnType<typeof fakeJudge> | undefined;

  afterEach(async () => {
    judge?.close();
    judge = undefined;
    await server?.close();
    server = undefined;
  });

  async function connectedJudge(
    options: Partial<ConstructorParameters<typeof BridgeServer>[0]>,
  ): Promise<void> {
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge: async () => true,
      revalidateIntervalMs: 50,
      ...options,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', 'a-key');
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);
  }

  it('drops a judge the poll no longer admits, and reports the disconnect', async () => {
    let admitted = ['judge-1'];
    const disconnected: string[] = [];
    await connectedJudge({ admittedJudges: async () => admitted });
    server!.onDisconnect((id) => disconnected.push(id));

    // The revocation happens out of band — `judge:node revoke` against the
    // database, with nothing on this socket to announce it.
    admitted = [];

    await vi.waitFor(() => expect(server!.judgeCount()).toBe(0), 10_000);
    // The socket itself, not merely the bookkeeping: a judge left connected
    // goes on being pinged and goes on believing it is in the fleet.
    await vi.waitFor(() => expect(judge!.isClosed()).toBe(true), 10_000);
    // Whoever was grading on it has to hear, exactly as for a judge that died.
    expect(disconnected).toEqual(['judge-1']);
  }, 30_000);

  it('never dispatches to a revoked judge again', async () => {
    let admitted = ['judge-1'];
    await connectedJudge({ admittedJudges: async () => admitted });
    expect(server!.connectionIds()).toEqual(['judge-1']);

    admitted = [];
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(0), 10_000);

    // The three things dispatch asks. All must answer "nobody".
    expect(server!.connectionIds()).toEqual([]);
    expect(server!.sendTo('judge-1', { name: 'ping', when: 0 })).toBe(false);
    expect(server!.supportedLanguages()).toEqual([]);
  }, 30_000);

  it('keeps a judge the poll still admits, and asks by (name, credential)', async () => {
    const admittedJudges = vi.fn(async (creds: readonly JudgeCredentialRef[]) =>
      creds.map((c) => c.name),
    );
    await connectedJudge({ admittedJudges });

    await vi.waitFor(() => expect(admittedJudges.mock.calls.length).toBeGreaterThan(2), 10_000);
    expect(server!.judgeCount()).toBe(1);
    expect(judge!.isClosed()).toBe(false);
    // D204: the poll asks about the CREDENTIAL this connection authenticated
    // with, not merely the name it authenticated as. The bridge never keeps
    // the key — only its digest, the same one `judge_nodes.token_hash` holds.
    expect(admittedJudges).toHaveBeenCalledWith([
      { name: 'judge-1', tokenHash: hashJudgeToken('a-key') },
    ]);
  }, 30_000);

  it('drops a judge whose token was ROTATED, though its row is neither gone nor revoked (D204)', async () => {
    // The real predicate, not a list: `admittedJudgeCredentials` matches the
    // pair against `judge_nodes`, so the honest double is a stored hash that
    // an out-of-band `judge:node rotate` changes.
    let storedHash = hashJudgeToken('a-key');
    const disconnected: string[] = [];
    await connectedJudge({
      admittedJudges: async (creds: readonly JudgeCredentialRef[]) =>
        creds.filter((c) => c.tokenHash === storedHash).map((c) => c.name),
    });
    server!.onDisconnect((id) => disconnected.push(id));

    // `judge:node rotate judge-1` — the name is still registered and its
    // token is not burned, so D81's name-only poll would have kept this
    // connection alive on a credential that no longer exists: dispatched to
    // by `judged`, and 401'd by the API on every package fetch.
    storedHash = hashJudgeToken('the-rotated-key');

    await vi.waitFor(() => expect(server!.judgeCount()).toBe(0), 10_000);
    await vi.waitFor(() => expect(judge!.isClosed()).toBe(true), 10_000);
    // Through `retire`, so whatever it was grading is abandoned and requeued
    // rather than left parked until the grading ceiling fires.
    expect(disconnected).toEqual(['judge-1']);
  }, 30_000);

  it('re-admits the judge once it reconnects holding the rotated token', async () => {
    const storedHash = hashJudgeToken('the-rotated-key');
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge: async () => true,
      revalidateIntervalMs: 50,
      admittedJudges: async (creds: readonly JudgeCredentialRef[]) =>
        creds.filter((c) => c.tokenHash === storedHash).map((c) => c.name),
    });
    const port = await server.listen(0);
    // The container recreated with the new JUDGE_TOKEN — the same name, a
    // different key. Nothing else has to happen for it to stay connected.
    judge = fakeJudge(port, 'judge-1', 'the-rotated-key');
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server!.judgeCount()).toBe(1);
    expect(judge.isClosed()).toBe(false);
  }, 30_000);

  it('fails OPEN: a poll that throws never empties the fleet', async () => {
    // The revalidation query runs against the same database every other part
    // of this system depends on. A blip in it must not disconnect every judge
    // in the province at once — that turns a transient read failure into a
    // fleet-wide outage, which is strictly worse than the thing being guarded.
    const admittedJudges = vi.fn(() => Promise.reject(new Error('database is down')));
    await connectedJudge({ admittedJudges });

    await vi.waitFor(() => expect(admittedJudges.mock.calls.length).toBeGreaterThan(2), 10_000);
    expect(server!.judgeCount()).toBe(1);
    expect(judge!.isClosed()).toBe(false);
  }, 30_000);

  it('polls nothing when no judge is connected', async () => {
    const admittedJudges = vi.fn(async (creds: readonly JudgeCredentialRef[]) =>
      creds.map((c) => c.name),
    );
    server = new BridgeServer({
      languageToExecutor: () => 'CPP17',
      executorToLanguage: (executor) => (executor === 'CPP17' ? 'cpp17' : undefined),
      verifyJudge: async () => true,
      revalidateIntervalMs: 20,
      admittedJudges,
    });
    await server.listen(0);

    await new Promise((resolve) => setTimeout(resolve, 300));
    // An idle bridge must not run a query fifteen times a minute for nothing.
    expect(admittedJudges).not.toHaveBeenCalled();
  }, 30_000);
});
