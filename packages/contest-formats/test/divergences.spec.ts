/**
 * The two places DuckOJ deliberately departs from DMOJ.
 *
 * Spec: `docs/superpowers/specs/2026-08-21-contest-divergences-design.md`.
 *
 * - **DIV-1** — a submission outside its participation's window does not count.
 * - **DIV-2** — `default` times a problem by its *best* submission, earliest
 *   among ties, not by its last.
 *
 * The whole point of this file is that the divergence is **measured**, not
 * asserted. `goldens.spec.ts` pins `dmojCompat` against the 23 frozen
 * scoreboards; this one pins the delta between that baseline and production.
 * An unexplained difference is a bug, and a divergence that changes no golden
 * is a fix nobody can observe.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeContestScoreboard } from '../src/index.js';
import type { ContestInput, RankingRow, Scoreboard } from '../src/types.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/contest-goldens/', import.meta.url));
const NOT_A_FORMAT = new Set(['_generator']);

/**
 * The goldens whose output changes, and the divergence responsible for each.
 * Written down so the measurement below can check **both** directions: no
 * unexplained difference, and no divergence that changes nothing.
 */
const DIVERGENT: Record<string, 'DIV-1' | 'DIV-2'> = {
  // Nobody scores, so every submission ties at zero points and DIV-2 takes the
  // earliest. Cumtime is unaffected (an unscored problem adds none); the
  // `format_data.time` a scoreboard displays is what moves.
  'default/01-nobody-solves': 'DIV-2',
  'default/03-deadline-boundary': 'DIV-1',
  'default/06-zero-after-accept': 'DIV-2',
  'icpc/03-deadline-boundary': 'DIV-1',
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function inputFor(id: string): ContestInput {
  return readJson(join(FIXTURE_ROOT, id, 'contest.json')) as ContestInput;
}

function discoverFixtures(): string[] {
  const ids: string[] = [];
  for (const format of readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!format.isDirectory() || NOT_A_FORMAT.has(format.name)) continue;
    for (const scenario of readdirSync(join(FIXTURE_ROOT, format.name), { withFileTypes: true })) {
      if (scenario.isDirectory()) ids.push(`${format.name}/${scenario.name}`);
    }
  }
  return ids.sort();
}

const FIXTURES = discoverFixtures();

function duckoj(id: string): Scoreboard {
  return computeContestScoreboard(inputFor(id), 'duckoj');
}
function compat(id: string): Scoreboard {
  return computeContestScoreboard(inputFor(id), 'dmojCompat');
}
function rowFor(board: Scoreboard, participant: string): RankingRow {
  const row = board.ranking.find((entry) => entry.participant === participant);
  if (row === undefined) throw new Error(`${participant} is not in the ranking`);
  return row;
}

/**
 * DIV-1's window rule, written here **from the spec's table** rather than
 * imported from `window.ts`.
 *
 * That is deliberate: the test below asserts that production output equals the
 * compatibility path fed pre-stripped input, so two independent derivations of
 * the same rule have to agree. Importing the implementation would make the
 * assertion a tautology, and transcribing an expected scoreboard by hand would
 * be a typo waiting to pass.
 */
function stripOutOfWindow(input: ContestInput): ContestInput {
  const contestStart = Date.parse(input.contest.start_time);
  const contestEnd = Date.parse(input.contest.end_time);
  const limit = input.contest.time_limit_seconds;

  const windows = new Map<string, { start: number; end: number }>();
  for (const participant of input.participants) {
    const realStart = Date.parse(participant.real_start);
    const spectator = participant.virtual === -1;
    const live = participant.virtual === 0;

    const start = limit === null && (live || spectator) ? contestStart : realStart;
    let end: number;
    if (spectator) {
      end = contestEnd;
    } else if (!live) {
      end = realStart + (limit === null ? contestEnd - contestStart : limit * 1000);
    } else {
      end = limit === null ? contestEnd : Math.min(realStart + limit * 1000, contestEnd);
    }
    windows.set(participant.name, { start, end });
  }

  return {
    ...input,
    submissions: input.submissions.filter((submission) => {
      const window = windows.get(submission.participant);
      if (window === undefined) return true;
      const at = Date.parse(submission.date);
      return at >= window.start && at <= window.end;
    }),
  };
}

describe('the divergence is measured, not assumed', () => {
  it.each(FIXTURES)('%s differs from dmojCompat only if a divergence explains it', (id) => {
    const differs = JSON.stringify(duckoj(id)) !== JSON.stringify(compat(id));
    expect(differs, differs ? `${id} differs but no divergence claims it` : undefined).toBe(
      Object.prototype.hasOwnProperty.call(DIVERGENT, id),
    );
  });

  it('every claimed divergence actually changes a golden', () => {
    // The other direction. A divergence that changes nothing observable is a
    // fix nobody can see, and this project has shipped an "impossible trap"
    // before by reasoning about behaviour instead of measuring it.
    for (const id of Object.keys(DIVERGENT)) {
      expect(FIXTURES, `${id} is not a fixture`).toContain(id);
      expect(JSON.stringify(duckoj(id)), `${id} claims to diverge but does not`).not.toEqual(
        JSON.stringify(compat(id)),
      );
    }
  });

  it('both divergences are represented, so neither is dead code', () => {
    const claimed = new Set(Object.values(DIVERGENT));
    expect(claimed).toEqual(new Set(['DIV-1', 'DIV-2']));
  });
});

