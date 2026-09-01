/**
 * The one place a per-language limit is computed (D154).
 *
 * A problem's limits are authored against C++. A correct Python solution to
 * the same problem is slower by a factor this judge's own image puts at 110×
 * on a tight arithmetic loop, so a language row carries an adjustment and the
 * limit that is ENFORCED is the adjusted one.
 *
 * The load-bearing constraint is that the adjusted limit the judge enforces
 * and the adjusted limit the scoreboard shows are the SAME NUMBER. That is
 * why this is a function in `@duckoj/db` — the one package both `apps/api`
 * and `apps/judged` already depend on — and not a fragment of SQL, an
 * expression in the driver, and a second expression in the API. There is one
 * implementation; a caller that wants the number calls it.
 */

/** A problem revision's authored limits — what the setter wrote. */
export interface BaseLimits {
  timeMs: number;
  memoryKb: number;
}

/**
 * The adjustment in force for one (problem, language) pair: the language's
 * defaults with the problem's overrides already resolved over them. Produced
 * by `resolveLanguageTuning`.
 */
export interface LanguageTuning {
  /** Whole percent of the authored time limit. 100 is "unchanged". */
  timeMultiplierPct: number;
  /** Kilobytes added to the authored memory limit. 0 is "unchanged". */
  memoryExtraKb: number;
  /** `false` means this problem refuses this language outright. */
  allowed: boolean;
}

/** The language's own defaults, from `languages`. */
export interface LanguageDefaults {
  timeMultiplierPct: number;
  memoryExtraKb: number;
}

/**
 * A `problem_language_limits` row, or `null` when the problem has none.
 * NULL columns inherit; `allowed` is never null there, so its absence here
 * means the pair is allowed.
 */
export interface LanguageOverride {
  timeMultiplierPct: number | null;
  memoryExtraKb: number | null;
  allowed: boolean;
}

/**
 * Resolves the problem's override over the language's defaults, column by
 * column. `??`, not a whole-row choice: a row that pins the time and says
 * nothing about memory must keep inheriting the memory floor (see
 * `problemLanguageLimits`' doc comment).
 */
export function resolveLanguageTuning(
  defaults: LanguageDefaults,
  override: LanguageOverride | null | undefined,
): LanguageTuning {
  return {
    timeMultiplierPct: override?.timeMultiplierPct ?? defaults.timeMultiplierPct,
    memoryExtraKb: override?.memoryExtraKb ?? defaults.memoryExtraKb,
    allowed: override?.allowed ?? true,
  };
}

/**
 * The limits actually enforced, and therefore the limits actually shown.
 *
 * `Math.ceil` over integer arithmetic, never `timeMs * 3.0`: this runs in the
 * API process to display a number and in `judged` to enforce one, and two
 * IEEE-754 multiplications of the same operands in different call sites are
 * not something to bet a verdict on. `ceil` rather than `round` because the
 * error is one millisecond and it belongs to the pupil.
 *
 * `allowed` is deliberately NOT consulted here. A refused language is refused
 * at submit time with a reason (a 404 that names the language), not by being
 * handed a limit; a function that returned `{ timeMs: 0 }` for it would
 * present the refusal as a TLE.
 */
export function effectiveLimits(base: BaseLimits, tuning: LanguageTuning): BaseLimits {
  return {
    timeMs: Math.ceil((base.timeMs * tuning.timeMultiplierPct) / 100),
    memoryKb: base.memoryKb + tuning.memoryExtraKb,
  };
}
