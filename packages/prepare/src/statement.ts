/**
 * Finding the statement, and deciding whether it satisfies D10.
 *
 * D10: "statements are expected in Vietnamese **and** English", and
 * `problems.statement` is still a single Markdown column — so a DuckOJ
 * statement is one Markdown document carrying both. That is the whole reason
 * this module refuses a `.tex`-only directory: the vnolymp LaTeX the
 * `writing-statements` skill produces is a *typesetting* source, not
 * something `PATCH /problems/{code}` can store, and silently publishing a
 * problem with no statement is worse than saying which file to add.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PreparedStatement } from './model.js';

/**
 * A heading that opens the English half. Matched case-insensitively at the
 * start of a line so a mention of the word "English" inside a sentence does
 * not count as a section.
 */
const ENGLISH_HEADING = /^#{1,6}[ \t]*english\b/im;

export function hasEnglishSection(markdown: string): boolean {
  return ENGLISH_HEADING.test(markdown);
}

export interface StatementLookup {
  statement: PreparedStatement | null;
  detail: string;
}

/**
 * The statement, from whichever of the two supported shapes the directory has:
 *
 * - `statement.md` — one document, Vietnamese first, with an `## English`
 *   section (what `content/problems/*` already ships).
 * - `statement.vi.md` + `statement.en.md` — two documents, joined here into
 *   the single column the API stores, with the `## English` heading inserted.
 */
export async function findStatement(dir: string): Promise<StatementLookup> {
  const single = join(dir, 'statement.md');
  if (existsSync(single)) {
    const text = await readFile(single, 'utf8');
    return {
      statement: { path: single, text, hasEnglish: hasEnglishSection(text) },
      detail: 'statement.md',
    };
  }

  const vi = join(dir, 'statement.vi.md');
  const en = join(dir, 'statement.en.md');
  if (existsSync(vi)) {
    const viText = await readFile(vi, 'utf8');
    if (!existsSync(en)) {
      return {
        statement: { path: vi, text: viText, hasEnglish: false },
        detail: 'statement.vi.md with no statement.en.md beside it',
      };
    }
    const enText = await readFile(en, 'utf8');
    const text = `${viText.trimEnd()}\n\n---\n\n## English\n\n${enText.trimStart()}`;
    return {
      statement: { path: vi, text, hasEnglish: true },
      detail: 'statement.vi.md + statement.en.md, joined under an "## English" heading',
    };
  }

  const tex = ['statement.tex', 'problem.tex'].find((n) => existsSync(join(dir, n)));
  if (tex !== undefined) {
    return {
      statement: null,
      detail:
        `only ${tex} — a LaTeX source is not a statement DuckOJ can store. ` +
        'Add statement.md (Vietnamese, with an "## English" section) or ' +
        'statement.vi.md + statement.en.md beside it.',
    };
  }

  return {
    statement: null,
    detail: 'no statement.md, statement.vi.md or statement.en.md in this directory',
  };
}
