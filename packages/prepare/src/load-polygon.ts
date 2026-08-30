/**
 * The Polygon "full" layout — `problem.xml` plus whatever paths it names.
 *
 * The manifest and the copy plan come from `@duckoj/polygon-import`'s
 * `planImport`, never from a second reading of the XML: that function IS the
 * definition of what a Polygon directory means to DuckOJ, and two
 * implementations of it is how the CLI and the seed path end up registering
 * different hashes for one directory (D87). What this module reads out of the
 * XML on its own is strictly the metadata `planImport` does not return and the
 * package does not contain — group NAMES (so an `@expect g1=WA` header can be
 * matched to a group) and the `<solutions>` list.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { XMLParser } from 'fast-xml-parser';
import { planImport, PolygonImportError } from '@duckoj/polygon-import';

import { PrepareError } from './errors.js';
import type { PreparedProblem, PreparedSolution, PreparedTest } from './model.js';
import { parseSolutionMeta } from './solution-meta.js';

interface XmlTest {
  group?: string;
}
interface XmlSolution {
  tag?: string;
  source?: { path?: string };
}
interface XmlDoc {
  problem?: {
    judging?: { testset?: XmlTestset | XmlTestset[] };
    assets?: { solutions?: { solution?: XmlSolution | XmlSolution[] } };
  };
}
interface XmlTestset {
  name?: string;
  tests?: { test?: XmlTest | XmlTest[] };
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The group name of each 1-indexed test, in the same order `planImport`
 * assigns its numeric group indices — first appearance wins, ungrouped is 0 —
 * so `groupNames[i]` and `manifest.tests[i].group` describe one group.
 */
function groupNames(xml: string): string[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: true,
  });
  const doc = parser.parse(xml) as XmlDoc;
  const testset = asArray(doc.problem?.judging?.testset).find((t) => t.name === 'tests');
  return asArray(testset?.tests?.test).map((t) => (t.group === undefined ? '' : String(t.group)));
}

function declaredSolutions(xml: string): XmlSolution[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const doc = parser.parse(xml) as XmlDoc;
  return asArray(doc.problem?.assets?.solutions?.solution);
}

/** Polygon's solution tags, in the vocabulary the skills' zoo also speaks. */
function normaliseTag(tag: string | undefined): string {
  if (tag === undefined) return 'accepted';
  return tag === 'main' ? 'main' : tag;
}

export async function loadPolygon(dir: string, code: string): Promise<
  Pick<
    PreparedProblem,
    | 'code'
    | 'name'
    | 'limits'
    | 'checkerSourcePath'
    | 'validatorPath'
    | 'modelPath'
    | 'solutions'
    | 'tests'
    | 'manifest'
    | 'copies'
    | 'tags'
  >
> {
  const xmlPath = join(dir, 'problem.xml');
  const xml = await readFile(xmlPath, 'utf8');

  let plan;
  try {
    plan = planImport(xml);
  } catch (error) {
    if (error instanceof PolygonImportError) throw new PrepareError(error.message);
    throw error;
  }

  const names = groupNames(xml);
  const tests: PreparedTest[] = plan.manifest.tests.map((test, index) => ({
    id: String(index + 1).padStart(2, '0'),
    inputPath: join(dir, plan.copies[index * 2]?.from ?? test.input),
    answerPath: join(dir, plan.copies[index * 2 + 1]?.from ?? test.answer),
    points: test.points,
    group: test.group,
    groupName: names[index] ?? '',
    packageInput: test.input,
    packageAnswer: test.answer,
  }));

  const solutions: PreparedSolution[] = [];
  for (const declared of declaredSolutions(xml)) {
    const path = declared.source?.path;
    if (path === undefined) continue;
    const abs = join(dir, String(path));
    if (!existsSync(abs)) {
      throw new PrepareError(`problem.xml declares solution "${String(path)}", which is not on disk`);
    }
    const meta = parseSolutionMeta(await readFile(abs, 'utf8'));
    solutions.push({
      file: basename(abs),
      path: abs,
      tag: normaliseTag(meta.tag ?? String(declared.tag ?? '')) || 'accepted',
      expect: meta.expect,
    });
  }
  // A hand-written Polygon directory (`content/problems/*`) may name no
  // solutions at all and simply keep `solution.cpp` at its root.
  if (solutions.length === 0 && existsSync(join(dir, 'solution.cpp'))) {
    const abs = join(dir, 'solution.cpp');
    solutions.push({
      file: 'solution.cpp',
      path: abs,
      tag: 'main',
      expect: parseSolutionMeta(await readFile(abs, 'utf8')).expect,
    });
  }

  const checkerCopy = plan.copies.find((c) => c.to === 'checker/check.cpp');
  const validator = ['validator.cpp', join('files', 'validator.cpp')]
    .map((p) => join(dir, p))
    .find((p) => existsSync(p));

  return {
    code,
    name: plan.manifest.name,
    limits: plan.manifest.limits,
    checkerSourcePath: checkerCopy === undefined ? null : join(dir, checkerCopy.from),
    validatorPath: validator ?? null,
    modelPath: solutions.find((s) => s.tag === 'main')?.path ?? null,
    solutions,
    tests,
    manifest: plan.manifest,
    copies: plan.copies.map((c) => ({ from: join(dir, c.from), to: c.to })),
    // A Polygon descriptor has no topic vocabulary of its own; the
    // classification comes from `tags.json`/`meta.json` (see `load.ts`).
    tags: [],
  };
}
