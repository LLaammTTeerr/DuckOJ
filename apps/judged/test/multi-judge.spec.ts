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

function makeJob(id: string, language = 'cpp17', attempt = 1): GradingJob {
  return {
    id,
    attempt,
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

  /**
   * B-36. DMOJ's `submission-id` carries our grading JOB id, and a retry
   * reuses that id with a higher `attempt` — so `live`, a Map keyed by job id
   * alone, holds attempt N+1's entry while attempt N's packets are still in
   * flight from the judge it was terminated on. Two connections are what makes
   * the race expressible at all: attempt N on judge-1, attempt N+1 on judge-2,
   * and a packet arriving on the wrong one.
   *
   * D29 narrowed this window by terminating on the owning connection and not
   * handing it out again until the judge answers, and said in as many words
   * that timing is not a proof. These are the proof.
   */
  describe('a retry that reuses the job id', () => {
    /**
     * Leaves attempt 1 terminated-but-unanswered on judge-1 and attempt 2
     * live on judge-2 — the exact state in which a stale packet is routable
     * to the wrong attempt.
     */
    async function supersede(driver: DmojDriver) {
      const [first, second] = judges as [
        ReturnType<typeof fakeJudge>,
        ReturnType<typeof fakeJudge>,
      ];
      const attemptOne: GradingEvent[] = [];
      const attemptTwo: GradingEvent[] = [];

      await driver.dispatch(makeJob('7', 'cpp17', 1), async (e) => void attemptOne.push(e));
      await vi.waitFor(() => expect(first.requests()).toHaveLength(1), 10_000);

      await driver.cancel('7', 1);
      // The terminate is on the wire; judge-1 has NOT yet answered, which is
      // precisely the window D29 left open.
      await vi.waitFor(() => expect(first.terminates()).toHaveLength(1), 10_000);

      await driver.dispatch(makeJob('7', 'cpp17', 2), async (e) => void attemptTwo.push(e));
      await vi.waitFor(() => expect(second.requests()).toHaveLength(1), 10_000);
      expect(second.requests()[0]!['submission-id']).toBe(7);

      return { first, second, attemptOne, attemptTwo };
    }

    it("drops attempt 1's grading-end instead of finalising attempt 2 with it", async () => {
      const { driver } = await bridge([
        ['judge-1', ['CPP17']],
        ['judge-2', ['CPP17']],
      ]);
      const { first, attemptTwo } = await supersede(driver);

      // Attempt 1's run reached its end on judge-1 anyway — the terminate and
      // the last packets crossed on the wire.
      first.send({ name: 'grading-end', 'submission-id': 7 });
      await settle();

      // Attempt 2 is still compiling. A verdict here would be computed from
      // the PREVIOUS run's cases and written to the submission as final.
      expect(attemptTwo.map((e) => e.type)).toEqual(['dispatched']);
    }, 30_000);

    it("drops attempt 1's test-case-status instead of moving attempt 2's counters", async () => {
      const { driver } = await bridge([
        ['judge-1', ['CPP17']],
        ['judge-2', ['CPP17']],
      ]);
      const { first, second, attemptTwo } = await supersede(driver);

      // A fat case from the old run: 50 points, worth 50.
      first.send({
        name: 'test-case-status',
        'submission-id': 7,
        cases: [
          {
            position: 1,
            status: 0,
            time: 0.5,
            points: 50,
            'total-points': 50,
            memory: 4096,
            output: '',
            feedback: '',
            'extended-feedback': '',
          },
        ],
      });
      await settle();
      expect(attemptTwo.filter((e) => e.type === 'caseResult')).toHaveLength(0);

      // Attempt 2's own, only, case: one point out of one.
      second.send({
        name: 'test-case-status',
        'submission-id': 7,
        cases: [
          {
            position: 1,
            status: 0,
            time: 0.004,
            points: 1,
            'total-points': 1,
            memory: 900,
            output: '',
            feedback: '',
            'extended-feedback': '',
          },
        ],
      });
      second.send({ name: 'grading-end', 'submission-id': 7 });

      await vi.waitFor(
        () => expect(attemptTwo.some((e) => e.type === 'finished')).toBe(true),
        10_000,
      );
      expect(attemptTwo.filter((e) => e.type === 'caseResult')).toHaveLength(1);
      // 51/51 would be a score summed across two different runs of the same
      // submission, and it does not stop at the submission: D100's
      // `contest_problem_stats` is maintained on write from these events.
      expect(attemptTwo.find((e) => e.type === 'finished')).toMatchObject({
        points: 1,
        maxPoints: 1,
      });
    }, 30_000);

    it('frees the connection a dropped TERMINAL packet arrived on', async () => {
      const { driver } = await bridge([
        ['judge-1', ['CPP17']],
        ['judge-2', ['CPP17']],
      ]);
      const { first, second, attemptTwo } = await supersede(driver);

      // judge-1 finally answers the terminate. Discarding this packet is
      // right — it is not attempt 2's — but discarding it and nothing else
      // would leave judge-1 marked busy with a grade that no longer exists,
      // and a fleet of one would then park every later dispatch forever.
      first.send({ name: 'submission-terminated', 'submission-id': 7 });
      await settle();
      expect(attemptTwo.map((e) => e.type)).toEqual(['dispatched']);

      // Attempt 2 runs to its own end, freeing judge-2 as well.
      second.send({ name: 'grading-end', 'submission-id': 7 });
      await vi.waitFor(
        () => expect(attemptTwo.some((e) => e.type === 'finished')).toBe(true),
        10_000,
      );

      // With both free, the next dispatch takes judge-1 — the first
      // connection in handshake order. It can only do that if the stale
      // assignment was actually released.
      await driver.dispatch(makeJob('99'), async () => {});
      await vi.waitFor(() => expect(first.requests()).toHaveLength(2), 10_000);
      expect(first.requests().map((r) => r['submission-id'])).toContain(99);
    }, 30_000);

    /**
     * Deliberately a fleet of ONE, in the suite about two: that is the
     * topology this repository ships (D29's `JUDGED_CONCURRENCY=1`, one loop
     * per judge), and it is the only one in which the release above is load
     * bearing rather than tidy. With two judges the retry has somewhere else
     * to go; with one it is PARKED in `acquireConnection`, and the stale
     * packet's release is the only thing that ever wakes it.
     */
    it('wakes the parked retry when the superseded attempt frees the only judge', async () => {
      const { driver } = await bridge([['judge-1', ['CPP17']]]);
      const [only] = judges as [ReturnType<typeof fakeJudge>];

      await driver.dispatch(makeJob('7', 'cpp17', 1), async () => {});
      await vi.waitFor(() => expect(only.requests()).toHaveLength(1), 10_000);
      await driver.cancel('7', 1);
      await vi.waitFor(() => expect(only.terminates()).toHaveLength(1), 10_000);

      // NOT awaited: with the one judge still marked busy, this parks inside
      // `acquireConnection` and resolves only once something frees it.
      const attemptTwo: GradingEvent[] = [];
      const retry = driver.dispatch(makeJob('7', 'cpp17', 2), async (e) => void attemptTwo.push(e));

      // The judge answers the terminate. Attempt 1 is over; attempt 2 has not
      // begun, and must not be told anything about attempt 1's ending.
      only.send({ name: 'submission-terminated', 'submission-id': 7 });

      await retry;
      await vi.waitFor(() => expect(only.requests()).toHaveLength(2), 10_000);
      // Exactly one event, and it is the retry's own start — not a
      // `terminated` for a run that had not started when it was written.
      expect(attemptTwo.map((e) => e.type)).toEqual(['dispatched']);
    }, 30_000);
  });
});
