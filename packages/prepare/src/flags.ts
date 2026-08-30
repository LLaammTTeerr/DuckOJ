/**
 * `flags.json` — the `reviewing-problems` register of every autonomous
 * judgement call the setting pipeline made.
 *
 * Most flags are informational by construction: the skill's whole flag-and-
 * continue model rests on `changes_if_wrong` pricing the interruption rather
 * than on anyone being stopped. **One** finding is a hard stop in that skill's
 * own words — "an unresolvable HIGH statement ambiguity" — and that is
 * therefore the only thing this gate treats as a blocker.
 *
 * `flags.py` writes no `resolved` field, so a resolved ambiguity is recorded
 * by adding `"resolved": true` to the record by hand (D90). Anything else in
 * the register is surfaced in the report and does not fail the gate.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PrepareError } from './errors.js';
import type { FlagRecord } from './model.js';

export async function readFlags(dir: string): Promise<FlagRecord[]> {
  let text: string;
  try {
    text = await readFile(join(dir, 'flags.json'), 'utf8');
  } catch {
    // No register at all is the ordinary case for a Polygon directory.
    return [];
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch (error) {
    // A register that exists but cannot be read is NOT "no flags": treating
    // an unparseable file as empty would let a corrupt register hide the one
    // finding that is supposed to stop the pipeline.
    throw new PrepareError(
      `flags.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new PrepareError('flags.json top level must be an object');
  }
  const flags = (doc as { flags?: unknown }).flags;
  if (flags === undefined) return [];
  if (!Array.isArray(flags)) throw new PrepareError("flags.json 'flags' must be an array");

  return flags.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new PrepareError(`flags.json flag ${String(index)} is not an object`);
    }
    return raw as FlagRecord;
  });
}

/** The flags that stop this gate: unresolved, HIGH, `statement-ambiguity`. */
export function blockingFlags(flags: FlagRecord[]): FlagRecord[] {
  return flags.filter(
    (f) => f.severity === 'high' && f.kind === 'statement-ambiguity' && f.resolved !== true,
  );
}
