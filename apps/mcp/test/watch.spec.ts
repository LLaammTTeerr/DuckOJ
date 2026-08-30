/**
 * `submissions_watch`: what makes it stop.
 *
 * Three ways out, and each is a different answer to the caller: the verdict
 * arrived, the deadline passed while the judge was still working (a NORMAL
 * result — call again), or the credential/submission was refused outright (an
 * error, immediately, because retrying a 404 five times only delays the
 * message). The transient tolerance sits between the last two: a dropped
 * packet must not abandon a submission that is grading perfectly well.
 */
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools.js';
import { ApiFailure } from '../src/errors.js';
import { fakeContext, json, problem, stub } from './harness.js';

const watch = TOOLS.find((tool) => tool.name === 'submissions_watch')!;

function detail(state: string, verdict: string | null = null) {
  return {
    id: 7,
    problemCode: 'tong-hai-so',
    languageKey: 'cpp17',
    source: null,
    state,
    verdict,
    points: verdict === null ? null : 100,
    maxPoints: verdict === null ? null : 100,
    timeMs: 5,
    memoryKb: 100,
    compileOutput: null,
    cases: [
      { groupIndex: 0, caseIndex: 0, verdict: 'AC', skipped: false, timeMs: 1, memoryKb: 1, points: 100, maxPoints: 100, feedback: null },
    ],
    contestKey: null,
    contestLabel: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    judgedAt: null,
    frozen: false,
    sourceHidden: false,
  };
}

describe('submissions_watch', () => {
  it('polls until the submission leaves the pipeline and then stops', async () => {
    const states = ['queued', 'compiling', 'grading', 'done'];
    let index = 0;
    const stubbed = stub(() => {
      const state = states[Math.min(index++, states.length - 1)]!;
      return json(detail(state, state === 'done' ? 'AC' : null));
    });
    const outcome = await watch.run(stubbed.client, { id: 7 }, fakeContext());
    expect(stubbed.calls).toHaveLength(4);
    expect(outcome.summary).toBe('#7 tong-hai-so: AC 100/100');
    expect(outcome.data).toMatchObject({ verdict: 'AC', timedOut: false, polls: 4 });
  });

  it('answers `timedOut` rather than failing when the judge is still working', async () => {
    const stubbed = stub(() => json(detail('grading')));
    const outcome = await watch.run(stubbed.client, { id: 7, timeoutSeconds: 6 }, fakeContext());
    expect(outcome.data).toMatchObject({ timedOut: true, state: 'grading' });
    expect(outcome.summary).toContain('call submissions_watch again');
    // Three polls at two seconds fills the six-second budget; a fourth would
    // overrun the host's own patience, which is what the deadline is for.
    expect(stubbed.calls).toHaveLength(3);
  });

  it('gives up immediately on a refused credential', async () => {
    const stubbed = stub(() => problem(401, { code: 'unauthorized', detail: 'no' }));
    const failure = (await watch
      .run(stubbed.client, { id: 7 }, fakeContext())
      .catch((err: unknown) => err)) as ApiFailure;
    expect(failure).toBeInstanceOf(ApiFailure);
    expect(failure.status).toBe(401);
    expect(stubbed.calls).toHaveLength(1);
  });

  it('gives up immediately on a submission that does not exist', async () => {
    const stubbed = stub(() => problem(404, { code: 'submission_not_found', detail: 'no' }));
    const failure = (await watch
      .run(stubbed.client, { id: 7 }, fakeContext())
      .catch((err: unknown) => err)) as ApiFailure;
    expect(failure.code).toBe('not_found');
    expect(stubbed.calls).toHaveLength(1);
  });

  it('survives a blip: five bad gateways in a row, then the verdict', async () => {
    let call = 0;
    const stubbed = stub(() => {
      call++;
      if (call <= 5) return new Response('', { status: 502 });
      return json(detail('done', 'AC'));
    });
    const outcome = await watch.run(stubbed.client, { id: 7 }, fakeContext());
    expect(outcome.data).toMatchObject({ verdict: 'AC' });
    expect(stubbed.calls).toHaveLength(6);
  });

  it('stops once the blip is an outage', async () => {
    const stubbed = stub(() => new Response('', { status: 502 }));
    const failure = (await watch
      .run(stubbed.client, { id: 7 }, fakeContext())
      .catch((err: unknown) => err)) as ApiFailure;
    expect(failure.code).toBe('transport_error');
    expect(stubbed.calls).toHaveLength(6);
  });

  it('treats `errored` as terminal, not as something to keep polling', async () => {
    const stubbed = stub(() => json(detail('errored')));
    const outcome = await watch.run(stubbed.client, { id: 7 }, fakeContext());
    expect(stubbed.calls).toHaveLength(1);
    expect(outcome.data).toMatchObject({ state: 'errored', timedOut: false });
  });
});
