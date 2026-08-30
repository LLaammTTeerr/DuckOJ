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
  showProblem,
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

/**
 * D102. Every command's failure message used to be its own guess at what
 * went wrong, and for this refusal every one of those guesses is wrong: an
 * imported pupil's token is not "bad" and their problem is not "could not
 * list problems". The fix is three clicks away in a browser they are not
 * looking at, so the message has to say so — this is the only refusal in the
 * CLI whose remedy is not in the CLI.
 */
describe('password_change_required (D102)', () => {
  const refusal = {
    data: undefined,
    error: { code: 'password_change_required', detail: 'Change your password first.' },
    response: { headers: new Headers() },
  };

  it('names the web interface instead of the command\'s own guess', async () => {
    const get = vi.fn().mockResolvedValue(refusal);
    await expect(whoami(clientWith({ GET: get }), fakeIo())).rejects.toThrow(/web interface/i);
    await expect(listProblems(clientWith({ GET: get }), fakeIo())).rejects.toThrow(/web interface/i);
    await expect(showProblem(clientWith({ GET: get }), fakeIo(), 'aplusb')).rejects.toThrow(
      /web interface/i,
    );
  });

  it('stops watch on the first poll instead of calling it a flaky judge', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue({ ...refusal, response: { status: 409 } });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(watch(clientWith({ GET: get }), io, 7, sleep)).rejects.toThrow(/web interface/i);
    expect(get).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('says it on submit too, rather than "submission refused"', async () => {
    const post = vi.fn().mockResolvedValue(refusal);
    await expect(
      submit(clientWith({ POST: post }), fakeIo(), {
        problemCode: 'aplusb',
        source: 'int main(){}',
        languageKey: 'cpp17',
      }),
    ).rejects.toThrow(/web interface/i);
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

  /**
   * D80's meter, which is the one refusal somebody driving `oj` in a loop
   * will actually meet. "submission refused: You are submitting too quickly"
   * says nothing about how to stop being refused; the seconds are the whole
   * answer, and they are in `Retry-After`.
   */
  it('prints the wait when the meter refuses (D80)', async () => {
    const post = vi.fn().mockResolvedValue({
      data: undefined,
      error: { code: 'submission_rate_limited', detail: 'You are submitting too quickly.' },
      response: { headers: new Headers({ 'Retry-After': '9' }) },
    });
    await expect(
      submit(clientWith({ POST: post }), fakeIo(), { problemCode: 'a', source: 's', languageKey: 'cpp17' }),
    ).rejects.toThrow(/try again in 9s/);
  });

  it('still names the meter when no Retry-After came back', async () => {
    const post = vi.fn().mockResolvedValue({
      data: undefined,
      error: { code: 'submission_rate_limited', detail: 'You are submitting too quickly.' },
      response: { headers: new Headers() },
    });
    await expect(
      submit(clientWith({ POST: post }), fakeIo(), { problemCode: 'a', source: 's', languageKey: 'cpp17' }),
    ).rejects.toThrow(/too quickly/);
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

  /**
   * A CE is the one terminal verdict whose whole meaning lives in a field
   * `watch` never printed: `compileOutput`. The CLI reported `CE` and stopped,
   * so a caller driving `oj` had no way to see WHY it failed to compile short
   * of re-fetching the submission by hand — while `GET /submissions/{id}` had
   * been returning the diagnostics all along.
   */
  it('prints the compile output on a compile error, not just the verdict', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue({
      data: {
        state: 'done',
        verdict: 'CE',
        points: null,
        maxPoints: null,
        compileOutput: 'solution.cpp:1:13: error: invalid use of ‘this’',
      },
    });
    await watch(clientWith({ GET: get }), io, 7, vi.fn());
    expect(io.lines).toEqual(['done', 'CE', 'solution.cpp:1:13: error: invalid use of ‘this’']);
  });

  it('prints a compile WARNING beside a verdict that is not CE', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue({
      data: {
        state: 'done',
        verdict: 'WA',
        points: 0,
        maxPoints: 100,
        compileOutput: 'solution.cpp:3:7: warning: unused variable',
      },
    });
    await watch(clientWith({ GET: get }), io, 7, vi.fn());
    expect(io.lines.at(-1)).toBe('solution.cpp:3:7: warning: unused variable');
  });

  /**
   * One dropped packet used to end a watch. Every failed poll — a network
   * blip, the API restarting behind the reverse proxy, a 502 from Caddy —
   * went straight to `io.fail`, so `oj submit --watch` on contest day
   * abandoned a submission that was grading perfectly well, and printed
   * "could not read submission" as if the submission were the problem.
   */
  it('rides out a transient failure instead of abandoning the submission', async () => {
    const io = fakeIo();
    const get = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ error: { detail: 'upstream' }, response: { status: 502 } })
      .mockResolvedValueOnce(detail('done', 'AC', 100));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await watch(clientWith({ GET: get }), io, 7, sleep);
    expect(io.lines).toEqual(['done', 'AC 100/100']);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('still gives up once the failures stop being transient', async () => {
    const get = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(watch(clientWith({ GET: get }), fakeIo(), 7, vi.fn())).rejects.toThrow(
      /consecutive/,
    );
    // Bounded by the tolerance, not by the 150-poll budget: five minutes of
    // sleeping on a host that is plainly not there is not "waiting".
    expect(get.mock.calls.length).toBeLessThan(10);
  });

  /**
   * A refused credential is not transient, and retrying it five times before
   * saying "could not read submission #7" tells the operator the wrong thing
   * about the wrong subject. The token is what needs renewing.
   */
  it('names an expired token rather than blaming the submission', async () => {
    const get = vi.fn().mockResolvedValue({ error: { detail: 'nope' }, response: { status: 401 } });
    await expect(watch(clientWith({ GET: get }), fakeIo(), 7, vi.fn())).rejects.toThrow(/token/i);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('gives up at once on a submission that does not exist', async () => {
    const get = vi.fn().mockResolvedValue({ error: { detail: 'nope' }, response: { status: 404 } });
    await expect(watch(clientWith({ GET: get }), fakeIo(), 7, vi.fn())).rejects.toThrow(/#7/);
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

describe('showProblem', () => {
  const detail = {
    code: 'tong-hai-so',
    name: 'Tổng hai số',
    timeMs: 1000,
    memoryKb: 262144,
    totalPoints: 100,
    samples: [
      { input: '2 3\n', output: '5\n', explanation: null, truncated: false },
      { input: '10 20\n', output: '30\n', explanation: 'Cộng hai số.', truncated: true },
    ],
  };

  it('prints the limits and every sample as fenced blocks, without the file\'s trailing newline doubling', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue({ data: detail });
    await showProblem(clientWith({ GET: get }), io, 'tong-hai-so');
    expect(get.mock.calls[0]![1]).toEqual({ params: { path: { code: 'tong-hai-so' } } });
    expect(io.lines).toEqual([
      'tong-hai-so\tTổng hai số',
      'limits: 1000 ms, 262144 KB · 100 points',
      '--- sample 1 input',
      '2 3',
      '--- sample 1 output',
      '5',
      '--- sample 2 input (truncated)',
      '10 20',
      '--- sample 2 output',
      '30',
      '--- sample 2 note: Cộng hai số.',
    ]);
  });

  it('says so rather than printing nothing when the problem has no samples', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue({ data: { ...detail, samples: [] } });
    await showProblem(clientWith({ GET: get }), io, 'p');
    expect(io.lines.at(-1)).toContain('no samples');
  });

  it('survives an API deployed before D94, which sends no samples key at all', async () => {
    const io = fakeIo();
    const get = vi.fn().mockResolvedValue({ data: { ...detail, samples: undefined } });
    await showProblem(clientWith({ GET: get }), io, 'p');
    expect(io.lines.at(-1)).toContain('no samples');
  });

  it('fails with the code in the message when the problem cannot be read', async () => {
    const get = vi.fn().mockResolvedValue({ error: { code: 'problem_not_found' } });
    await expect(showProblem(clientWith({ GET: get }), fakeIo(), 'nope')).rejects.toThrow(/nope/);
  });
});
