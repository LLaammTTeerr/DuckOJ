import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  detectLayout,
  distributePoints,
  hasEnglishSection,
  loadProblem,
  parseSolutionMeta,
  PrepareError,
} from '../src/index.js';
import { cleanupFixtures, cloneFixture, emptyDir } from './helpers.js';

afterAll(cleanupFixtures);

describe('detectLayout', () => {
  it('recognises a Polygon package by problem.xml', async () => {
    expect(detectLayout(await cloneFixture('polygon-good'))).toBe('polygon');
  });

  it('recognises the skills layout by problem.json', async () => {
    expect(detectLayout(await cloneFixture('skills-zoo'))).toBe('skills');
  });

  it('recognises neither in a directory with neither descriptor', async () => {
    expect(detectLayout(await emptyDir())).toBeNull();
  });

  it('prefers problem.xml when a directory carries both descriptors', async () => {
    const dir = await cloneFixture('polygon-good');
    await writeFile(join(dir, 'problem.json'), '{"schema":1}');
    expect(detectLayout(dir)).toBe('polygon');
  });
});

describe('loadProblem, Polygon layout', () => {
  it('reads the tests, the limits and the model solution', async () => {
    const problem = await loadProblem(await cloneFixture('polygon-good'));
    expect(problem.layout).toBe('polygon');
    expect(problem.tests).toHaveLength(2);
    expect(problem.tests[0]?.groupName).toBe('g1');
    expect(problem.tests[0]?.packageInput).toBe('tests/01.in');
    expect(problem.limits).toEqual({ timeMs: 1000, memoryKb: 262144 });
    expect(problem.manifest.checker.kind).toBe('standard');
    expect(problem.modelPath?.endsWith('solution.cpp')).toBe(true);
  });

  it("names the problem row from the statement's heading, not the English <name>", async () => {
    // `planImport` prefers `<name language="english">` because that name goes
    // into the hashed manifest. The row a Vietnamese-first site renders takes
    // the statement's own title instead — `content/README.md` step 3.
    const problem = await loadProblem(await cloneFixture('polygon-good'));
    expect(problem.name).toBe('Tổng hai số');
    expect(problem.manifest.name).toBe('A plus B');
  });

  it('finds a source checker declared in <assets>', async () => {
    const problem = await loadProblem(await cloneFixture('polygon-checker'));
    expect(problem.manifest.checker).toEqual({
      kind: 'source',
      path: 'checker/check.cpp',
      language: 'cpp17',
    });
    expect(problem.checkerSourcePath?.endsWith('check.cpp')).toBe(true);
  });
});

describe('loadProblem, skills layout', () => {
  it('turns subtasks into groups and splits their points across the tests', async () => {
    const problem = await loadProblem(await cloneFixture('skills-zoo'));
    expect(problem.layout).toBe('skills');
    expect(problem.tests.map((t) => t.group)).toEqual([1, 1]);
    expect(problem.tests.map((t) => t.points)).toEqual([50, 50]);
    expect(problem.tests[0]?.packageInput).toBe('tests/g1/01.in');
    expect(problem.tests[0]?.packageAnswer).toBe('tests/g1/01.ans');
    expect(problem.tags).toEqual(['mo-phong']);
  });

  it('reads the zoo, its tags and its expected verdicts', async () => {
    const problem = await loadProblem(await cloneFixture('skills-zoo'));
    expect(problem.solutions.map((s) => s.tag).sort()).toEqual(['main', 'wrong-answer']);
    expect(problem.solutions.find((s) => s.tag === 'wrong-answer')?.expect).toEqual({ g1: 'WA' });
    expect(problem.modelPath?.endsWith('sol-main.cpp')).toBe(true);
  });

  it('maps a stock token-comparison checker onto the standard checker', async () => {
    const problem = await loadProblem(await cloneFixture('skills-zoo'));
    expect(problem.manifest.checker).toEqual({ kind: 'standard' });
  });

  it('refuses subtask dependencies rather than importing a different problem', async () => {
    const dir = await cloneFixture('skills-zoo');
    const path = join(dir, 'problem.json');
    const doc = JSON.parse(await readFile(path, 'utf8')) as {
      subtasks: Array<Record<string, unknown>>;
    };
    doc.subtasks.push({ id: 'g2', points: 0, depends_on: ['g1'] });
    doc.subtasks[0] = { ...doc.subtasks[0], points: 100 };
    await writeFile(path, JSON.stringify(doc));
    await expect(loadProblem(dir)).rejects.toThrow(/depends_on/);
  });

  it('refuses file IO, which a DuckOJ package cannot express', async () => {
    const dir = await cloneFixture('skills-zoo');
    const path = join(dir, 'problem.json');
    const doc = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    doc.io = { input: 'prob.inp', output: 'prob.out' };
    await writeFile(path, JSON.stringify(doc));
    await expect(loadProblem(dir)).rejects.toThrow(/stdin\/stdout/);
  });
});

