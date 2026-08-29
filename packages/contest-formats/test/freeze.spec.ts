/**
 * The scoreboard freeze window (D22).
 *
 * `frozen_last_minutes = F > 0` means: while `now` is inside a
 * participation's own `[end − F·60s, end)`, that row is computed from the
 * submissions dated **strictly before** the freeze instant, and the ones
 * inside the window are reported as a per-cell `pending` count instead.
 *
 * Every assertion here injects `now` rather than reading the wall clock —
 * the reason the whole feature was deferred out of phase 4a. A test that
 * called `Date.now()` would pass today and fail in an hour.
 */
import { describe, expect, it } from 'vitest';

import { computeContestScoreboard } from '../src/index.js';
import { lower } from '../src/lower.js';
import type { ContestInput, RankingRow, TestCaseSpec } from '../src/types.js';

const START = '2026-03-01T09:00:00Z';
const END = '2026-03-01T14:00:00Z';
/** `END − 60 min`. Every "inside the window" instant below is after this. */
const FREEZE_AT = '2026-03-01T13:00:00.000Z';

function solved(): TestCaseSpec[] {
  return [{ batch: null, case: 1, points: 10, total: 10, status: 'AC' }];
}

function failed(): TestCaseSpec[] {
  return [{ batch: null, case: 1, points: 0, total: 10, status: 'WA' }];
}

/**
 * Alice runs live (09:00–14:00, freezing at 13:00); Bob runs the first
 * virtual attempt from 12:00, so his own window is 12:00–17:00 and his own
 * freeze instant is 16:00 — three hours after the contest's.
 */
function contest(format: string): ContestInput {
  return {
    format,
    format_config: null,
    contest: {
      key: 'freeze',
      start_time: START,
      end_time: END,
      time_limit_seconds: null,
      points_precision: 3,
      frozen_last_minutes: 60,
    },
    problems: [
      { code: 'P1', points: 100, partial: false, problem_partial: false },
      { code: 'P2', points: 100, partial: false, problem_partial: false },
      { code: 'P3', points: 100, partial: false, problem_partial: false },
    ],
    participants: [
      { name: 'alice', real_start: START, virtual: 0 },
      { name: 'bob', real_start: '2026-03-01T12:00:00Z', virtual: 1 },
    ],
    submissions: [
      // Before the freeze: counted by everyone, always.
      { participant: 'alice', problem: 'P1', date: '2026-03-01T10:00:00Z', result: 'AC', status: 'D', cases: solved() },
      // Inside the freeze window, on a problem she already has a cell for.
      { participant: 'alice', problem: 'P2', date: '2026-03-01T13:30:00Z', result: 'AC', status: 'D', cases: solved() },
      { participant: 'alice', problem: 'P2', date: '2026-03-01T12:00:00Z', result: 'WA', status: 'D', cases: failed() },
      // Inside the freeze window, and her ONLY submission to P3: there is no
      // `format_data` cell to hang a pending count on.
      { participant: 'alice', problem: 'P3', date: '2026-03-01T13:45:00Z', result: 'AC', status: 'D', cases: solved() },
      // Bob's own window freezes at 16:00, so this one is live at 13:30.
      { participant: 'bob', problem: 'P1', date: '2026-03-01T12:30:00Z', result: 'AC', status: 'D', cases: solved() },
      { participant: 'bob', problem: 'P2', date: '2026-03-01T16:30:00Z', result: 'AC', status: 'D', cases: solved() },
      // Past alice's own end: void under `duckoj`, and never pending.
      { participant: 'alice', problem: 'P1', date: '2026-03-01T14:30:00Z', result: 'AC', status: 'D', cases: solved() },
    ],
  };
}

function rowFor(ranking: RankingRow[], participant: string): RankingRow {
  const row = ranking.find((entry) => entry.participant === participant);
  if (row === undefined) throw new Error(`${participant} is not ranked`);
  return row;
}

