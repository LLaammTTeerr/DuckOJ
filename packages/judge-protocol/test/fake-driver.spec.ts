import { describe, expect, it } from 'vitest';
import { FakeDriver, type GradingEvent, type GradingJob } from '../src/index.js';

const job: GradingJob = {
  id: '1',
  attempt: 1,
  kind: 'submission',
  packageHash: 'abc',
  revisionId: '1',
  language: 'cpp17',
  source: 'int main(){}',
  limits: { timeMs: 1000, memoryKb: 65536 },
};

describe('FakeDriver', () => {
  it('emits the scripted events in order', async () => {
    const driver = new FakeDriver();
    driver.script('1', [
      { type: 'compiling' },
      { type: 'finished', verdict: 'AC', points: 1, maxPoints: 1, timeMs: 5, memoryKb: 100 },
    ]);
    const seen: GradingEvent[] = [];

    await driver.dispatch(job, async (e) => void seen.push(e));

    expect(seen.map((e) => e.type)).toEqual(['dispatched', 'compiling', 'finished']);
  });

  it('reports its capabilities', () => {
    expect(new FakeDriver().capabilities()).toEqual({ languages: ['cpp17'], concurrency: 1 });
  });

  it('emits terminated when a dispatched job is cancelled', async () => {
    const driver = new FakeDriver();
    driver.script('1', [{ type: 'compiling' }]);
    const seen: GradingEvent[] = [];

    await driver.dispatch(job, async (e) => void seen.push(e));
    await driver.cancel('1', 1);

    expect(seen.at(-1)).toEqual({ type: 'terminated' });
  });

  it('ignores a cancel carrying a stale attempt', async () => {
    const driver = new FakeDriver();
    driver.script('1', [{ type: 'compiling' }]);
    const seen: GradingEvent[] = [];

    await driver.dispatch(job, async (e) => void seen.push(e));
    await driver.cancel('1', 0);

    expect(seen.map((e) => e.type)).not.toContain('terminated');
  });
});
