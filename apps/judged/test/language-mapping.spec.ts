/**
 * F-47 / D172, D173 — what the bridge does with an executor it has no
 * language for, and what happens when it acquires one while running.
 *
 * The incident, exactly: the judge self-tested `PAS`, announced it, and
 * `judged` — whose mapping had been read at boot, before migration 0046
 * inserted the `pascal` row — reported
 *
 *   ["c11","cpp14","cpp17","cpp20","java","pas","python3"]
 *
 * `pas`, not `pascal`, because `executorToLanguage` fell back to lowercasing
 * the executor name. `PY3 -> py3` and `PAS -> pas` have exactly the shape of
 * a real key, so nothing downstream could tell the fallback from a mapping,
 * and every Pascal submission was blocked against a judge that could run it.
 *
 * Real sockets and real framed packets, like `multi-judge.spec.ts`: both
 * properties are about what the bridge does with what a judge ANNOUNCED, and
 * the announcement is the part an in-process double would invent.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPacketDecoder, encodePacket } from '@duckoj/judge-protocol';
import { BridgeServer, type JudgeCapabilities } from '../src/drivers/dmoj/bridge-server.js';
import { DmojDriver } from '../src/drivers/dmoj/dmoj-driver.js';

/** The live mapping on 2026-09-01, as `language_driver_keys` holds it. */
const SEVEN: Record<string, string> = {
  cpp14: 'CPP14',
  cpp17: 'CPP17',
  cpp20: 'CPP20',
  c11: 'C11',
  python3: 'PY3',
  pascal: 'PAS',
  java: 'JAVA',
};

/** The same mapping as `judged` held it at boot: 0046 had not run yet. */
const FIVE: Record<string, string> = {
  cpp14: 'CPP14',
  cpp17: 'CPP17',
  cpp20: 'CPP20',
  c11: 'C11',
  python3: 'PY3',
};

/** What `--only-executors` lets out of the live judge, F-46's list. */
const ANNOUNCED = ['CPP14', 'CPP17', 'CPP20', 'C11', 'PY3', 'PAS', 'JAVA'];

/**
 * A mapping that can be reloaded, standing in for `loadDriverLanguageMap`
 * over a table a migration is writing to. `rows` is the "database".
 */
function mutableMap(initial: Record<string, string>) {
  let rows = { ...initial };
  let snapshot = new Map(Object.entries(rows).map(([key, executor]) => [executor, key]));
  let toExecutor = new Map(Object.entries(rows));
  return {
    /** Simulates the migration landing. */
    seed(next: Record<string, string>): void {
      rows = { ...next };
    },
    options: {
      languageToExecutor: (key: string) => toExecutor.get(key) ?? key.toUpperCase(),
      executorToLanguage: (executor: string) => snapshot.get(executor),
      refreshLanguageMap: async () => {
        const fresh = new Map(Object.entries(rows).map(([key, executor]) => [executor, key]));
        if (fresh.size === snapshot.size && [...fresh].every(([e, k]) => snapshot.get(e) === k)) {
          return false;
        }
        snapshot = fresh;
        toExecutor = new Map(Object.entries(rows));
        return true;
      },
    },
  };
}

function fakeJudge(port: number, id: string, executors: string[]) {
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
    const decoder = createPacketDecoder({ onPacket: () => {}, onError: () => {} });
    socket.on('data', (c) => decoder.push(c));
    socket.on('error', () => {});
  });
  return { ready, close: () => socket?.destroy() };
}