describe('lower() with a freeze window', () => {
  it('no longer throws on a non-zero frozen_last_minutes', () => {
    expect(() => lower(contest('default'))).not.toThrow();
  });

  it('leaves the board live when no clock is supplied', () => {
    const lowered = lower(contest('default'));
    expect(lowered.isFrozen).toBe(false);
    expect(rowFor(computeContestScoreboard(contest('default')).ranking, 'alice').score).toBe(300);
  });
});

describe('before the window', () => {
  it('hides nothing and reports frozen: false', () => {
    const board = computeContestScoreboard(contest('default'), 'duckoj', '2026-03-01T12:00:00Z');
    expect(board.frozen).toBe(false);
    expect(board.frozenAt).toBe(FREEZE_AT);
    expect(rowFor(board.ranking, 'alice').score).toBe(300);
    expect(rowFor(board.ranking, 'alice').pending).toBeUndefined();
  });
});

describe('inside the window', () => {
  const NOW = '2026-03-01T13:30:00Z';

  it('scores only the submissions dated before the freeze instant', () => {
    const board = computeContestScoreboard(contest('default'), 'duckoj', NOW);
    expect(board.frozen).toBe(true);
    expect(board.frozenAt).toBe(FREEZE_AT);
    // P1 only: the 13:30 P2 accept and the 13:45 P3 accept are both hidden,
    // and the 12:00 WA on P2 still counts (and still scores nothing).
    expect(rowFor(board.ranking, 'alice').score).toBe(100);
  });

  it('counts the hidden attempts per problem, including a problem with no visible cell', () => {
    const board = computeContestScoreboard(contest('default'), 'duckoj', NOW);
    const alice = rowFor(board.ranking, 'alice');
    expect(alice.pending).toEqual({ P2: 1, P3: 1 });
    // P3 has no visible submission at all, so `format_data` cannot carry the
    // count — this is why `pending` sits on the row.
    expect(alice.format_data['P3']).toBeUndefined();
  });

  it('calls a submission outside the participation window void, never pending', () => {
    // Under `dmojCompat` the window filter is off, so the 14:30 submission
    // survives to reach the freeze test — and must still not be counted as an
    // attempt that will appear when the board thaws.
    const board = computeContestScoreboard(contest('default'), 'dmojCompat', NOW);
    expect(rowFor(board.ranking, 'alice').pending).toEqual({ P2: 1, P3: 1 });
  });

  it('leaves a virtual participation alone until its own window freezes', () => {
    const board = computeContestScoreboard(contest('default'), 'duckoj', NOW);
    const bob = rowFor(board.ranking, 'bob');
    // Both his submissions score. Nothing here filters by "in the future" —
    // `now` selects the freeze window and nothing else, and a real database
    // at 13:30 holds no 16:30 row to filter.
    expect(bob.score).toBe(200);
    expect(bob.pending).toEqual({});
  });

  it('freezes a virtual participation relative to its own end', () => {
    // 16:30 is past the contest end and past alice's window, but inside
    // bob's own freeze window (16:00–17:00).
    const board = computeContestScoreboard(contest('default'), 'duckoj', '2026-03-01T16:30:00Z');
    expect(board.frozen).toBe(true);
    const bob = rowFor(board.ranking, 'bob');
    expect(bob.score).toBe(100);
    expect(bob.pending).toEqual({ P2: 1 });
    // Alice's window closed at 14:00, so she is revealed in the same response.
    expect(rowFor(board.ranking, 'alice').score).toBe(300);
    expect(rowFor(board.ranking, 'alice').pending).toEqual({});
  });
});

describe('after the end', () => {
  it('reveals everything again', () => {
    // Past alice's end and past bob's freeze instant is not enough — bob's
    // window runs to 17:00, so this is 17:30.
    const board = computeContestScoreboard(contest('default'), 'duckoj', '2026-03-01T17:30:00Z');
    expect(board.frozen).toBe(false);
    expect(rowFor(board.ranking, 'alice').score).toBe(300);
    expect(rowFor(board.ranking, 'alice').pending).toBeUndefined();
    expect(rowFor(board.ranking, 'bob').score).toBe(200);
  });
});

