/**
 * The stress hook, against a deliberately wrong "model" and a brute-force
 * oracle. The generator contract under test is the documented one: one
 * argument, one complete case on stdout.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadProblem, runStress } from '../src/index.js';
import { cleanupFixtures, cloneFixture } from './helpers.js';

afterAll(cleanupFixtures);

const SLOW = 120_000;

const GEN = `import random, sys
random.seed(int(sys.argv[1]))
print(random.randint(1, 20), random.randint(1, 20))
`;

const BRUTE = `import sys
a, b = map(int, sys.stdin.read().split())
print(a + b)
`;

async function fixtureWithScripts(): Promise<{ dir: string; gen: string; brute: string }> {
  const dir = await cloneFixture('polygon-good');
  const gen = join(dir, 'stress-gen.py');
  const brute = join(dir, 'brute.py');
  await writeFile(gen, GEN);
  await writeFile(brute, BRUTE);
  return { dir, gen, brute };
}

describe('runStress', () => {
  it(
    'finds no counterexample when the model agrees with the brute force',
    async () => {
      const { dir, gen, brute } = await fixtureWithScripts();
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      const result = await runStress(problem, { gen, brute, rounds: 15 });
      expect(result.counterexample).toBeNull();
      expect(result.ran).toBe(15);
    },
    SLOW,
  );

  it(
    'reports the first case on which the model and the brute force disagree',
    async () => {
      const { dir, gen, brute } = await fixtureWithScripts();
      const wrong = join(dir, 'wrong.py');
      await writeFile(wrong, 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a - b)\n');
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      const result = await runStress(problem, { gen, brute, rounds: 15, model: wrong });
      expect(result.counterexample).not.toBeNull();
      expect(result.counterexample?.seed).toBe(1);
      expect(result.counterexample?.detail).toContain('WA');
      expect(result.counterexample?.input.trim().split(/\s+/)).toHaveLength(2);
    },
    SLOW,
  );

  it(
    'refuses a brute force that fails, rather than calling it a counterexample',
    async () => {
      const { dir, gen } = await fixtureWithScripts();
      const broken = join(dir, 'broken.py');
      await writeFile(broken, 'import sys\nraise SystemExit(3)\n');
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      await expect(runStress(problem, { gen, brute: broken, rounds: 3 })).rejects.toThrow(
        /brute force failed/,
      );
    },
    SLOW,
  );

  it(
    'refuses a generator this loop cannot run',
    async () => {
      const { dir, brute } = await fixtureWithScripts();
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      await expect(
        runStress(problem, { gen: join(dir, 'statement.md'), brute, rounds: 1 }),
      ).rejects.toThrow(/expected a \.cpp or a \.py/);
    },
    SLOW,
  );
});