describe('a judge that announces more than we have rows for (D172)', () => {
  let server: BridgeServer | undefined;
  let judge: ReturnType<typeof fakeJudge> | undefined;
  const capabilityWrites: Array<[string, JudgeCapabilities]> = [];

  afterEach(async () => {
    judge?.close();
    judge = undefined;
    capabilityWrites.length = 0;
    await server?.close();
    server = undefined;
  });

  async function connectFleet(map: ReturnType<typeof mutableMap>) {
    server = new BridgeServer({
      ...map.options,
      verifyJudge: async () => true,
      recordCapabilities: async (id, capabilities) => {
        capabilityWrites.push([id, capabilities]);
      },
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', ANNOUNCED);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);
    return { server: server!, driver: new DmojDriver(server!, { ensure: vi.fn(async () => {}) }) };
  }

  it('drops the unmapped executor instead of lowercasing it into a language', async () => {
    const map = mutableMap(FIVE);
    const { server: bridge } = await connectFleet(map);

    const supported = bridge.supportedLanguages().sort();
    // The exact regression: `PAS` and `JAVA` are announced and unmapped, and
    // the list they used to produce was `[... "java","pas", ...]`.
    expect(supported).toEqual(['c11', 'cpp14', 'cpp17', 'cpp20', 'python3']);
    expect(supported).not.toContain('pas');
    expect(supported).not.toContain('java');
  }, 20_000);

  it('records what the judge said AND only the languages we can name', async () => {
    const map = mutableMap(FIVE);
    await connectFleet(map);

    await vi.waitFor(() => expect(capabilityWrites.length).toBeGreaterThan(0), 10_000);
    const [, capabilities] = capabilityWrites[0]!;
    // `executors` is the judge's own answer, unfiltered — an operator reading
    // the dashboard must be able to see that the judge offered `PAS`.
    expect([...capabilities.executors].sort()).toEqual([...ANNOUNCED].sort());
    // `languages` is what this deployment can actually grade with it.
    expect([...capabilities.languages].sort()).toEqual([
      'c11',
      'cpp14',
      'cpp17',
      'cpp20',
      'python3',
    ]);
  }, 20_000);
});

describe('a language seeded while judged is running (D173)', () => {
  let server: BridgeServer | undefined;
  let judge: ReturnType<typeof fakeJudge> | undefined;
  const capabilityWrites: Array<[string, JudgeCapabilities]> = [];

  afterEach(async () => {
    judge?.close();
    judge = undefined;
    capabilityWrites.length = 0;
    await server?.close();
    server = undefined;
  });

  async function connectFleet(map: ReturnType<typeof mutableMap>) {
    server = new BridgeServer({
      ...map.options,
      verifyJudge: async () => true,
      recordCapabilities: async (id, capabilities) => {
        capabilityWrites.push([id, capabilities]);
      },
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', ANNOUNCED);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);
    return { server: server!, driver: new DmojDriver(server!, { ensure: vi.fn(async () => {}) }) };
  }

  it('becomes gradeable through the claim loop’s refresh, with no reconnect', async () => {
    const map = mutableMap(FIVE);
    const { server: bridge, driver } = await connectFleet(map);
    expect(bridge.supportedLanguages()).not.toContain('pascal');

    // Migration 0046 lands against this running process. No judge reconnects
    // — that is the whole point, and why a handshake trigger alone would not
    // have covered the incident.
    map.seed(SEVEN);

    expect(await driver.refreshCapabilities()).toBe(true);
    expect(bridge.supportedLanguages().sort()).toEqual([
      'c11',
      'cpp14',
      'cpp17',
      'cpp20',
      'java',
      'pascal',
      'python3',
    ]);
    // A second refresh over unchanged rows reports nothing, so the claim
    // loop's five-second scan does not re-announce forever.
    expect(await driver.refreshCapabilities()).toBe(false);
  }, 20_000);

  it('re-announces capabilities, so the dashboard stops under-reporting the judge', async () => {
    const map = mutableMap(FIVE);
    const { driver } = await connectFleet(map);
    await vi.waitFor(() => expect(capabilityWrites.length).toBeGreaterThan(0), 10_000);
    const before = capabilityWrites.length;

    map.seed(SEVEN);
    await driver.refreshCapabilities();

    await vi.waitFor(() => expect(capabilityWrites.length).toBeGreaterThan(before), 10_000);
    const [, capabilities] = capabilityWrites.at(-1)!;
    expect([...capabilities.languages].sort()).toEqual([
      'c11',
      'cpp14',
      'cpp17',
      'cpp20',
      'java',
      'pascal',
      'python3',
    ]);
  }, 20_000);

  it('refreshes on handshake too, for the judge that dials in after a migration', async () => {
    const map = mutableMap(FIVE);
    // Rows already widened before this judge ever connects — the ordinary
    // deploy, where `judged` outlives the migration but the judge restarts.
    map.seed(SEVEN);
    const { server: bridge } = await connectFleet(map);

    await vi.waitFor(
      () => expect(bridge.supportedLanguages()).toContain('pascal'),
      { timeout: 10_000 },
    );
  }, 20_000);

  it('keeps the mapping it has when the reload fails', async () => {
    server = new BridgeServer({
      languageToExecutor: (key) => SEVEN[key] ?? key.toUpperCase(),
      executorToLanguage: (executor) =>
        Object.entries(SEVEN).find(([, value]) => value === executor)?.[0],
      refreshLanguageMap: async () => {
        throw new Error('database went away');
      },
      verifyJudge: async () => true,
    });
    const port = await server.listen(0);
    judge = fakeJudge(port, 'judge-1', ANNOUNCED);
    await judge.ready;
    await vi.waitFor(() => expect(server!.judgeCount()).toBe(1), 10_000);

    const driver = new DmojDriver(server, { ensure: vi.fn(async () => {}) });
    // Fail open: no throw, no shrinkage, and the judge keeps its connection.
    expect(await driver.refreshCapabilities()).toBe(false);
    expect(server.judgeCount()).toBe(1);
    expect(server.supportedLanguages()).toHaveLength(7);
  }, 20_000);
});