describe('the privileged view', () => {
  it('omitting `now` shows the live board at an instant that would otherwise freeze it', () => {
    const board = computeContestScoreboard(contest('default'), 'duckoj', undefined);
    expect(board.frozen).toBe(false);
    expect(rowFor(board.ranking, 'alice').score).toBe(300);
  });
});

describe('icpc under a freeze', () => {
  const NOW = '2026-03-01T13:30:00Z';

  it('marks a cell with hidden attempts as frozen without degrading its mirror fields', () => {
    const board = computeContestScoreboard(contest('icpc'), 'duckoj', NOW);
    const alice = rowFor(board.ranking, 'alice');
    const p1 = alice.format_data['P1'];
    const p2 = alice.format_data['P2'];
    // P1 has nothing hidden.
    expect(p1).toMatchObject({ points: 100, is_frozen: false, tries: 1, frozen_points: 100 });
    // P2 shows the pre-freeze WA and is flagged: something is hidden here.
    expect(p2).toMatchObject({ points: 0, is_frozen: true, tries: 1 });
    expect(alice.pending).toEqual({ P2: 1, P3: 1 });
  });

  it('mirrors the frozen_* fields onto the board it actually serves', () => {
    const board = computeContestScoreboard(contest('icpc'), 'duckoj', NOW);
    const alice = rowFor(board.ranking, 'alice');
    // D22: the filtering IS the freeze, so the legacy per-row frozen_* fields
    // mirror the served board rather than freezing an already-frozen board.
    expect(alice.frozen_score).toBe(alice.score);
    expect(alice.frozen_cumtime).toBe(alice.cumtime);
    expect(alice.frozen_tiebreaker).toBe(alice.tiebreaker);
  });

  it('is byte-for-byte the live board when the window has passed', () => {
    const frozen = computeContestScoreboard(contest('icpc'), 'duckoj', '2026-03-01T17:30:00Z');
    const live = computeContestScoreboard(contest('icpc'), 'duckoj');
    expect(frozen.ranking).toEqual(live.ranking);
  });
});

describe('a contest with no freeze window', () => {
  it('reports frozen: false and a null frozenAt whatever the clock says', () => {
    const input = contest('default');
    input.contest.frozen_last_minutes = 0;
    const board = computeContestScoreboard(input, 'duckoj', '2026-03-01T13:30:00Z');
    expect(board.frozen).toBe(false);
    expect(board.frozenAt).toBeNull();
    expect(rowFor(board.ranking, 'alice').pending).toBeUndefined();
  });
});

describe('a spectator', () => {
  /**
   * A one-hour personal limit, so the live entrant's window closes at 10:00
   * while the spectator's runs to the contest end at 14:00. At 13:30 the
   * spectator is the only participation inside a freeze window.
   */
  const SPECTATOR_ONLY: ContestInput = {
    format: 'default',
    format_config: null,
    contest: {
      key: 'spectate',
      start_time: START,
      end_time: END,
      time_limit_seconds: 3600,
      points_precision: 3,
      frozen_last_minutes: 60,
    },
    problems: [{ code: 'P1', points: 100, partial: false, problem_partial: false }],
    participants: [
      { name: 'alice', real_start: START, virtual: 0 },
      { name: 'watcher', real_start: START, virtual: -1 },
    ],
    submissions: [
      { participant: 'alice', problem: 'P1', date: '2026-03-01T09:30:00Z', result: 'AC', status: 'D', cases: solved() },
    ],
  };

  it('never freezes the board on its own — it is not in the ranking', () => {
    const board = computeContestScoreboard(SPECTATOR_ONLY, 'duckoj', '2026-03-01T13:30:00Z');
    expect(board.frozen).toBe(false);
    expect(rowFor(board.ranking, 'alice').pending).toBeUndefined();
  });
});
