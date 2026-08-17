import { describe, expect, it } from 'vitest';
import { DMOJ_FLAG, interpretFlags } from '../src/index.js';

describe('interpretFlags', () => {
  it('maps a zero mask to accepted', () => {
    expect(interpretFlags(0)).toEqual({ verdict: 'AC', skipped: false, flags: [] });
  });

  it('maps each single flag to its verdict', () => {
    expect(interpretFlags(DMOJ_FLAG.WA).verdict).toBe('WA');
    expect(interpretFlags(DMOJ_FLAG.RTE).verdict).toBe('RTE');
    expect(interpretFlags(DMOJ_FLAG.TLE).verdict).toBe('TLE');
    expect(interpretFlags(DMOJ_FLAG.MLE).verdict).toBe('MLE');
    expect(interpretFlags(DMOJ_FLAG.IR).verdict).toBe('IR');
    expect(interpretFlags(DMOJ_FLAG.OLE).verdict).toBe('OLE');
    expect(interpretFlags(DMOJ_FLAG.IE).verdict).toBe('IE');
  });

  it('resolves a combined mask by DMOJ display precedence, not bit order', () => {
    // WA is bit 0 and TLE is bit 2, so a naive lowest-bit-wins reading gives WA.
    // DMOJ's own CODE_DISPLAY_ORDER puts TLE ahead of WA.
    expect(interpretFlags(DMOJ_FLAG.WA | DMOJ_FLAG.TLE).verdict).toBe('TLE');
    expect(interpretFlags(DMOJ_FLAG.WA | DMOJ_FLAG.IE).verdict).toBe('IE');
    expect(interpretFlags(DMOJ_FLAG.TLE | DMOJ_FLAG.MLE).verdict).toBe('TLE');
    expect(interpretFlags(DMOJ_FLAG.RTE | DMOJ_FLAG.IR).verdict).toBe('RTE');
  });

  it('treats short-circuit as skipped rather than as a verdict', () => {
    expect(interpretFlags(DMOJ_FLAG.SC)).toEqual({
      verdict: null,
      skipped: true,
      flags: ['SC'],
    });
  });

  it('retains every raw flag for diagnostics', () => {
    expect(interpretFlags(DMOJ_FLAG.WA | DMOJ_FLAG.TLE).flags.sort()).toEqual(['TLE', 'WA']);
  });

  it('reports an unknown bit as an internal error rather than silently ignoring it', () => {
    const unknownBit = 1 << 12;
    expect(interpretFlags(unknownBit).verdict).toBe('IE');
  });
});
