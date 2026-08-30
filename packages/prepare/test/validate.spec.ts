/**
 * The gate, against a fixture that is ready and against one broken thing at a
 * time. Every case here compiles and runs real C++, which is the point: a gate
 * that only reads files would pass a model solution that does not build.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadProblem, validateProblem, type PrepareCheck, type PrepareReport } from '../src/index.js';
import { cleanupFixtures, cloneFixture, write } from './helpers.js';

afterAll(cleanupFixtures);

/** Compiling and running a handful of tiny programs is not a 5 second job. */
const SLOW = 120_000;

function check(report: PrepareReport, id: string): PrepareCheck {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check "${id}" in the report`);
  return found;
}

async function gate(dir: string, code = 'tong-hai-so'): Promise<PrepareReport> {
  return await validateProblem(await loadProblem(dir, { code }));
}

describe('a problem that is ready', () => {
  it(
    'passes every check that applies and skips the ones that do not',
    async () => {
      const report = await gate(await cloneFixture('polygon-good'));
      expect(check(report, 'statement').status).toBe('pass');
      expect(check(report, 'manifest').status).toBe('pass');
      expect(check(report, 'tests').status).toBe('pass');
      expect(check(report, 'limits').status).toBe('pass');
      expect(check(report, 'model').status).toBe('pass');
      // Nothing to compile, nothing declared: skipped, never quietly "passed".
      expect(check(report, 'checker').status).toBe('skip');
      expect(check(report, 'validator').status).toBe('skip');
      expect(check(report, 'matrix').status).toBe('skip');
      expect(report.ok).toBe(true);
    },
    SLOW,
  );

  it(
    'compiles and uses a source checker when the package declares one',
    async () => {
      const report = await gate(await cloneFixture('polygon-checker'));
      expect(check(report, 'checker').status).toBe('pass');
      expect(check(report, 'model').status).toBe('pass');
      expect(report.ok).toBe(true);
    },
    SLOW,
  );

  it(
    'compiles nothing at all under --quick',
    async () => {
      const problem = await loadProblem(await cloneFixture('polygon-good'), { code: 'tong-hai-so' });
      const report = await validateProblem(problem, { quick: true });
      expect(check(report, 'model').status).toBe('skip');
      expect(check(report, 'model').detail).toContain('--quick');
      expect(report.ok).toBe(true);
    },
    SLOW,
  );
});

describe('a test with no answer', () => {
  it(
    'fails the tests check and names the file that is missing',
    async () => {
      const dir = await cloneFixture('polygon-good');
      await rm(join(dir, 'tests', '02.a'));
      const report = await gate(dir);
      const tests = check(report, 'tests');
      expect(tests.status).toBe('fail');
      expect(JSON.stringify(tests.data)).toContain('02.a');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'fails on an EMPTY answer, which is how a crashed model run leaves one',
    async () => {
      const dir = await cloneFixture('polygon-good');
      await writeFile(join(dir, 'tests', '02.a'), '');
      const report = await gate(dir);
      expect(check(report, 'tests').status).toBe('fail');
      expect(check(report, 'tests').detail).toContain('empty answer');
    },
    SLOW,
  );
});

describe('a checker that does not compile', () => {
  it(
    'fails the checker check and does not pretend the model was verified',
    async () => {
      const dir = await cloneFixture('polygon-checker');
      await writeFile(join(dir, 'check.cpp'), 'int main( { this is not C++ }\n');
      const report = await gate(dir);
      expect(check(report, 'checker').status).toBe('fail');
      // The model still has to compile, but nothing can decide its answers.
      expect(check(report, 'model').status).toBe('skip');
      expect(check(report, 'matrix').status).toBe('skip');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );
});

describe('a checker that compiles but crashes', () => {
  it(
    'blames the checker, not the model solution',
    async () => {
      // The hardest case to attribute and the easiest to get wrong: the
      // checker builds, so the `checker` check passes, and then every test
      // comes back `FAIL` — testlib's code for "the checker refused to
      // judge", which `model.ts` already says out loud is "a package bug
      // [that] must never be masked by a solution's own failure". Reported as
      // a model failure it sends a setter to debug a program that is correct.
      const dir = await cloneFixture('polygon-checker');
      await writeFile(join(dir, 'check.cpp'), '#include <cstdlib>\nint main() { abort(); }\n');
      const report = await gate(dir);

      const checker = check(report, 'checker');
      expect(checker.status).toBe('fail');
      expect(checker.detail).toMatch(/FAIL/);

      // Nothing could decide the model's answers, so nothing claims to have.
      expect(check(report, 'model').status).toBe('skip');
      expect(check(report, 'model').detail).not.toMatch(/does not reproduce/);
      expect(check(report, 'matrix').status).toBe('skip');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'still blames the checker when it exits with testlib’s own _fail code',
    async () => {
      // A crash is a signal; `_fail` is exit 3. Both are FAIL and both are
      // the checker's, and a gate that only recognised the crash would let
      // the deliberate one through as a wrong model solution.
      const dir = await cloneFixture('polygon-checker');
      await writeFile(
        join(dir, 'check.cpp'),
        '#include <cstdio>\nint main() { fprintf(stderr, "jury answer unreadable\\n"); return 3; }\n',
      );
      const report = await gate(dir);
      expect(check(report, 'checker').status).toBe('fail');
      expect(check(report, 'model').status).toBe('skip');
    },
    SLOW,
  );
});

describe('a model solution that disagrees with the answers', () => {
  it(
    'fails the model check and reports which tests it got wrong',
    async () => {
      const dir = await cloneFixture('polygon-good');
      const source = await readFile(join(dir, 'solution.cpp'), 'utf8');
      await writeFile(join(dir, 'solution.cpp'), source.replace('a + b', 'a - b'));
      const report = await gate(dir);
      const model = check(report, 'model');
      expect(model.status).toBe('fail');
      expect(JSON.stringify(model.data)).toContain('WA');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'fails the model check when the model does not compile',
    async () => {
      const dir = await cloneFixture('polygon-good');
      await writeFile(join(dir, 'solution.cpp'), 'int main( {\n');
      const report = await gate(dir);
      expect(check(report, 'model').status).toBe('fail');
      expect(check(report, 'model').detail).toContain('does not compile');
    },
    SLOW,
  );
});

describe('the expected-verdict matrix', () => {
  it(
    'passes when every declared wrong solution gets the verdict it declared',
    async () => {
      const report = await gate(await cloneFixture('skills-zoo'));
      const matrix = check(report, 'matrix');
      expect(matrix.status).toBe('pass');
      expect(JSON.stringify(matrix.data)).toContain('sol-wrong.cpp');
      expect(report.ok).toBe(true);
    },
    SLOW,
  );

  it(
    'fails when a solution declared wrong survives the suite — a hole',
    async () => {
      const dir = await cloneFixture('skills-zoo');
      const source = await readFile(join(dir, 'solutions', 'sol-wrong.cpp'), 'utf8');
      // Still declared `@expect g1=WA`, but now it is correct: the suite says
      // nothing catches it, which is exactly what a hole is.
      await writeFile(join(dir, 'solutions', 'sol-wrong.cpp'), source.replace('a - b', 'a + b'));
      const report = await gate(dir);
      const matrix = check(report, 'matrix');
      expect(matrix.status).toBe('fail');
      expect(JSON.stringify(matrix.data)).toContain('"expected":"WA"');
      expect(JSON.stringify(matrix.data)).toContain('"actual":"OK"');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'fails when a declared verdict names a group this problem does not have',
    async () => {
      const dir = await cloneFixture('skills-zoo');
      const source = await readFile(join(dir, 'solutions', 'sol-wrong.cpp'), 'utf8');
      await writeFile(
        join(dir, 'solutions', 'sol-wrong.cpp'),
        source.replace('@expect     g1=WA', '@expect     g9=WA'),
      );
      const report = await gate(dir);
      expect(check(report, 'matrix').status).toBe('fail');
      expect(JSON.stringify(check(report, 'matrix').data)).toContain('no such group');
    },
    SLOW,
  );
});

/**
 * D94's samples. `polygon-good` deliberately declares none — every test in it
 * scores — so each case here turns its first test into a sample the way a
 * Polygon package actually does: zero points in a group worth zero.
 */
describe('the samples check', () => {
  async function withSample(description = ''): Promise<string> {
    const dir = await cloneFixture('polygon-good');
    const xmlPath = join(dir, 'problem.xml');
    const xml = await readFile(xmlPath, 'utf8');
    await write(
      xmlPath,
      xml
        .replace(
          '<test method="manual" sample="false" points="50" group="g1"/>\n        <test method="manual" sample="false" points="50" group="g1"/>',
          `<test method="manual" sample="true" points="0" group="samples"${description}/>\n        <test method="manual" sample="false" points="100" group="g1"/>`,
        )
        .replace(
          '<group name="g1" points="100"',
          '<group name="samples" points="0"/>\n        <group name="g1" points="100"',
        ),
    );
    return dir;
  }

  it(
    'passes and counts the samples, and the explanations among them',
    async () => {
      const report = await gate(await withSample(' description="Cộng hai số."'));
      const samples = check(report, 'samples');
      expect(samples.status).toBe('pass');
      expect(samples.detail).toContain('1 sample(s), 1 with an explanation');
      expect(report.ok).toBe(true);
    },
    SLOW,
  );

  it(
    'fails, naming the file, when a sample is missing one of its two files',
    async () => {
      const dir = await withSample();
      // The jury answer for the SAMPLE: the API drops a half-sample silently,
      // which is exactly what a gate is for.
      await rm(join(dir, 'tests', '01.a'));
      const report = await gate(dir);
      const samples = check(report, 'samples');
      expect(samples.status).toBe('fail');
      expect(JSON.stringify(samples.data)).toContain('01.a');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'skips — never quietly passes — a package that declares no samples at all',
    async () => {
      const report = await gate(await cloneFixture('polygon-good'));
      const samples = check(report, 'samples');
      expect(samples.status).toBe('skip');
      expect(samples.detail).toContain('no sample tests');
      expect(report.ok).toBe(true);
    },
    SLOW,
  );
});

describe('the structural checks', () => {
  it(
    'fails the statement check when there is no English section (D10)',
    async () => {
      const dir = await cloneFixture('polygon-good');
      const source = await readFile(join(dir, 'statement.md'), 'utf8');
      await writeFile(join(dir, 'statement.md'), source.split('---')[0] ?? '');
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      const report = await validateProblem(problem, { quick: true });
      expect(check(report, 'statement').status).toBe('fail');
      expect(check(report, 'statement').detail).toContain('English');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'fails the limits check on a time limit nothing could mean',
    async () => {
      const dir = await cloneFixture('polygon-good');
      const xml = await readFile(join(dir, 'problem.xml'), 'utf8');
      await writeFile(join(dir, 'problem.xml'), xml.replace('<time-limit>1000<', '<time-limit>5<'));
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      const report = await validateProblem(problem, { quick: true });
      expect(check(report, 'limits').status).toBe('fail');
      expect(check(report, 'limits').detail).toContain('5 ms');
    },
    SLOW,
  );

  it(
    'fails the flags check on an unresolved HIGH statement ambiguity',
    async () => {
      const dir = await cloneFixture('skills-zoo');
      await writeFile(
        join(dir, 'flags.json'),
        JSON.stringify({
          schema: 1,
          flags: [
            {
              id: 'amb-001',
              severity: 'high',
              kind: 'statement-ambiguity',
              what: '"xâu con" is readable as substring or subsequence',
              changes_if_wrong: 'the validator, the checker and every test',
            },
          ],
        }),
      );
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      const report = await validateProblem(problem, { quick: true });
      expect(check(report, 'flags').status).toBe('fail');
      expect(check(report, 'flags').detail).toContain('amb-001');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'passes the flags check once that ambiguity is marked resolved',
    async () => {
      const dir = await cloneFixture('skills-zoo');
      await writeFile(
        join(dir, 'flags.json'),
        JSON.stringify({
          schema: 1,
          flags: [
            {
              id: 'amb-001',
              severity: 'high',
              kind: 'statement-ambiguity',
              what: 'resolved by the t_A definition in the body',
              resolved: true,
            },
          ],
        }),
      );
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      const report = await validateProblem(problem, { quick: true });
      expect(check(report, 'flags').status).toBe('pass');
    },
    SLOW,
  );
});

describe('the validator', () => {
  it(
    'fails when the validator rejects a test the package ships',
    async () => {
      const dir = await cloneFixture('polygon-good');
      // testlib's own argv is irrelevant here: a validator reads the test on
      // stdin and its EXIT CODE is the verdict, which is all this gate uses.
      await writeFile(
        join(dir, 'validator.cpp'),
        '#include <iostream>\nint main(){long long a,b;if(!(std::cin>>a>>b))return 1;' +
          'if(a<0||b<0){std::cerr<<"negative\\n";return 1;}return 0;}\n',
      );
      const report = await gate(dir);
      const validator = check(report, 'validator');
      expect(validator.status).toBe('fail');
      // `tests/02` is `-4 9`, which this validator refuses.
      expect(JSON.stringify(validator.data)).toContain('02');
      expect(report.ok).toBe(false);
    },
    SLOW,
  );

  it(
    'passes when the validator accepts every test',
    async () => {
      const dir = await cloneFixture('polygon-good');
      await writeFile(
        join(dir, 'validator.cpp'),
        '#include <iostream>\nint main(){long long a,b;return (std::cin>>a>>b)?0:1;}\n',
      );
      const report = await gate(dir);
      expect(check(report, 'validator').status).toBe('pass');
      expect(report.ok).toBe(true);
    },
    SLOW,
  );
});
