/**
 * The 2026-08 sweep's grouped-points defect, pinned end to end over the real
 * wire: DMOJ's ConfigNode inheritance makes every case in a batch report the
 * BATCH's points, and the driver's old per-case summation inflated a k-case
 * batch worth P into k*P — and awarded (k-1)*P where one failing case must
 * zero the batch. The accumulation now mirrors the bridge's own
 * `aggregateCases`: loose cases sum; a batch contributes min(points) /
 * max(total) once.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPacketDecoder, DMOJ_FLAG, encodePacket, type GradingEvent, type GradingJob } from '@duckoj/judge-protocol';
import { BridgeServer } from '../src/drivers/dmoj/bridge-server.js';
import { DmojDriver } from '../src/drivers/dmoj/dmoj-driver.js';

const job: GradingJob = {
  id: '9',
  attempt: 1,
  kind: 'submission',
  packageHash: 'hash-of-aplusb',
  revisionId: '1',
  language: 'cpp17',
  source: 'int main(){}',
  limits: { timeMs: 1000, memoryKb: 65536 },
};

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
    const decoder = createPacketDecoder({ onPacket: (p) => received.push(p as Record<string, unknown>), onError: () => {} });
    socket.on('data', (c) => decoder.push(c));
    socket.on('error', () => {});
  });
  return { ready, received, send: (p: unknown) => socket!.write(encodePacket(p)), close: () => socket?.destroy() };
}

function fakeAgent() {
  return { ensure: vi.fn(async () => {}) } as never;
}

const CASE = (position: number, points: number, total: number, status = 0) => ({
  position,
  status,
  time: 0.01,
  points,
  'total-points': total,
  memory: 900,
  output: '',
  feedback: '',
  'extended-feedback': '',
});

describe('batched points are aggregated, not summed', () => {
  let server: BridgeServer | undefined;
  let judge: ReturnType<typeof fakeJudge> | undefined;
  afterEach(async () => {
    judge?.close();
    await server?.close();
  });

  async function runAll(sendCases: (send: (p: unknown) => void, id: number) => void): Promise<GradingEvent[]> {
    server = new BridgeServer({ languageToExecutor: () => 'CPP17', verifyJudge: async () => true });
    const port = await server.listen(0);
    const driver = new DmojDriver(server, fakeAgent());
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const seen: GradingEvent[] = [];
    await driver.dispatch(job, async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);
    const id = Number((judge!.received.find((p) => p.name === 'submission-request') as { 'submission-id': number })['submission-id']);
    judge!.send({ name: 'grading-begin', 'submission-id': id, pretested: false });
    sendCases((p) => judge!.send(p), id);
    judge!.send({ name: 'grading-end', 'submission-id': id });
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'finished')).toBe(true), 10_000);
    return seen;
  }

  async function run(sendCases: (send: (p: unknown) => void, id: number) => void): Promise<GradingEvent> {
    return (await runAll(sendCases)).find((e) => e.type === 'finished')!;
  }

  it('a fully-passing 3-case batch worth 30 scores 30/30, not 90/90', async () => {
    const finished = await run((send, id) => {
      send({ name: 'batch-begin', 'submission-id': id });
      // ConfigNode inheritance: every case reports the batch total.
      send({ name: 'test-case-status', 'submission-id': id, cases: [CASE(1, 30, 30), CASE(2, 30, 30), CASE(3, 30, 30)] });
    });
    expect(finished).toMatchObject({ points: 30, maxPoints: 30, verdict: 'AC' });
  }, 30_000);

  it('one failing case zeroes the whole batch — never (k-1) shares of it', async () => {
    const finished = await run((send, id) => {
      send({ name: 'batch-begin', 'submission-id': id });
      send({
        name: 'test-case-status',
        'submission-id': id,
        cases: [CASE(1, 30, 30), CASE(2, 0, 30, DMOJ_FLAG.WA), CASE(3, 30, 30)],
      });
    });
    expect(finished).toMatchObject({ points: 0, maxPoints: 30 });
  }, 30_000);

  it('loose cases still sum, beside a batch', async () => {
    const finished = await run((send, id) => {
      send({ name: 'test-case-status', 'submission-id': id, cases: [CASE(1, 5, 5), CASE(2, 5, 5)] });
      send({ name: 'batch-begin', 'submission-id': id });
      send({ name: 'test-case-status', 'submission-id': id, cases: [CASE(3, 20, 20), CASE(4, 20, 20)] });
    });
    expect(finished).toMatchObject({ points: 30, maxPoints: 30 });
  }, 30_000);
});


/**
 * `batch-end` was in the packet union and handled by nothing: `translate`'s
 * `default: return` swallowed it, so `entry.batch` only ever counted UP, on
 * `batch-begin`. judge-server emits a batch-begin/batch-end pair around each
 * batch and yields loose cases outside any pair (`dmoj/judge.py:479-533`), and
 * a DMOJ `test_cases:` list may legally interleave the two — so every loose
 * case that follows a batch was filed under that batch's index and folded into
 * its min()/max() aggregate instead of summing on its own.
 */
