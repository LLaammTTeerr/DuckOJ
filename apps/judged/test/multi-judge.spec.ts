/**
 * Two judges, over the real wire protocol — the thing the runbook called
 * "not built ... not a tested procedure" and D29 left as the one genuinely
 * untested case (docs/runbook.md, "Adding a second judge container").
 *
 * Everything here goes through `BridgeServer` on a real TCP socket with real
 * framed packets, because every property under test is a property of
 * *routing*: which socket a request went to, which socket a terminate went
 * to, and which socket never heard about a job at all. An in-process double
 * would assert the driver's intent rather than the wire's fact.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPacketDecoder,
  encodePacket,
  NoCapableJudgeError,
  type GradingEvent,
  type GradingJob,
} from '@duckoj/judge-protocol';
import { BridgeServer, type JudgeCapabilities } from '../src/drivers/dmoj/bridge-server.js';
import { DmojDriver } from '../src/drivers/dmoj/dmoj-driver.js';

function makeJob(id: string, language = 'cpp17'): GradingJob {
  return {
    id,
    attempt: 1,
    kind: 'submission',
    packageHash: 'hash-of-aplusb',
    revisionId: '1',
    language,
    source: 'int main(){}',
    limits: { timeMs: 1000, memoryKb: 65_536 },
  };
}

/**
 * A minimal judge speaking the real wire format. `executors` is what makes
 * this suite different from `judge-affinity.spec.ts`: a fleet is only
 * heterogeneous if its members announce different ones.
 */
