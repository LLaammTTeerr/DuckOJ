import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPacketDecoder, DMOJ_FLAG, encodePacket, type GradingEvent, type GradingJob } from '@qhhoj/judge-protocol';
import { BridgeServer } from '../src/drivers/dmoj/bridge-server.js';
import { DmojDriver } from '../src/drivers/dmoj/dmoj-driver.js';

const job: GradingJob = {
  id: '7',
  attempt: 1,
  kind: 'submission',
  packageHash: 'hash-of-aplusb',
  revisionId: '1',
  language: 'cpp17',
  source: 'int main(){}',
  limits: { timeMs: 1000, memoryKb: 65536 },
};

/** A minimal judge: speaks the real wire format, runs no sandbox. */
function fakeJudge(port: number) {
  const received: Record<string, unknown>[] = [];
  let socket: Socket;
  const ready = new Promise<void>((resolve) => {
    socket = connect(port, '127.0.0.1', () => {
      socket.write(
        encodePacket({ name: 'handshake', problems: [['aplusb', 0]], executors: { CPP17: {} }, id: 'j1', key: 'k' }),
      );
      resolve();
    });
    const decoder = createPacketDecoder({
      onPacket: (p) => received.push(p as Record<string, unknown>),
      onError: () => {},
    });
    socket.on('data', (c) => decoder.push(c));
    // Teardown may destroy the server's end of the connection (e.g. on
    // afterEach cleanup after a failing assertion) before this socket has
    // been explicitly closed. Without a listener here, the resulting
    // ECONNRESET is an unhandled 'error' event that crashes the worker
    // instead of being an expected side effect of teardown.
    socket.on('error', () => {});
  });
  return {
    ready,
    received,
    send: (p: unknown) => socket!.write(encodePacket(p)),
    /**
     * Writes several packets concatenated into a single `socket.write()`
     * call, forcing them to arrive in one TCP chunk instead of leaving the
     * OS free to deliver them separately. This is how `judge-server` itself
     * behaves in practice — it flushes the test-case queue and immediately
     * sends `grading-end` — so a test that relies on the OS coalescing
     * writes on its own is exercising an accident, not the real timing.
     */
    sendBatch: (packets: unknown[]) => socket!.write(Buffer.concat(packets.map((p) => encodePacket(p)))),
    close: () => socket!.destroy(),
  };
}

