/**
 * The commands against a doubled client. The doubles return contract-shaped
 * bodies; what is being pinned is the CLI's behaviour around them — what it
 * prints, when it fails, and (for watch) that it stops polling the moment
 * the pipeline is done.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CliError,
  inferLanguage,
  listProblems,
  submit,
  watch,
  whoami,
  type Client,
  type Io,
} from '../src/commands.js';

function fakeIo(): Io & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    print: (line) => lines.push(line),
    fail: (message) => {
      throw new CliError(message);
    },
  };
}

function clientWith(handlers: { GET?: unknown; POST?: unknown }): Client {
  return { GET: handlers.GET ?? vi.fn(), POST: handlers.POST ?? vi.fn() } as unknown as Client;
}

describe('inferLanguage', () => {
  it('maps .cpp to cpp17 and lets --language override it', () => {
    const io = fakeIo();
    expect(inferLanguage('a.cpp', undefined, io)).toBe('cpp17');
    expect(inferLanguage('a.cpp', 'python3', io)).toBe('python3');
  });

  it('refuses to guess for an unknown extension', () => {
    expect(() => inferLanguage('a.rs', undefined, fakeIo())).toThrow(/--language/);
  });
});

describe('whoami', () => {
  it('prints the signed-in identity', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue({ data: { username: 'lam', globalRole: 'setter' } });
    await whoami(clientWith({ GET: get }), io);
    expect(io.lines).toEqual(['lam (setter)']);
  });

  it('fails with the login hint when the token is bad', async () => {
    const get = vi.fn().mockResolvedValue({ data: undefined, error: {} });
    await expect(whoami(clientWith({ GET: get }), fakeIo())).rejects.toThrow(/oj login/);
  });
});

describe('submit', () => {
  it('posts the contract body and prints the id', async () => {
    const io = fakeIo();
    const post = vi.fn().mockResolvedValue({ data: { id: 42 } });
    const id = await submit(clientWith({ POST: post }), io, {
      problemCode: 'aplusb',
      source: 'int main(){}',
      languageKey: 'cpp17',
    });
    expect(id).toBe(42);
    expect(post).toHaveBeenCalledWith('/submissions', {
      body: { problemCode: 'aplusb', languageKey: 'cpp17', source: 'int main(){}' },
    });
    // No contestKey key at all when absent — a present-but-undefined key
    // would travel into the JSON body.
    expect(Object.keys((post.mock.calls[0] as [string, { body: object }])[1].body)).toEqual([
      'problemCode',
      'languageKey',
      'source',
    ]);
    expect(io.lines).toEqual(['submitted #42']);
  });

  it('carries the contest key when given', async () => {
    const post = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await submit(clientWith({ POST: post }), fakeIo(), {
      problemCode: 'aplusb',
      source: 's',
      languageKey: 'cpp17',
      contestKey: 'spring',
    });
    const [, options] = post.mock.calls[0] as [string, { body: { contestKey?: string } }];
    expect(options.body.contestKey).toBe('spring');
  });

  it('surfaces the API detail on refusal', async () => {
    const post = vi.fn().mockResolvedValue({ data: undefined, error: { detail: 'Join the contest first.' } });
    await expect(
      submit(clientWith({ POST: post }), fakeIo(), { problemCode: 'a', source: 's', languageKey: 'cpp17' }),
    ).rejects.toThrow(/Join the contest first/);
  });
});

describe('watch', () => {
  const detail = (state: string, verdict: string | null = null, points: number | null = null) => ({
    data: { state, verdict, points, maxPoints: points === null ? null : 100 },
  });

  it('prints each state once and the verdict with points at the end', async () => {
    const io = fakeIo();
    const get = vi
      .fn()
      .mockResolvedValueOnce(detail('queued'))
      .mockResolvedValueOnce(detail('grading'))
      .mockResolvedValueOnce(detail('grading'))
      .mockResolvedValueOnce(detail('done', 'AC', 100));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await watch(clientWith({ GET: get }), io, 7, sleep);

    expect(io.lines).toEqual(['queued', 'grading', 'done', 'AC 100/100']);
    // Stops the moment it is done: exactly one poll after the last sleep.
    expect(get).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('an errored submission reports the state rather than hanging forever', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue(detail('errored'));
    await watch(clientWith({ GET: get }), io, 7, vi.fn());
    expect(io.lines.at(-1)).toBe('errored');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget instead of polling forever', async () => {
    const get = vi.fn().mockResolvedValue(detail('queued'));
    await expect(
      watch(clientWith({ GET: get }), fakeIo(), 7, vi.fn(), 3),
    ).rejects.toThrow(/gave up/);
    expect(get).toHaveBeenCalledTimes(3);
  });
});

describe('listProblems', () => {
  it('prints code and name, tab-separated — greppable output is the contract', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue({
      data: { items: [{ code: 'aplusb', name: 'A plus B' }], nextCursor: null },
    });
    await listProblems(clientWith({ GET: get }), io);
    expect(io.lines).toEqual(['aplusb\tA plus B']);
  });
});