function fakeJudge(port: number, id: string, executors: string[] = ['CPP17']) {
  const received: Record<string, unknown>[] = [];
  let socket: Socket;
  const ready = new Promise<void>((resolve) => {
    socket = connect(port, '127.0.0.1', () => {
      socket.write(
        encodePacket({
          name: 'handshake',
          problems: [['aplusb', 0]],
          executors: Object.fromEntries(executors.map((key) => [key, {}])),
          id,
          key: 'k',
        }),
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
const settle = () => new Promise((r) => setTimeout(r, 300));

/**
 * A two-row stand-in for `language_driver_keys`, not the constant
 * `() => 'CPP17'` the affinity suite uses: a test that maps every language to
 * the same executor cannot tell a routed dispatch from a broadcast one.
 *
 * A TABLE, and no longer `executor.toLowerCase()` — which is the fallback
 * F-47 removed (D172). Keeping it here would have left the suite that most
 * closely models a heterogeneous fleet asserting against the exact behaviour
 * that manufactured `pas` in production.
 */
const ROWS: Record<string, string> = { cpp17: 'CPP17', py3: 'PY3' };
const LANGUAGE_MAP = {
  languageToExecutor: (key: string) => ROWS[key] ?? key.toUpperCase(),
  executorToLanguage: (executor: string) =>
    Object.entries(ROWS).find(([, value]) => value === executor)?.[0],
};

describe('a fleet of two judges', () => {
  let server: BridgeServer | undefined;
  const judges: ReturnType<typeof fakeJudge>[] = [];
  const capabilityWrites: Array<[string, JudgeCapabilities]> = [];

  afterEach(async () => {
    for (const judge of judges) judge.close();
    judges.length = 0;
    capabilityWrites.length = 0;
    await server?.close();
    server = undefined;
  });

  async function bridge(fleet: Array<[string, string[]]>) {
    server = new BridgeServer({
      ...LANGUAGE_MAP,
      verifyJudge: async () => true,
      recordCapabilities: async (id, capabilities) => {
        capabilityWrites.push([id, capabilities]);
      },
    });
    const port = await server.listen(0);
    for (const [id, executors] of fleet) judges.push(fakeJudge(port, id, executors));
    for (const judge of judges) await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(fleet.length), 10_000);
    return { server: server!, port, driver: new DmojDriver(server!, fakeAgent()) };
  }

  it('runs two jobs at once, one on each node, and tells the caller which', async () => {
    const { driver } = await bridge([
      ['judge-1', ['CPP17']],
      ['judge-2', ['CPP17']],
    ]);
    const [first, second] = judges as [ReturnType<typeof fakeJudge>, ReturnType<typeof fakeJudge>];

    const seenA: GradingEvent[] = [];
    const seenB: GradingEvent[] = [];
    await driver.dispatch(makeJob('71'), async (e) => void seenA.push(e));
    await driver.dispatch(makeJob('72'), async (e) => void seenB.push(e));

    // Concurrently, not one after the other: neither dispatch waited for the
    // other's grading-end, and each judge holds exactly one submission.
    await vi.waitFor(() => {
      expect(first.requests()).toHaveLength(1);
      expect(second.requests()).toHaveLength(1);
    }, 10_000);
    expect(first.requests()[0]!['submission-id']).toBe(71);
    expect(second.requests()[0]!['submission-id']).toBe(72);

    // The `dispatched` event names the node, which is what makes
    // `grading_jobs.judge_node_id` a fact rather than a guess (D68).
    expect(seenA[0]).toEqual({ type: 'dispatched', node: 'judge-1' });
    expect(seenB[0]).toEqual({ type: 'dispatched', node: 'judge-2' });
    // Two grades in flight at once — the capacity a second judge buys.
    expect(driver.capabilities().concurrency).toBe(2);
  }, 30_000);

  it('terminates on the node actually running that submission, and only there', async () => {
    const { driver } = await bridge([
      ['judge-1', ['CPP17']],
      ['judge-2', ['CPP17']],
    ]);
    const [first, second] = judges as [ReturnType<typeof fakeJudge>, ReturnType<typeof fakeJudge>];

    const seen: GradingEvent[] = [];
    await driver.dispatch(makeJob('81'), async () => {});
    await vi.waitFor(() => expect(first.requests()).toHaveLength(1), 10_000);
    await driver.dispatch(makeJob('82'), async (e) => void seen.push(e));
    await vi.waitFor(() => expect(second.requests()).toHaveLength(1), 10_000);

    await driver.cancel('82', 1);

    // `terminate-submission` carries no submission id (D29), so landing on
    // judge-1 would kill 81 — a different student's grade.
    await vi.waitFor(() => expect(second.terminates()).toHaveLength(1), 10_000);
    await settle();
    expect(first.terminates()).toHaveLength(0);

    second.send({ name: 'submission-terminated', 'submission-id': 82 });
    await vi.waitFor(() => expect(seen.some((e) => e.type === 'terminated')).toBe(true), 10_000);
    // 81 is untouched and still grades to its own verdict.
    first.send({ name: 'grading-end', 'submission-id': 81 });
    await settle();
    expect(first.terminates()).toHaveLength(0);
  }, 30_000);

  it('never sends a job to a node that cannot run its language', async () => {
    const { driver } = await bridge([
      ['judge-1', ['CPP17']],
      ['judge-2', ['CPP17', 'PY3']],
    ]);
    const [cppOnly, polyglot] = judges as [
      ReturnType<typeof fakeJudge>,
      ReturnType<typeof fakeJudge>,
    ];

    // Both judges are idle, and judge-1 is first in the connection order —
    // so a driver that picks by idleness alone sends this to judge-1, which
    // has no PY3 executor and answers with an internal error the student
    // sees as IE.
    await driver.dispatch(makeJob('91', 'py3'), async () => {});

    await vi.waitFor(() => expect(polyglot.requests()).toHaveLength(1), 10_000);
    await settle();
    expect(cppOnly.requests()).toHaveLength(0);
  }, 30_000);

  it('waits for the one capable node rather than handing the job to an idle incapable one', async () => {
    const { driver } = await bridge([
      ['judge-1', ['CPP17']],
      ['judge-2', ['CPP17', 'PY3']],
    ]);
    const [cppOnly, polyglot] = judges as [
      ReturnType<typeof fakeJudge>,
      ReturnType<typeof fakeJudge>,
    ];

    await driver.dispatch(makeJob('92', 'py3'), async () => {});
    await vi.waitFor(() => expect(polyglot.requests()).toHaveLength(1), 10_000);

    let sent = false;
    const second = driver.dispatch(makeJob('93', 'py3'), async () => {}).then(() => {
      sent = true;
    });
    await settle();
    expect(sent).toBe(false);
    expect(cppOnly.requests()).toHaveLength(0);

    polyglot.send({ name: 'grading-end', 'submission-id': 92 });
    await second;
    await vi.waitFor(() => expect(polyglot.requests()).toHaveLength(2), 10_000);
    expect(cppOnly.requests()).toHaveLength(0);
  }, 30_000);

  it('rejects with NoCapableJudgeError when nothing connected speaks the language', async () => {
    const { driver } = await bridge([['judge-1', ['CPP17']]]);

    await expect(driver.dispatch(makeJob('94', 'py3'), async () => {})).rejects.toBeInstanceOf(
      NoCapableJudgeError,
    );
    await settle();
    expect(judges[0]!.requests()).toHaveLength(0);
  }, 30_000);

  it('gives up a parked dispatch when the only capable judge disconnects', async () => {
    const { driver } = await bridge([
      ['judge-1', ['CPP17']],
      ['judge-2', ['CPP17', 'PY3']],
    ]);
    const polyglot = judges[1]!;

    await driver.dispatch(makeJob('95', 'py3'), async () => {});
    await vi.waitFor(() => expect(polyglot.requests()).toHaveLength(1), 10_000);
    const parked = driver.dispatch(makeJob('96', 'py3'), async () => {});

    // Parking forever is the failure this replaces: the caller's only other
    // way out is the grading ceiling, minutes later, and a job blocked on a
    // judge that will never return should be requeued now (D68).
    polyglot.close();

    await expect(parked).rejects.toBeInstanceOf(NoCapableJudgeError);
  }, 30_000);

  it('reports the fleet vocabulary as the union of what the judges announced', async () => {
    const { driver, port } = await bridge([['judge-1', ['CPP17']]]);
    expect(driver.supportedLanguages()).toEqual(['cpp17']);

    const polyglot = fakeJudge(port, 'judge-2', ['CPP17', 'PY3']);
    judges.push(polyglot);
    await polyglot.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(2), 10_000);

    expect([...driver.supportedLanguages()].sort()).toEqual(['cpp17', 'py3']);

    // And it shrinks again: a claim loop that kept claiming py3 work after
    // the only py3 judge left would lease jobs nothing can run.
    polyglot.close();
    await vi.waitFor(() => expect(driver.supportedLanguages()).toEqual(['cpp17']), 10_000);
  }, 30_000);

  it("records each judge's capabilities on its handshake", async () => {
    await bridge([
      ['judge-1', ['CPP17']],
      ['judge-2', ['CPP17', 'PY3']],
    ]);

    await vi.waitFor(() => expect(capabilityWrites).toHaveLength(2), 10_000);
    expect(Object.fromEntries(capabilityWrites)).toEqual({
      'judge-1': { languages: ['cpp17'], executors: ['CPP17'], concurrency: 1, problems: 1 },
      'judge-2': {
        languages: ['cpp17', 'py3'],
        executors: ['CPP17', 'PY3'],
        concurrency: 1,
        problems: 1,
      },
    });
  }, 30_000);
});
