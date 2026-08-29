import { describe, expect, it } from 'vitest';
import { resolveWorkerCount } from '../src/cluster.js';

describe('resolveWorkerCount', () => {
  it('defaults to the machine parallelism when API_WORKERS is unset', () => {
    expect(resolveWorkerCount({}, 4)).toBe(4);
  });

  it('caps the default at 8 however many cores the machine has', () => {
    // A 64-core box is not a licence to open 64 pools of 10 connections
    // against a Postgres whose default max_connections is 100.
    expect(resolveWorkerCount({}, 64)).toBe(8);
  });

  it('never defaults below one worker', () => {
    expect(resolveWorkerCount({}, 0)).toBe(1);
  });

  it('honours an explicit API_WORKERS', () => {
    expect(resolveWorkerCount({ API_WORKERS: '2' }, 16)).toBe(2);
  });

  it('honours an explicit API_WORKERS above the default cap', () => {
    // The cap is a default, not a ceiling: an operator who has raised
    // max_connections may ask for more, and must not be silently clamped.
    expect(resolveWorkerCount({ API_WORKERS: '12' }, 4)).toBe(12);
  });

  it('treats API_WORKERS=1 as "no clustering"', () => {
    expect(resolveWorkerCount({ API_WORKERS: '1' }, 16)).toBe(1);
  });

  it('ignores surrounding whitespace', () => {
    expect(resolveWorkerCount({ API_WORKERS: ' 3 ' }, 16)).toBe(3);
  });

  it('treats an empty API_WORKERS as unset', () => {
    // Compose writes `API_WORKERS=` for a variable that is declared but has
    // no value; that must mean "default", not "invalid".
    expect(resolveWorkerCount({ API_WORKERS: '' }, 4)).toBe(4);
  });

  it.each(['0', '-1', '2.5', 'four', '4x'])('refuses API_WORKERS=%s', (value) => {
    // Fail at boot rather than silently serving on one worker: a deploy that
    // asked for eight and quietly got one is a capacity incident nobody sees
    // until the contest starts.
    expect(() => resolveWorkerCount({ API_WORKERS: value }, 4)).toThrow(/API_WORKERS/);
  });
});
