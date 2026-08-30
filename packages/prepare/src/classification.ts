/**
 * Where a problem's topic slugs and 1-10 difficulty come from.
 *
 * `content/tags.json` is keyed by problem CODE and lives two directories above
 * the problem itself, because it is the record for a whole set
 * (`content/README.md`: "data, not a step that runs itself"). A problem
 * prepared outside that tree keeps its classification beside it instead. Both
 * are supported, nearest first, so publishing `content/problems/so-nguyen-to`
 * does not silently land untagged.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface Classification {
  tags: string[];
  difficulty: number | null;
  /** Which file this came from, for the report. `null` when nothing was found. */
  source: string | null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

function asDifficulty(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * `{tags, difficulty}`, either at the top level or under one of this problem's
 * keys.
 *
 * TWO keys, not one: the DuckOJ code and the directory's own name. They are
 * usually the same, and are not when a run publishes under a different code —
 * a throwaway `prep-<ts>` rehearsal, a problem re-coded for a contest — and a
 * classification file keyed by the directory must not stop describing the
 * problem the moment its code changes.
 */
function pick(doc: unknown, keys: string[]): { tags: string[]; difficulty: number | null } | null {
  if (typeof doc !== 'object' || doc === null) return null;
  const record = doc as Record<string, unknown>;
  const direct = asStringArray(record.tags);
  if (direct !== null) return { tags: direct, difficulty: asDifficulty(record.difficulty) };

  for (const key of keys) {
    const keyed = record[key];
    if (typeof keyed !== 'object' || keyed === null) continue;
    const entry = keyed as Record<string, unknown>;
    const tags = asStringArray(entry.tags);
    if (tags !== null) return { tags, difficulty: asDifficulty(entry.difficulty) };
  }
  return null;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    // Unreadable or unparseable is "not a classification here", not a
    // failure: the file is optional, and a stray `tags.json` belonging to
    // something else must not stop a problem from being published.
    return null;
  }
}

/**
 * Nearest wins: `meta.json` and `tags.json` in the problem directory, then a
 * `tags.json` in each ancestor up to `ancestors` levels (4 covers
 * `content/problems/<code>` → `content/tags.json` with room to spare).
 */
export async function findClassification(
  dir: string,
  code: string,
  fallbackTags: string[] = [],
  ancestors = 4,
): Promise<Classification> {
  const candidates = [join(dir, 'meta.json'), join(dir, 'tags.json')];
  let current = dir;
  for (let i = 0; i < ancestors; i++) {
    const parent = dirname(current);
    if (parent === current) break;
    candidates.push(join(parent, 'tags.json'));
    current = parent;
  }

  const keys = [...new Set([code, basename(dir)])];
  for (const path of candidates) {
    const found = pick(await readJson(path), keys);
    if (found !== null) return { ...found, source: path };
  }
  return { tags: fallbackTags, difficulty: null, source: null };
}