describe('DmojDriver', () => {
  let server: BridgeServer | undefined;
  let judge: ReturnType<typeof fakeJudge> | undefined;

  // Runs regardless of whether the test body threw, so a socket left open by
  // a failed assertion never survives into the next test.
  afterEach(async () => {
    judge?.close();
    judge = undefined;
    await server?.close();
    server = undefined;
  });

  it('accepts a handshake and answers handshake-success', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(judge!.received.map((p) => p.name)).toContain('handshake-success'), 10_000);
  }, 30_000);

  it('translates a submission into a submission-request carrying the mapped problem code', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    await driver.dispatch(job, async () => {});

    await vi.waitFor(() => {
      const request = judge!.received.find((p) => p.name === 'submission-request');
      expect(request).toMatchObject({
        'problem-id': 'aplusb',
        language: 'CPP17',
        source: 'int main(){}',
        'time-limit': 1,
        'memory-limit': 65536,
      });
    }, 10_000);
  }, 30_000);

  it('translates a full grading run into our events', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const seen: GradingEvent[] = [];
    await driver.dispatch(job, async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);

    const id = Number((judge.received.find((p) => p.name === 'submission-request') as { 'submission-id': number })['submission-id']);
    judge.send({ name: 'grading-begin', 'submission-id': id, pretested: false });
    judge.send({
      name: 'test-case-status',
      'submission-id': id,
      cases: [
        { position: 1, status: 0, time: 0.004, points: 1, 'total-points': 1, memory: 900, output: '', feedback: '', 'extended-feedback': '' },
        { position: 2, status: 1 << 2, time: 1.0, points: 0, 'total-points': 1, memory: 900, output: '', feedback: '', 'extended-feedback': '' },
      ],
    });
    judge.send({ name: 'grading-end', 'submission-id': id });

    await vi.waitFor(() => expect(seen.some((e) => e.type === 'finished')).toBe(true), 10_000);

    const cases = seen.filter((e) => e.type === 'caseResult');
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ verdict: 'AC', caseIndex: 0 });
    expect(cases[1]).toMatchObject({ verdict: 'TLE', caseIndex: 1 });
    // Worst case wins the submission verdict.
    expect(seen.find((e) => e.type === 'finished')).toMatchObject({ verdict: 'TLE' });
  }, 30_000);

  it('computes the correct verdict when test-case-status and grading-end arrive in the same TCP chunk', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const seen: GradingEvent[] = [];
    await driver.dispatch(job, async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);
    const id = Number((judge.received.find((p) => p.name === 'submission-request') as { 'submission-id': number })['submission-id']);

    judge.send({ name: 'grading-begin', 'submission-id': id, pretested: false });
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'compiling')).toBe(true), 10_000);

    // A single write, not two: this forces the decoder to hand both packets
    // to the driver from the same synchronous `push()` pass, which is what
    // exposed the ordering bug — `grading-end` must not be translated until
    // every case in the preceding `test-case-status` has been.
    judge.sendBatch([
      {
        name: 'test-case-status',
        'submission-id': id,
        cases: [
          { position: 1, status: 0, time: 0.004, points: 1, 'total-points': 1, memory: 900, output: '', feedback: '', 'extended-feedback': '' },
          { position: 2, status: 1 << 2, time: 1.0, points: 0, 'total-points': 1, memory: 900, output: '', feedback: '', 'extended-feedback': '' },
        ],
      },
      { name: 'grading-end', 'submission-id': id },
    ]);

    await vi.waitFor(() => expect(seen.some((e) => e.type === 'finished')).toBe(true), 10_000);

    const relevant = seen.filter((e) => e.type === 'caseResult' || e.type === 'finished');
    expect(relevant.map((e) => e.type)).toEqual(['caseResult', 'caseResult', 'finished']);
    expect(seen.find((e) => e.type === 'finished')).toMatchObject({ verdict: 'TLE' });
  }, 30_000);

  it('does not let a skipped case override a genuine failure in the aggregate verdict', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const seen: GradingEvent[] = [];
    await driver.dispatch(job, async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);
    const id = Number((judge.received.find((p) => p.name === 'submission-request') as { 'submission-id': number })['submission-id']);

    // Case 1 genuinely fails (WA). Case 2 is short-circuited (SC) — e.g. a
    // later subtask skipped once an earlier one already failed. The SC bit
    // must not make interpretFlags see `null` (-> IE) for the submission;
    // the real WA has to win.
    judge.send({
      name: 'test-case-status',
      'submission-id': id,
      cases: [
        { position: 1, status: DMOJ_FLAG.WA, time: 0.01, points: 0, 'total-points': 1, memory: 900, output: '', feedback: '', 'extended-feedback': '' },
        { position: 2, status: DMOJ_FLAG.SC, time: 0, points: 0, 'total-points': 1, memory: 0, output: '', feedback: '', 'extended-feedback': '' },
      ],
    });
    judge.send({ name: 'grading-end', 'submission-id': id });

    await vi.waitFor(() => expect(seen.some((e) => e.type === 'finished')).toBe(true), 10_000);

    const cases = seen.filter((e) => e.type === 'caseResult');
    expect(cases).toHaveLength(2);
    // Per-case reporting is unaffected by the aggregate fix: the skipped
    // case still reports skipped: true, verdict: null.
    expect(cases[0]).toMatchObject({ verdict: 'WA', skipped: false });
    expect(cases[1]).toMatchObject({ verdict: null, skipped: true });
    expect(seen.find((e) => e.type === 'finished')).toMatchObject({ verdict: 'WA' });
  }, 30_000);

  it('reports IE, not AC, when every case in the run was skipped', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const seen: GradingEvent[] = [];
    await driver.dispatch(job, async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);
    const id = Number((judge.received.find((p) => p.name === 'submission-request') as { 'submission-id': number })['submission-id']);

    // Nothing ran. Stripping SC from the aggregate leaves mask 0, which
    // interpretFlags alone would read as AC — wrong, since no case executed.
    judge.send({
      name: 'test-case-status',
      'submission-id': id,
      cases: [
        { position: 1, status: DMOJ_FLAG.SC, time: 0, points: 0, 'total-points': 1, memory: 0, output: '', feedback: '', 'extended-feedback': '' },
        { position: 2, status: DMOJ_FLAG.SC, time: 0, points: 0, 'total-points': 1, memory: 0, output: '', feedback: '', 'extended-feedback': '' },
      ],
    });
    judge.send({ name: 'grading-end', 'submission-id': id });

    await vi.waitFor(() => expect(seen.some((e) => e.type === 'finished')).toBe(true), 10_000);

    expect(seen.find((e) => e.type === 'finished')).toMatchObject({ verdict: 'IE' });
  }, 30_000);

  it('still reports AC for a normal all-passing run', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const seen: GradingEvent[] = [];
    await driver.dispatch(job, async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);
    const id = Number((judge.received.find((p) => p.name === 'submission-request') as { 'submission-id': number })['submission-id']);

    // Guards against over-stripping: a run with no SC and no failing bits
    // must still resolve to AC.
    judge.send({
      name: 'test-case-status',
      'submission-id': id,
      cases: [
        { position: 1, status: 0, time: 0.004, points: 1, 'total-points': 1, memory: 900, output: '', feedback: '', 'extended-feedback': '' },
        { position: 2, status: 0, time: 0.005, points: 1, 'total-points': 1, memory: 900, output: '', feedback: '', 'extended-feedback': '' },
      ],
    });
    judge.send({ name: 'grading-end', 'submission-id': id });

    await vi.waitFor(() => expect(seen.some((e) => e.type === 'finished')).toBe(true), 10_000);

    expect(seen.find((e) => e.type === 'finished')).toMatchObject({ verdict: 'AC' });
  }, 30_000);

  it('surfaces a compile error', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const seen: GradingEvent[] = [];
    await driver.dispatch(job, async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);
    const id = Number((judge.received.find((p) => p.name === 'submission-request') as { 'submission-id': number })['submission-id']);

    judge.send({ name: 'compile-error', 'submission-id': id, log: 'error: expected ;' });

    await vi.waitFor(
      () => expect(seen).toContainEqual({ type: 'compileError', message: 'error: expected ;' }),
      10_000,
    );
  }, 30_000);

  it('sends terminate-submission when a job is cancelled', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    await driver.dispatch(job, async () => {});
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);

    await driver.cancel('7', 1);

    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'terminate-submission')).toBe(true), 10_000);
  }, 30_000);

  it('terminates an orphan a reconnecting judge reports that we hold no job for', async () => {
    server = new BridgeServer({ hashToProblemCode: () => 'aplusb', languageToExecutor: () => 'CPP17' });
    const port = await server.listen(0);
    const driver = new DmojDriver(server);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    // A judge that restarted mid-grade announces its in-flight submission.
    // We have no live lease for it, so it must be told to stop rather than
    // left grading forever.
    judge.send({ name: 'current-submission-id', 'submission-id': 999999 });

    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'terminate-submission')).toBe(true), 10_000);
    void driver;
  }, 30_000);

  it('sends periodic ping frames to a connected judge on the configured interval', async () => {
    server = new BridgeServer({
      hashToProblemCode: () => 'aplusb',
      languageToExecutor: () => 'CPP17',
      // A short injected interval so the test doesn't wait out the real 30s default.
      pingIntervalMs: 20,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'ping')).toBe(true), 10_000);
  }, 30_000);

  it('drops a judge connection that stops answering, and no longer broadcasts to it', async () => {
    server = new BridgeServer({
      hashToProblemCode: () => 'aplusb',
      languageToExecutor: () => 'CPP17',
      pingIntervalMs: 20,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    // fakeJudge never answers a ping — no `ping-response`, no traffic of any
    // kind after the handshake — so once several ping intervals have passed
    // in silence the bridge must consider the connection dead and remove it
    // from `connections`. This is the property that actually prevents a
    // dispatch from being lost: a socket the judge has abandoned must never
    // stay reachable via `broadcast()`.
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(0), 10_000);

    const receivedBeforeBroadcast = judge!.received.length;
    server!.broadcast({ name: 'terminate-submission' });
    // Removal already happened above; this confirms removal is what stops
    // delivery, not merely that a ping was sent at some point.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(judge!.received.length).toBe(receivedBeforeBroadcast);
  }, 30_000);
});
