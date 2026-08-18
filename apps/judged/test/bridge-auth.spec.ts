import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPacketDecoder, encodePacket } from '@qhhoj/judge-protocol';
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
      hashToProblemCode: () => 'aplusb',
      languageToExecutor: () => 'CPP17',
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

  it('closes the connection when the key does not verify, and registers nothing', async () => {
    const verifyJudge = vi.fn(async () => false);
    server = new BridgeServer({
      hashToProblemCode: () => 'aplusb',
      languageToExecutor: () => 'CPP17',
      verifyJudge,
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
  }, 30_000);

  it('does not register a judge whose verification throws', async () => {
    const verifyJudge = vi.fn(async () => {
      // Simulates a database blip during verification.
      throw new Error('db blip');
    });
    server = new BridgeServer({
      hashToProblemCode: () => 'aplusb',
      languageToExecutor: () => 'CPP17',
      verifyJudge,
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

    const receivedBeforeBroadcast = judge.received.length;
    server.broadcast({ name: 'terminate-submission' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(judge.received.length).toBe(receivedBeforeBroadcast);
  }, 30_000);
});