describe('batch-end closes a batch', () => {
  let server: BridgeServer | undefined;
  let judge: ReturnType<typeof fakeJudge> | undefined;
  afterEach(async () => {
    judge?.close();
    await server?.close();
  });

  async function runAll(sendCases: (send: (p: unknown) => void, id: number) => void): Promise<GradingEvent[]> {
    server = new BridgeServer({ languageToExecutor: () => 'CPP17', verifyJudge: async () => true });
    const port = await server.listen(0);
    const driver = new DmojDriver(server, fakeAgent());
    judge = fakeJudge(port);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const seen: GradingEvent[] = [];
    await driver.dispatch(job, async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge!.received.some((p) => p.name === 'submission-request')).toBe(true), 10_000);
    const id = Number(
      (judge!.received.find((p) => p.name === 'submission-request') as { 'submission-id': number })['submission-id'],
    );
    judge!.send({ name: 'grading-begin', 'submission-id': id, pretested: false });
    sendCases((p) => judge!.send(p), id);
    judge!.send({ name: 'grading-end', 'submission-id': id });
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'finished')).toBe(true), 10_000);
    return seen;
  }

  it('a loose case after a batch sums on its own instead of joining the batch', async () => {
    const seen = await runAll((send, id) => {
      send({ name: 'batch-begin', 'submission-id': id });
      send({ name: 'test-case-status', 'submission-id': id, cases: [CASE(1, 20, 20), CASE(2, 20, 20)] });
      send({ name: 'batch-end', 'submission-id': id });
      send({ name: 'test-case-status', 'submission-id': id, cases: [CASE(3, 5, 5)] });
    });
    // Batch 20 + loose 5. Folded into the batch it read min(20,5)=5 / max(20,5)=20.
    expect(seen.find((e) => e.type === 'finished')).toMatchObject({ points: 25, maxPoints: 25 });
    const cases = seen.filter((e) => e.type === 'caseResult') as Array<{ caseIndex: number; groupIndex: number }>;
    expect(cases.map((c) => c.groupIndex)).toEqual([1, 1, 0]);
  }, 30_000);

  it('two closed batches stay two aggregates — the second is not re-keyed onto the first', async () => {
    // The guard against the naive fix: resetting the SAME counter to 0 on
    // batch-end makes the next batch-begin increment back to 1, merging both
    // batches' min()/max() into one. Batch 1 fails (0/30), batch 2 passes
    // (10/10); merged they would read min(0,10)=0 / max(30,10)=30.
    const finished = (
      await runAll((send, id) => {
        send({ name: 'batch-begin', 'submission-id': id });
        send({ name: 'test-case-status', 'submission-id': id, cases: [CASE(1, 0, 30, DMOJ_FLAG.WA)] });
        send({ name: 'batch-end', 'submission-id': id });
        send({ name: 'batch-begin', 'submission-id': id });
        send({ name: 'test-case-status', 'submission-id': id, cases: [CASE(2, 10, 10)] });
        send({ name: 'batch-end', 'submission-id': id });
      })
    ).find((e) => e.type === 'finished');
    expect(finished).toMatchObject({ points: 10, maxPoints: 40 });
  }, 30_000);
});
