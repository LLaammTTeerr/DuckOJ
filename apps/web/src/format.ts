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

/**
 * A duration in milliseconds as `HH:MM:SS`, zero-padded, for a live contest
 * countdown ("bắt đầu sau …" / "kết thúc sau …", D118). Hours are NOT capped
 * at 24 — an upcoming contest days away reads `72:00:15` rather than losing
 * the days — and a negative or non-finite input clamps to `00:00:00`, so a
 * clock that has already run out never prints a minus sign.
 *
 * Locale-neutral on purpose, like `formatPoints`: it is digits and colons,
 * the same in every language, so it takes no locale and carries no separator.
 */
export function formatCountdown(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