describe('DIV-1: a submission outside the participation window does not count', () => {
  // `default` is excluded because DIV-2 also applies to it, which would confound
  // the identity. Every other format isolates DIV-1 exactly.
  const ISOLATING = FIXTURES.filter((id) => !id.startsWith('default/'));

  it.each(FIXTURES)('%s counts exactly the submissions inside each window', (id) => {
    // Two-directional and valid for *every* fixture, `default` included, where
    // the scoreboard identity below is confounded by DIV-2.
    //
    // Comparing `duckoj(x)` against `duckoj(strip(x))` would NOT do: the
    // implementation's own filter runs on both sides, so an over-aggressive
    // window agrees with itself and the assertion passes. Counting the
    // surviving rows against an independently stripped input catches the
    // window being too narrow *and* too wide.
    const stripped = stripOutOfWindow(inputFor(id));
    const expected = new Map<string, number>();
    for (const submission of stripped.submissions) {
      expected.set(submission.participant, (expected.get(submission.participant) ?? 0) + 1);
    }
    for (const row of duckoj(id).ranking) {
      expect([row.participant, row.submission_count]).toEqual([
        row.participant,
        expected.get(row.participant) ?? 0,
      ]);
    }
  });

  it.each(ISOLATING)('%s equals the compatibility path fed pre-stripped input', (id) => {
    const input = inputFor(id);
    expect(duckoj(id)).toEqual(
      computeContestScoreboard(stripOutOfWindow(input), 'dmojCompat'),
    );
  });

  it('icpc/03: the entrant a full minute late loses the solve', () => {
    const id = 'icpc/03-deadline-boundary';
    // dave submits at 14:01:00Z against a 14:00:00Z deadline. Upstream scores
    // it — nothing filters by contest end — so this is the sharpest case in the
    // corpus and is asserted by name rather than left to the sweep above.
    expect(rowFor(compat(id), 'dave').score).toBe(100);
    expect(rowFor(duckoj(id), 'dave').score).toBe(0);
    expect(rowFor(duckoj(id), 'dave').format_data).toEqual({});
  });

  it('default/03: the accept 90 minutes past the deadline stops scoring', () => {
    const id = 'default/03-deadline-boundary';
    expect(rowFor(compat(id), 'carol').score).toBe(100);
    expect(rowFor(duckoj(id), 'carol').score).toBe(0);
  });

  it('a submission exactly at the deadline still counts', () => {
    // `Contest.ended` is `end_time < now` — strictly after — so the window is
    // inclusive. alice submits at exactly 14:00:00Z. Getting this edge wrong
    // voids a legitimate solve, which is worse than the bug being fixed.
    const id = 'icpc/03-deadline-boundary';
    expect(rowFor(duckoj(id), 'alice').score).toBe(100);
    expect(rowFor(duckoj(id), 'bob').score).toBe(0); // 14:00:01Z, one second past
  });

  it('a virtual participation outliving the contest is untouched', () => {
    // DIV-1's own trap. A virtual entrant starting at 20:00 on a 09:00-14:00
    // contest submits at 20:10 — six hours after `contest.end_time` and well
    // inside her own five-hour window. A filter written against the contest
    // end would void her, trading an old bug for a new one.
    for (const id of FIXTURES.filter((entry) => entry.endsWith('/05-virtual-participation'))) {
      expect(duckoj(id), id).toEqual(compat(id));
      expect(rowFor(duckoj(id), 'mallory').score, id).toBeGreaterThan(0);
    }
  });

  it('a spectator takes the contest window and does not throw', () => {
    // No golden carries `virtual = -1`, so the case is constructed. A spectator
    // is excluded from the ranking, which is exactly why an unhandled window
    // for one would go unnoticed until it threw in production.
    const input = inputFor('icpc/03-deadline-boundary');
    const withSpectator: ContestInput = {
      ...input,
      participants: [
        ...input.participants,
        { name: 'watcher', real_start: input.contest.start_time, virtual: -1 },
      ],
      submissions: [
        ...input.submissions,
        {
          participant: 'watcher',
          problem: input.problems[0]!.code,
          date: input.contest.end_time,
          result: 'AC',
          status: 'D',
          cases: [{ batch: null, case: 1, points: 1, total: 1, status: 'AC' }],
        },
      ],
    };
    const board = computeContestScoreboard(withSpectator, 'duckoj');
    expect(board.ranking.map((row) => row.participant)).not.toContain('watcher');
  });
});

describe('DIV-2: default times the best submission, not the last', () => {
  const id = 'default/06-zero-after-accept';

  it('the junk submission after an accept no longer costs the contest', () => {
    // alice accepts at 09:10 then submits a WA at 10:40. Upstream records the
    // WA's time as her penalty (6000s), handing bob the win with 5400s.
    expect(rowFor(compat(id), 'alice').cumtime).toBe(6000);
    expect(rowFor(duckoj(id), 'alice').cumtime).toBe(600);

    expect(rowFor(compat(id), 'bob').rank).toBe(1);
    expect(rowFor(duckoj(id), 'alice').rank).toBe(1);
  });

  it('score and submission_count are untouched', () => {
    // DIV-2 is arithmetic, not a filter: the junk submission was still
    // submitted and still counts as one. If `submission_count` moves here, it
    // has been implemented by dropping rows, which is the wrong fix.
    for (const participant of ['alice', 'bob']) {
      expect(rowFor(duckoj(id), participant).score).toBe(
        rowFor(compat(id), participant).score,
      );
      expect(rowFor(duckoj(id), participant).submission_count).toBe(
        rowFor(compat(id), participant).submission_count,
      );
    }
  });

  it('first_solve follows the corrected times', () => {
    expect(compat(id).problems[0]!.first_solve).toBe('bob');
    expect(duckoj(id).problems[0]!.first_solve).toBe('alice');
  });
});
