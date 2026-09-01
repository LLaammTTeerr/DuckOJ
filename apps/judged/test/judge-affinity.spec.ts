/**
 * B2, over the real wire protocol: `terminate-submission` carries no
 * submission id, so a driver that broadcasts it kills whatever the judge is
 * *actually* running — which, with more than one claim loop against one
 * judge, is somebody else's submission. These tests pin the two properties
 * that make that impossible: one submission per connection at a time, and a
 * terminate that only ever goes to the connection running that submission.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePacket, createPacketDecoder, type GradingEvent, type GradingJob } from '@duckoj/judge-protocol';
import { BridgeServer } from '../src/drivers/dmoj/bridge-server.js';
import { DmojDriver } from '../src/drivers/dmoj/dmoj-driver.js';

function makeJob(id: string): GradingJob {
  return {
    id,
    attempt: 1,
    kind: 'submission',
    packageHash: 'hash-of-aplusb',
    revisionId: '1',
    language: 'cpp17',
    source: 'int main(){}',
    limits: { timeMs: 1000, memoryKb: 65_536 },
  };
}

/** A minimal judge speaking the real wire format. `id` is its `judge_nodes` name. */
function fakeJudge(port: number, id: string) {
  const received: Record<string, unknown>[] = [];
  let socket: Socket;
  const ready = new Promise<void>((resolve) => {
    socket = connect(port, '127.0.0.1', () => {
      socket.write(
        encodePacket({ name: 'handshake', problems: [['aplusb', 0]], executors: { CPP17: {} }, id, key: 'k' }),
      );
      resolve();
    });
    const decoder = createPacketDecoder({
      onPacket: (p) => received.push(p as Record<string, unknown>),
      onError: () => {},
    });
    socket.on('data', (c) => decoder.push(c));
    socket.on('error', () => {});
  });
  return {
    ready,
    received,
    send: (p: unknown) => socket!.write(encodePacket(p)),
    requests: () => received.filter((p) => p.name === 'submission-request'),
    terminates: () => received.filter((p) => p.name === 'terminate-submission'),
    close: () => socket?.destroy(),
  };
}

function fakeAgent() {
  return { ensure: vi.fn(async () => {}) };
}

/** Long enough for a stray packet to have arrived, if one were going to. */
const SETTLE_MS = 300;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

