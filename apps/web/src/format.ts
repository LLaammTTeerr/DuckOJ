/**
 * Display formatting shared by every screen that prints a score.
 *
 * Points are floats on the wire and in the database: an `ioi16` subtask worth
 * 100/3 arrives as `33.333333333`, and every screen that rendered
 * `{value}` straight into a `<td>` printed all eleven digits — blowing the
 * column width apart on the scoreboard and reading as false precision
 * everywhere else. Rounding is a DISPLAY concern only; nothing here is ever
 * fed back to the API, and no comparison, sort or total is computed from the
 * string this returns.
 */

/**
 * The fallback when the contest's own `pointsPrecision` is not in the payload
 * at hand. `GET /contests/{key}` carries it (the contest page uses it); the
 * scoreboard, the submissions list, the verdict panel and the profile page do
 * not, and two decimals is what every DuckOJ contest format has actually
 * been configured with.
 */
const DEFAULT_PRECISION = 2;

/**
 * `value` rounded to at most `precision` decimals, with trailing zeros — and
 * a then-orphaned decimal point — removed: `100`, `33.33`, `0.5`.
 *
 * `toFixed` rather than `Intl.NumberFormat`: this is a bare machine-readable
 * number in a monospace table, not a localized one. A thousands separator
 * would be actively wrong beside the rest of these columns, and
 * `maximumFractionDigits` would still leave the grouping in.
 *
 * A non-finite value renders as the same em dash the callers already use for
 * "no score" rather than the literal `NaN`/`Infinity`, which no reader can
 * act on.
 */
export function formatPoints(value: number, precision: number = DEFAULT_PRECISION): string {
  if (!Number.isFinite(value)) return '—';
  // `Number(…)` does the trimming: it parses "33.30" back to 33.3 and
  // "100.00" back to 100, and `String` of a float never re-emits the zeros.
  // Safe because `toFixed` has already capped the digits — the round trip
  // cannot reintroduce the precision it just removed.
  return String(Number(value.toFixed(precision)));
}
