/**
 * judge-server transmits a case result as a BITMASK, not an enum:
 * `WA | TLE` is a single value (`dmoj/result.py`). Our domain has one
 * verdict per case, so the mask is resolved here and never travels further.
 *
 * Nothing downstream may branch on the raw mask. The Phase 4 scoreboards
 * read `verdict`; leaking the mask would make every one of them carry
 * judge-implementation detail.
 */
export const DMOJ_FLAG = {
  WA: 1 << 0,
  RTE: 1 << 1,
  TLE: 1 << 2,
  MLE: 1 << 3,
  IR: 1 << 4,
  SC: 1 << 5,
  OLE: 1 << 6,
  IE: 1 << 30,
} as const;

export type Verdict = 'AC' | 'WA' | 'TLE' | 'MLE' | 'OLE' | 'RTE' | 'IR' | 'IE';

/**
 * judge-server's own `Result.CODE_DISPLAY_ORDER`. Deliberately NOT bit order:
 * WA is bit 0 but loses to TLE, so a lowest-bit-wins reading is wrong.
 */
const PRECEDENCE: ReadonlyArray<readonly [number, Verdict]> = [
  [DMOJ_FLAG.IE, 'IE'],
  [DMOJ_FLAG.TLE, 'TLE'],
  [DMOJ_FLAG.MLE, 'MLE'],
  [DMOJ_FLAG.OLE, 'OLE'],
  [DMOJ_FLAG.RTE, 'RTE'],
  [DMOJ_FLAG.IR, 'IR'],
  [DMOJ_FLAG.WA, 'WA'],
];

const KNOWN_BITS = Object.values(DMOJ_FLAG).reduce((acc, bit) => acc | bit, 0);

export interface CaseOutcome {
  /** `null` when the case was short-circuited and therefore never ran. */
  verdict: Verdict | null;
  skipped: boolean;
  /** Every raw flag, for diagnostics only. */
  flags: string[];
}

export function interpretFlags(mask: number): CaseOutcome {
  const flags = Object.entries(DMOJ_FLAG)
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name);

  if ((mask & DMOJ_FLAG.SC) !== 0) {
    return { verdict: null, skipped: true, flags };
  }

  // An unrecognised bit means judge-server signalled something this mapping
  // does not model. Reporting IE is loud and safe; silently treating it as
  // accepted would turn a protocol gap into a wrong verdict.
  if ((mask & ~KNOWN_BITS) !== 0) {
    return { verdict: 'IE', skipped: false, flags: [...flags, 'UNKNOWN'] };
  }

  if (mask === 0) return { verdict: 'AC', skipped: false, flags: [] };

  for (const [bit, verdict] of PRECEDENCE) {
    if ((mask & bit) !== 0) return { verdict, skipped: false, flags };
  }

  return { verdict: 'IE', skipped: false, flags };
}
