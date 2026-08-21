/**
 * The 23 goldens under `fixtures/contest-goldens/` are the specification and
 * the test suite for this package.
 *
 * Three properties this harness has to hold, because a harness that passes
 * against broken code is worse than none:
 *
 * 1. The fixture directory is **enumerated**, never listed. A hard-coded list
 *    silently stops covering a fixture someone adds later.
 * 2. Whole objects are compared. A format that gets `score` right and
 *    `format_data` wrong must fail, so `ranking`, `problems` and
 *    `label_by_problem` are deep-equalled in full rather than field-picked.
 * 3. Floats are normalised exactly the way the generator normalised the
 *    goldens — `round(value, 9)`, with `-0` folded to `0` — and never compared
 *    with `toBe`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeContestScoreboard } from '../src/index.js';
import { pyRound } from '../src/numeric.js';
import type { ContestInput, Scoreboard } from '../src/types.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/contest-goldens/', import.meta.url));

/** Directories under the fixture root that are not scenarios. */
const NOT_A_FORMAT = new Set(['_generator']);

interface Fixture {
  /** `<format>/<scenario>`, e.g. `ioi16/09-partial-subtasks-multiple-submissions`. */
  id: string;
  dir: string;
}

function discoverFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const format of readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!format.isDirectory() || NOT_A_FORMAT.has(format.name)) continue;
    const formatDir = join(FIXTURE_ROOT, format.name);
    for (const scenario of readdirSync(formatDir, { withFileTypes: true })) {
      if (!scenario.isDirectory()) continue;
      fixtures.push({
        id: `${format.name}/${scenario.name}`,
        dir: join(formatDir, scenario.name),
      });
    }
  }
  return fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * `_generator/generate.py:norm()` — round every float to nine places so a
 * regenerated golden is byte-identical, and fold `-0.0` to `0.0`. Applied to
 * the computed side only; the goldens were written through it already.
 */
function norm(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    const rounded = pyRound(value, 9);
    return rounded === 0 ? 0 : rounded;
  }
  if (typeof value === 'number') return value === 0 ? 0 : value;
  if (Array.isArray(value)) return value.map(norm);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, norm(item)]));
  }
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function compute(fixture: Fixture): unknown {
  const input = readJson(join(fixture.dir, 'contest.json')) as ContestInput;
  return norm(computeContestScoreboard(input));
}

function golden(fixture: Fixture): Scoreboard {
  return readJson(join(fixture.dir, 'scoreboard.json')) as Scoreboard;
}

const FIXTURES = discoverFixtures();

describe('contest-goldens', () => {
  it('discovers the fixture directory rather than a hard-coded list', () => {
    // Deliberately not an equality on 23: an exact count is the hard-coded
    // list in disguise, and would have to be edited when a fixture is added.
    expect(FIXTURES.length).toBeGreaterThan(0);
    expect(FIXTURES.map((fixture) => fixture.id)).toContain('default/01-nobody-solves');
  });

  it.each(FIXTURES)('$id', (fixture) => {
    const expected = golden(fixture);
    const actual = compute(fixture) as Scoreboard;

    // Whole objects, not selected fields.
    expect(actual.ranking).toEqual(expected.ranking);
    expect(actual.problems).toEqual(expected.problems);
    expect(actual.label_by_problem).toEqual(expected.label_by_problem);
  });
});

/**
 * Phase 4a's R7: `ioi16/09` and `legacy_ioi/09` hold **byte-identical
 * submissions** and are the difference between "best per batch" and "best
 * submission". Alice takes batch 1 from one submission and batch 2 from
 * another, scoring 100 under `ioi16` and 60 under `legacy_ioi`.
 *
 * The directory sweep above already covers both, but this is the one case worth
 * failing loudly and by name: an implementation reading "best score per
 * problem" passes the other 22 goldens and is wrong by 40 points here. The
 * expectations are written in as literals rather than read from the goldens, so
 * the assertion survives even a corrupted fixture.
 */
describe('R7: best batch is not best submission', () => {
  const IOI16 = 'ioi16/09-partial-subtasks-multiple-submissions';
  const LEGACY = 'legacy_ioi/09-best-submission-not-best-batch';

  function inputFor(id: string): ContestInput {
    return readJson(join(FIXTURE_ROOT, id, 'contest.json')) as ContestInput;
  }

  function scoreOf(id: string, participant: string): number {
    const board = computeContestScoreboard(inputFor(id));
    const row = board.ranking.find((entry) => entry.participant === participant);
    if (row === undefined) throw new Error(`${participant} is not in the ${id} ranking`);
    return row.score;
  }

  it('the two fixtures really do hold identical submissions', () => {
    expect(inputFor(IOI16).submissions).toEqual(inputFor(LEGACY).submissions);
  });

  it('scores alice 100 under ioi16 — batch 1 from one submission, batch 2 from another', () => {
    expect(scoreOf(IOI16, 'alice')).toBe(100);
  });

  it('scores alice 60 under legacy_ioi — her single best submission, and no more', () => {
    expect(scoreOf(LEGACY, 'alice')).toBe(60);
  });
});
