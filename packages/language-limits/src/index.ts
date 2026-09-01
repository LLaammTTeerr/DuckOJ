/**
 * The one place a per-language limit is computed, and the one place its
 * bounds are stated (D154, D159).
 *
 * A problem's limits are authored against C++. A correct Python solution to
 * the same problem is slower by a factor this judge's own image puts at 110×
 * on a tight arithmetic loop, so a language row carries an adjustment and the
 * limit that is ENFORCED is the adjusted one.
 *
 * The load-bearing constraint is that the adjusted limit the judge enforces
 * and the adjusted limit the scoreboard shows are the SAME NUMBER. That is
 * why this is a function rather than a fragment of SQL, an expression in the
 * driver, and a second expression in the API. There is one implementation; a
 * caller that wants the number calls it.
 *
 * **It lives in its own package rather than in `@duckoj/db` (D159).** D154
 * put it there because `@duckoj/db` was the one package both `apps/api` and
 * `apps/judged` already depended on, and that was the whole set of callers
 * while the only way to write an override was raw SQL. The authoring form
 * added a third: it must show the resulting limits for values the setter has
 * TYPED and not yet saved, which no server round-trip can answer. `apps/web`
 * cannot depend on `@duckoj/db` — that package imports `drizzle-orm` and
 * `postgres` — so the alternative to moving the file was re-deriving
 * `ceil(ms * pct / 100)` in a browser, which is exactly the second
 * implementation D154 exists to forbid. Zero dependencies, deliberately:
 * that is what lets every caller have it. `@duckoj/db` re-exports the whole
 * module, so nothing that imported it from there had to change.
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

/* ─────────────────────────── the bounds (D159) ──────────────────────────── */

/**
 * **An adjustment may never take away from what the setter authored.**
 *
 * That is one rule in two units, and it is where both floors come from. The
 * time adjustment is a multiplier, so "takes nothing away" is 100 %; the
 * memory adjustment is an addend, so "takes nothing away" is 0 KB. Below
 * either floor the pupil is failed by policy while being told they were
 * failed by speed or by size — D154's own words: "a zero limit would present
 * the refusal as a TLE, teaching the pupil that their correct program was too
 * slow." A setter who genuinely means "this problem cannot be solved in this
 * language" has `allowed = false`, which is a 404 at submit time and says so.
 *
 * `time_multiplier_pct = 0` was reachable until this constant existed
 * (B-30 found no CHECK on the column, and `problem_language_limits` had no
 * authoring surface at all, so the only way to write one was SQL against
 * production). 1 % is as broken as 0 and 99 % is the same lie in miniature.
 */
export const TIME_MULTIPLIER_PCT_MIN = 100;

/**
 * Ten times the authored limit, and the ceiling exists because an unbounded
 * one is a denial of service on a province's single judge.
 *
 * D154's own arithmetic: a 350-test problem authored at 1 s costs 350 s of
 * judge wall clock per submission at 100 %, and D154 rejected the measured
 * 110× interpreter factor by name for exactly this reason — "110× would make
 * every deep-recursion or heavy-loop problem a denial-of-service on the one
 * judge this province has." At this ceiling that same problem costs 3500 s,
 * just under an hour, for ONE submission; past it a single pupil can hold the
 * fleet for a lesson. Ten is also 3.3× the largest multiplier this deployment
 * actually uses (`python3` at 300 %), so it is headroom rather than a
 * constraint on any language anyone has proposed.
 */
export const TIME_MULTIPLIER_PCT_MAX = 1000;

/** See `TIME_MULTIPLIER_PCT_MIN`: the same rule, in the addend's unit. */
export const MEMORY_EXTRA_KB_MIN = 0;

/**
 * One gibibyte, and the reason is what the addend MEANS.
 *
 * It is a runtime FLOOR — the resident set an interpreter occupies before the
 * solution allocates anything. CPython 3.11's, measured on this judge's own
 * image, is 15044 KB; a JVM's is tens of megabytes. Nothing that is a floor
 * is a gigabyte wide, so a value past this is not a floor being declared but
 * a different memory limit being smuggled in, and a memory limit the setter
 * means to change belongs on the revision where it was authored. The other
 * half is the judge box: a limit larger than its RAM turns what should be an
 * MLE for one submission into the kernel choosing a victim, and the victim it
 * chooses may be the judge.
 */
export const MEMORY_EXTRA_KB_MAX = 1_048_576;