describe('one submission per judge connection', () => {
  let server: BridgeServer | undefined;
  const judges: ReturnType<typeof fakeJudge>[] = [];

  afterEach(async () => {
    for (const judge of judges) judge.close();
    judges.length = 0;
    await server?.close();
    server = undefined;
  });

  async function bridge(judgeIds: string[]) {
    server = new BridgeServer({ languageToExecutor: () => 'CPP17', executorToLanguage: (e) => (e === 'CPP17' ? 'cpp17' : undefined), verifyJudge: async () => true });
    const port = await server.listen(0);
    for (const id of judgeIds) judges.push(fakeJudge(port, id));
    for (const judge of judges) await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(judgeIds.length), 10_000);
    return { server: server!, port, driver: new DmojDriver(server!, fakeAgent()) };
  }

  it('never sends a second submission-request to a connection that is already grading', async () => {
    const { driver } = await bridge(['j1']);
    const judge = judges[0]!;

    await driver.dispatch(makeJob('11'), async () => {});
    await vi.waitFor(() => expect(judge.requests()).toHaveLength(1), 10_000);

    // The second dispatch must not resolve — and must put nothing on the
    // wire — while the one connection is busy.
    let secondSent = false;
    const second = driver.dispatch(makeJob('12'), async () => {}).then(() => {
      secondSent = true;
    });
    await settle();
    expect(judge.requests()).toHaveLength(1);
    expect(secondSent).toBe(false);

    // Freeing the connection is what releases it.
    judge.send({ name: 'grading-end', 'submission-id': 11 });
    await second;
    expect(secondSent).toBe(true);
    await vi.waitFor(() => expect(judge.requests()).toHaveLength(2), 10_000);
    expect(judge.requests().map((p) => p['submission-id'])).toEqual([11, 12]);
  }, 30_000);

  it('cancelling a job the judge is NOT running terminates nothing (B2)', async () => {
    const { driver } = await bridge(['j1']);
    const judge = judges[0]!;

    // B takes the one connection; A queues behind it, exactly as two claim
    // loops against one judge produce.
    const seenB: GradingEvent[] = [];
    const seenA: GradingEvent[] = [];
    await driver.dispatch(makeJob('22'), async (e) => void seenB.push(e));
    await vi.waitFor(() => expect(judge.requests()).toHaveLength(1), 10_000);
    const waitingA = driver.dispatch(makeJob('21'), async (e) => void seenA.push(e));
    // A never dispatched, so its dispatch rejects rather than hanging the
    // worker's wrapper promise forever.
    const aOutcome = waitingA.then(
      () => 'resolved',
      () => 'rejected',
    );
    await settle();

    // A's watchdog fires. The old code broadcast an id-less terminate here,
    // killing B.
    await driver.cancel('21', 1);
    await settle();

    expect(judge.terminates()).toHaveLength(0);
    expect(await aOutcome).toBe('rejected');
    // A was never running, so it must not report `terminated` — that writes
    // a permanent errored/IE for a submission nothing ever graded.
    expect(seenA.some((e) => e.type === 'terminated')).toBe(false);

    // B survives and grades to a real verdict.
    judge.send({ name: 'grading-end', 'submission-id': 22 });
    await vi.waitFor(() => expect(seenB.some((e) => e.type === 'finished')).toBe(true), 10_000);
    expect(seenB.find((e) => e.type === 'finished')).toMatchObject({ verdict: 'IE' });
  }, 30_000);

  it('cancelling the job a judge IS running terminates it, and reports terminated', async () => {
    const { driver } = await bridge(['j1']);
    const judge = judges[0]!;

    const seen: GradingEvent[] = [];
    await driver.dispatch(makeJob('31'), async (e) => void seen.push(e));
    await vi.waitFor(() => expect(judge.requests()).toHaveLength(1), 10_000);

    await driver.cancel('31', 1);
    await vi.waitFor(() => expect(judge.terminates()).toHaveLength(1), 10_000);

    judge.send({ name: 'submission-terminated', 'submission-id': 31 });
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'terminated')).toBe(true), 10_000);
  }, 30_000);

  it('sends terminate only to the connection grading that submission', async () => {
    const { driver } = await bridge(['j1', 'j2']);
    const [first, second] = judges as [ReturnType<typeof fakeJudge>, ReturnType<typeof fakeJudge>];

    await driver.dispatch(makeJob('41'), async () => {});
    await vi.waitFor(() => expect(first.requests()).toHaveLength(1), 10_000);
    await driver.dispatch(makeJob('42'), async () => {});
    await vi.waitFor(() => expect(second.requests()).toHaveLength(1), 10_000);

    await driver.cancel('41', 1);
    await vi.waitFor(() => expect(first.terminates()).toHaveLength(1), 10_000);
    await settle();
    expect(second.terminates()).toHaveLength(0);
  }, 30_000);

  it('terminates an orphaned submission on the announcing connection only', async () => {
    const { driver } = await bridge(['j1', 'j2']);
    const [first, second] = judges as [ReturnType<typeof fakeJudge>, ReturnType<typeof fakeJudge>];
    void driver;

    // j2 restarted mid-grade and announces work we hold no lease for.
    second.send({ name: 'current-submission-id', 'submission-id': 999_999 });

    await vi.waitFor(() => expect(second.terminates()).toHaveLength(1), 10_000);
    await settle();
    expect(first.terminates()).toHaveLength(0);
  }, 30_000);

  it('frees the connection when a judge reconnects mid-grade, rather than wedging on a stale assignment', async () => {
    const { driver, port } = await bridge(['j1']);

    await driver.dispatch(makeJob('51'), async () => {});
    await vi.waitFor(() => expect(judges[0]!.requests()).toHaveLength(1), 10_000);

    // The judge crashes and redials under the same `judge_nodes` name. Its
    // in-flight grade is gone; the connection must not stay marked busy.
    judges[0]!.close();
    const reconnected = fakeJudge(port, 'j1');
    judges.push(reconnected);
    await reconnected.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    await driver.dispatch(makeJob('52'), async () => {});
    await vi.waitFor(() => expect(reconnected.requests()).toHaveLength(1), 10_000);
  }, 30_000);

  it('exposes idle capacity, so the worker pool can refuse to claim what nothing can run', async () => {
    const { driver } = await bridge(['j1']);
    const judge = judges[0]!;

    expect(driver.idleCapacity()).toBe(1);
    const slot = driver.tryAcquireSlot();
    expect(slot).not.toBeNull();
    // One judge, one slot: the second claim loop gets nothing to hold.
    expect(driver.tryAcquireSlot()).toBeNull();
    expect(driver.idleCapacity()).toBe(0);

    await driver.dispatch(makeJob('61'), async () => {});
    await vi.waitFor(() => expect(judge.requests()).toHaveLength(1), 10_000);
    judge.send({ name: 'grading-end', 'submission-id': 61 });
    slot!();
    await vi.waitFor(() => expect(driver.idleCapacity()).toBe(1), 10_000);
  }, 30_000);
});
