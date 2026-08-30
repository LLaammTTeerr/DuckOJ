/**
 * Layout detection and the one entry point that turns a directory on disk
 * into a `PreparedProblem`.
 */
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { findClassification } from './classification.js';
import { PrepareError } from './errors.js';
import { readFlags } from './flags.js';
import { loadPolygon } from './load-polygon.js';
import { loadSkills } from './load-skills.js';
import type { Layout, PreparedProblem } from './model.js';
import { findStatement } from './statement.js';

/** The code a problem may carry on DuckOJ (`packages/contracts`'s `PROBLEM_CODE`). */
const PROBLEM_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Which layout a directory is in.
 *
 * `problem.xml` wins when both descriptors are present: it is the file
 * `@duckoj/polygon-import` reads, and a directory carrying one has already
 * decided what its package contains down to the path patterns. Returning
 * `null` rather than throwing keeps the caller free to say what it wants
 * about a directory that is neither.
 */
export function detectLayout(dir: string): Layout | null {
  if (existsSync(join(dir, 'problem.xml'))) return 'polygon';
  if (existsSync(join(dir, 'problem.json'))) return 'skills';
  return null;
}

/** The statement's `# Title` line, if it opens with one. */
function firstHeading(markdown: string | undefined): string | null {
  if (markdown === undefined) return null;
  const match = /^#[ \t]+(.+?)[ \t]*$/m.exec(markdown);
  const title = match?.[1];
  return title === undefined || title === '' ? null : title;
}

export interface LoadOptions {
  /** Override the DuckOJ problem code; defaults to the directory's name. */
  code?: string;
}

export async function loadProblem(dirInput: string, options: LoadOptions = {}): Promise<PreparedProblem> {
  const dir = resolve(dirInput);
  if (!existsSync(dir)) throw new PrepareError(`no such directory: ${dir}`);

  const layout = detectLayout(dir);
  if (layout === null) {
    throw new PrepareError(
      `${dir} is neither layout: a Polygon package needs problem.xml, the ` +
        'competitive-programming skills\' layout needs problem.json',
    );
  }

  const code = options.code ?? basename(dir);
  if (!PROBLEM_CODE.test(code)) {
    throw new PrepareError(
      `"${code}" is not a usable problem code (${String(PROBLEM_CODE)}) — pass --code to choose one`,
    );
  }

  const core = layout === 'polygon' ? await loadPolygon(dir, code) : await loadSkills(dir, code);
  const { statement, detail } = await findStatement(dir);
  const classification = await findClassification(dir, code, core.tags);
  const editorial = join(dir, 'editorial.md');

  return {
    layout,
    dir,
    ...core,
    // The name on the PROBLEM ROW, which is not the name in the manifest.
    // `content/README.md` step 3 takes it from the statement's first heading,
    // and that is the Vietnamese title a Vietnamese-first site should show —
    // `planImport` prefers `<name language="english">`, which would put
    // "Counting primes" on a page whose every other word is Vietnamese. The
    // manifest keeps whatever the importer put there: it is hashed.
    name: firstHeading(statement?.text) ?? core.name,
    statement,
    statementDetail: detail,
    editorialPath: existsSync(editorial) ? editorial : null,
    tags: classification.tags,
    difficulty: classification.difficulty,
    flags: await readFlags(dir),
  };
}