describe('loadProblem refusals', () => {
  it('refuses a directory that is neither layout', async () => {
    await expect(loadProblem(await emptyDir())).rejects.toBeInstanceOf(PrepareError);
  });

  it('defaults the problem code to the directory name', async () => {
    const problem = await loadProblem(await cloneFixture('polygon-good'));
    expect(problem.code).toBe('polygon-good');
  });

  it('refuses a code DuckOJ would not accept', async () => {
    const dir = await cloneFixture('polygon-good');
    await expect(loadProblem(dir, { code: 'Not A Code' })).rejects.toThrow(/not a usable problem code/);
  });

  it('refuses an unparseable flags.json instead of reading it as "no flags"', async () => {
    const dir = await cloneFixture('skills-zoo');
    await writeFile(join(dir, 'flags.json'), '{ not json');
    await expect(loadProblem(dir)).rejects.toThrow(/flags\.json is not valid JSON/);
  });

  it('reads a well-formed flags.json', async () => {
    const problem = await loadProblem(await cloneFixture('skills-zoo'));
    expect(problem.flags).toHaveLength(1);
    expect(problem.flags[0]?.id).toBe('tim-001');
  });
});

describe('classification', () => {
  it('takes tags and difficulty from a tags.json in an ancestor, keyed by code', async () => {
    const dir = await cloneFixture('polygon-good');
    await writeFile(
      join(dir, '..', 'tags.json'),
      JSON.stringify({ 'tong-hai-so': { tags: ['toan', 'mo-phong'], difficulty: 1 } }),
    );
    const problem = await loadProblem(dir, { code: 'tong-hai-so' });
    expect(problem.tags).toEqual(['toan', 'mo-phong']);
    expect(problem.difficulty).toBe(1);
  });

  it("keeps finding the classification when the run publishes under another code", async () => {
    // A `prep-<ts>` rehearsal of `content/problems/so-nguyen-to` must still
    // pick up `content/tags.json`, which is keyed by the DIRECTORY's name.
    const dir = await cloneFixture('polygon-good');
    await writeFile(join(dir, '..', 'tags.json'), JSON.stringify({ 'polygon-good': { tags: ['toan'] } }));
    const problem = await loadProblem(dir, { code: 'prep-1234' });
    expect(problem.tags).toEqual(['toan']);
  });

  it('prefers a meta.json beside the problem over an ancestor tags.json', async () => {
    const dir = await cloneFixture('polygon-good');
    await writeFile(join(dir, '..', 'tags.json'), JSON.stringify({ 'tong-hai-so': { tags: ['xa'] } }));
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ tags: ['gan'], difficulty: 4 }));
    const problem = await loadProblem(dir, { code: 'tong-hai-so' });
    expect(problem.tags).toEqual(['gan']);
    expect(problem.difficulty).toBe(4);
  });
});

describe('statement', () => {
  it('sees an English section under any heading level', () => {
    expect(hasEnglishSection('# T\n\n## English\n\ntext')).toBe(true);
    expect(hasEnglishSection('# T\n\nwritten in English, in Vietnamese')).toBe(false);
  });

  it('joins statement.vi.md and statement.en.md into one document', async () => {
    const dir = await cloneFixture('polygon-good');
    await rm(join(dir, 'statement.md'));
    await writeFile(join(dir, 'statement.vi.md'), '# Tổng hai số\n\nnội dung\n');
    await writeFile(join(dir, 'statement.en.md'), 'A plus B.\n');
    const problem = await loadProblem(dir, { code: 'tong-hai-so' });
    expect(problem.statement?.hasEnglish).toBe(true);
    expect(problem.statement?.text).toContain('## English');
    expect(problem.statement?.text).toContain('A plus B.');
  });

  it('reports a .tex-only directory as having no publishable statement', async () => {
    const dir = await cloneFixture('polygon-good');
    await rm(join(dir, 'statement.md'));
    await writeFile(join(dir, 'statement.tex'), '\\begin{problem}');
    const problem = await loadProblem(dir, { code: 'tong-hai-so' });
    expect(problem.statement).toBeNull();
    expect(problem.statementDetail).toContain('statement.tex');
  });
});

describe('parseSolutionMeta', () => {
  it('reads @tag and @expect out of the metadata block', () => {
    const meta = parseSolutionMeta('/**\n * @tag wrong-answer\n * @expect g1=WA g2=TL\n */\nint main(){}');
    expect(meta.tag).toBe('wrong-answer');
    expect(meta.expect).toEqual({ g1: 'WA', g2: 'TL' });
  });

  it('skips a licence block above the metadata block', () => {
    const meta = parseSolutionMeta('/* (c) somebody */\n/**\n * @tag main\n * @expect g1=OK\n */\n');
    expect(meta.tag).toBe('main');
  });

  it('reports a malformed @expect entry instead of dropping it', () => {
    const meta = parseSolutionMeta('/**\n * @tag main\n * @expect g1\n */\n');
    expect(meta.problems).toHaveLength(1);
  });

  it('returns nothing for a file with no metadata block at all', () => {
    expect(parseSolutionMeta('int main(){}')).toEqual({ tag: null, expect: {}, problems: [] });
  });
});

describe('distributePoints', () => {
  it("sums to exactly the subtask's points, remainder first", () => {
    expect(distributePoints(100, 3)).toEqual([34, 33, 33]);
    expect(distributePoints(100, 3).reduce((a, b) => a + b, 0)).toBe(100);
    expect(distributePoints(100, 2)).toEqual([50, 50]);
    expect(distributePoints(0, 2)).toEqual([0, 0]);
  });
});
