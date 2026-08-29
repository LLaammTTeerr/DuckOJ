import { describe, expect, it } from 'vitest';
import { formatPoints } from '../src/format.js';

describe('formatPoints', () => {
  it('drops the decimal point entirely when the value is whole', () => {
    expect(formatPoints(100)).toBe('100');
    expect(formatPoints(0)).toBe('0');
  });

  it('trims a repeating float to the default two decimals', () => {
    // The bug this formatter exists for: a 100/3 subtask score reached the
    // scoreboard as `33.333333333` and blew the column width apart.
    expect(formatPoints(33.333333333)).toBe('33.33');
    expect(formatPoints(66.666666666)).toBe('66.67');
  });

  it('keeps a meaningful decimal but drops trailing zeros', () => {
    expect(formatPoints(0.5)).toBe('0.5');
    expect(formatPoints(2.5)).toBe('2.5');
    expect(formatPoints(1.1)).toBe('1.1');
  });

  it('honours an explicit precision — the contest pointsPrecision', () => {
    expect(formatPoints(33.333333333, 3)).toBe('33.333');
    expect(formatPoints(33.333333333, 0)).toBe('33');
    // Trailing zeros go at every precision, not just the default.
    expect(formatPoints(1.5, 3)).toBe('1.5');
    expect(formatPoints(2, 4)).toBe('2');
  });

  it('rounds rather than truncates', () => {
    expect(formatPoints(0.999)).toBe('1');
  });

  it('keeps negatives and passes non-finite values through readably', () => {
    expect(formatPoints(-2.5)).toBe('-2.5');
    expect(formatPoints(Number.NaN)).toBe('—');
    expect(formatPoints(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
