/**
 * The two printable artefacts of a contest's results (D71): the final
 * standings, and a certificate per participant.
 *
 * Both are typst documents built the way `bookletToTypst` (D48) builds the
 * problem booklet — one document per request, `escapeText` over every piece
 * of text that came from a person, and **no statement text anywhere**. That
 * last point is D62 by construction rather than by a visibility clause: a
 * standings table and a certificate are names, ranks and numbers, so there
 * is nothing here for `visibleProblemsWhere` to narrow. A problem's LABEL
 * appears (it is on the public scoreboard already) and its statement never
 * does.
 *
 * **Neither document reads a clock.** The date printed on a certificate is
 * the contest's own end, never `now`. Two things follow, and the second is
 * the load-bearing one: the artefact a competitor is handed is the same
 * document whoever printed it and whenever, and the 60 s content-addressed
 * cache (`results.cache.ts`) can actually hit — a document carrying the
 * current second hashes to a fresh key every second, which is a cache that
 * costs a sha256 and returns nothing.
 */
import { escapeText } from './markdown-to-typst.js';

/** One problem's column on the standings, in contest order. */
export interface ResultProblem {
  code: string;
  /** The contest's own label — `A`, `B`, `1`… — the column heading. */
  label: string;
}

/** What one participation scored on one problem. */
export interface ResultCell {
  points: number;
  /**
   * Submissions counted against this cell, or `null` for a format that does
   * not track them: only `icpc` carries `tries`, and an empty column is
   * honest where a `0` would claim the competitor never submitted.
   */
  attempts: number | null;
  /** Seconds from the participation's own start (`format_data[code].time`). */
  timeSeconds: number;
}

/** One ranked row: a PARTICIPATION, not a person (D36). */
export interface ResultRow {
  rank: number;
  username: string;
  displayName: string;
  /** The competitor's own organizations, names, slug-ordered (D71). */
  orgs: string[];
  /** `0` live, `n > 0` the n-th virtual replay. Spectators are never ranked. */
  virtual: number;
  disqualified: boolean;
  total: number;
  /** `cumtime` — ICPC penalty seconds; `0` for the formats that have none. */
  penalty: number;
  /** Keyed by problem CODE, matching `format_data`. */
  cells: Record<string, ResultCell>;
}

/** Everything both exports need, and nothing either of them may not have. */
export interface ResultsInput {
  contestKey: string;
  contestName: string;
  startTime: Date;
  endTime: Date;
  pointsPrecision: number;
  problems: ResultProblem[];
  rows: ResultRow[];
  /**
   * Who signs a certificate: the contest's organizations (D56), and the
   * site's own name when it has none. Ignored by the standings.
   */
  issuer: string;
}

/** The site itself, when a contest is restricted to no organization (D71). */
export const DEFAULT_ISSUER = 'DuckOJ';

/**
 * Indochina Time, exactly as the booklet fixes it and for the same reason: a
 * result sheet printed for a room in Vietnam and dated in UTC states the
 * wrong day for anything ending after 17:00 local.
 */
const RESULTS_TZ = 'Asia/Ho_Chi_Minh';

function formatInstant(at: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: RESULTS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/** `29/08/2026` — the day order a Vietnamese certificate is read in. */
function formatDay(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: RESULTS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * `100`, `33.33` — never `33.330000000000005`.
 *
 * A float reaching the page with seventeen digits would be the contest's own
 * `points_precision` silently not applying to the printed artefact while it
 * applies to the board everyone compared against.
 */
export function formatResultPoints(value: number, precision: number): string {
  return String(Number(value.toFixed(precision)));
}

/** A table cell, escaped. The booklet's own helper, kept identical. */
function cell(text: string): string {
  return `[${escapeText(text)}]`;
}

const STANDINGS_WORDS = {
  title: 'Kết quả chung cuộc',
  subtitle: 'Final standings',
  window: 'Thời gian thi',
  rank: 'Hạng',
  user: 'Tài khoản',
  name: 'Họ tên',
  org: 'Đơn vị',
  total: 'Tổng',
  penalty: 'Phạt',
} as const;

/**
 * How a row's name column reads: the display name, plus the two facts the
 * ranking number alone hides.
 *
 * `[DQ]` is D37's own rendering — a disqualified competitor stays ON the
 * sheet, marked, because the record of what happened is the row. `(ảo)`
 * marks a virtual replay, which is ranked beside the live entrants and is
 * not the same achievement.
 */
function nameCell(row: ResultRow): string {
  const marks = [row.disqualified ? '[DQ]' : null, row.virtual > 0 ? '(ảo)' : null].filter(
    (mark) => mark !== null,
  );
  return cell([row.displayName, ...marks].join(' '));
}

/** `100 (3)` — points, and the attempts that bought them where a format counts. */
function scoreCell(entry: ResultCell | undefined, precision: number): string {
  if (entry === undefined) return cell('—');
  const points = formatResultPoints(entry.points, precision);
  return cell(entry.attempts === null ? points : `${points} (${String(entry.attempts)})`);
}

/**
 * The final standings as ONE landscape typst document (D71).
 *
 * Landscape because the table is one column per problem plus six: a
 * ten-problem contest does not fit A4 portrait, and a typst table that
 * overflows the page does not wrap — it runs off it.
 *
 * `table.header` rather than a plain first row, so a province-sized board
 * repeats its column headings on page four; `numbering` on the page, so the
 * printed sheets can be collated. Both are what the booklet already does.
 */
export function standingsToTypst(input: ResultsInput): string {
  const columns = 4 + input.problems.length + 2;
  const header = [
    cell(STANDINGS_WORDS.rank),
    cell(STANDINGS_WORDS.user),
    cell(STANDINGS_WORDS.name),
    cell(STANDINGS_WORDS.org),
    ...input.problems.map((problem) => cell(problem.label)),
    cell(STANDINGS_WORDS.total),
    cell(STANDINGS_WORDS.penalty),
  ].join(', ');

  const body = input.rows
    .map((row) =>
      [
        cell(String(row.rank)),
        cell(row.username),
        nameCell(row),
        cell(row.orgs.join('; ')),
        ...input.problems.map((problem) =>
          scoreCell(row.cells[problem.code], input.pointsPrecision),
        ),
        cell(formatResultPoints(row.total, input.pointsPrecision)),
        cell(String(row.penalty)),
      ].join(', '),
    )
    .join(',\n  ');

  return (
    [
      '#set page(paper: "a4", flipped: true, margin: 1.5cm, numbering: "1")',
      '#set text(9pt)',
      `#align(center)[#text(18pt, weight: "bold")[${escapeText(input.contestName)}]]`,
      `#align(center)[${escapeText(`${STANDINGS_WORDS.title} · ${STANDINGS_WORDS.subtitle}`)}]`,
      `#align(center)[${escapeText(
        `${STANDINGS_WORDS.window}: ${formatInstant(input.startTime)} – ${formatInstant(
          input.endTime,
        )} (GMT+7)`,
      )}]`,
      '#v(0.8em)',
      '#table(',
      `  columns: ${String(columns)},`,
      '  align: left,',
      `  table.header(${header}),`,
      // A contest nobody entered is a heading and an empty table, never a
      // dangling comma that fails to compile.
      input.rows.length === 0 ? null : `  ${body},`,
      ')',
    ]
      .filter((line) => line !== null)
      .join('\n') + '\n'
  );
}

const CERTIFICATE_WORDS = {
  title: 'GIẤY CHỨNG NHẬN',
  subtitle: 'CERTIFICATE OF ACHIEVEMENT',
  certifies: 'Chứng nhận thí sinh / This certifies that',
  achieved: 'đã đạt / has achieved',
  rank: 'Hạng',
  rankEn: 'Rank',
  score: 'Tổng điểm / Total score',
  contest: 'trong kỳ thi / in the contest',
  dated: 'Ngày / Date',
  signature: 'Người ký / Signature',
} as const;

/** `Hạng 3 / Rank 3` — the result, in both languages, on one line. */
function rankLine(row: ResultRow): string {
  return `${CERTIFICATE_WORDS.rank} ${String(row.rank)} / ${CERTIFICATE_WORDS.rankEn} ${String(
    row.rank,
  )}`;
}

/** One certificate's page, without the break that separates it from the next. */
function certificatePage(input: ResultsInput, row: ResultRow): string {
  return [
    '#align(center)[',
    `  #text(14pt, weight: "bold")[${escapeText(input.issuer)}]`,
    '  #v(1.2em)',
    `  #text(34pt, weight: "bold")[${escapeText(CERTIFICATE_WORDS.title)}]`,
    '  #linebreak()',
    `  #text(13pt)[${escapeText(CERTIFICATE_WORDS.subtitle)}]`,
    '  #v(1.4em)',
    `  #text(12pt)[${escapeText(CERTIFICATE_WORDS.certifies)}]`,
    '  #linebreak()',
    `  #text(24pt, weight: "bold")[${escapeText(row.displayName)}]`,
    '  #linebreak()',
    `  #text(11pt)[${escapeText(`(${row.username})`)}]`,
    '  #v(0.8em)',
    `  #text(12pt)[${escapeText(CERTIFICATE_WORDS.achieved)}]`,
    '  #linebreak()',
    `  #text(20pt, weight: "bold")[${escapeText(rankLine(row))}]`,
    '  #linebreak()',
    `  #text(12pt)[${escapeText(
      `${CERTIFICATE_WORDS.score}: ${formatResultPoints(row.total, input.pointsPrecision)}`,
    )}]`,
    '  #v(0.8em)',
    `  #text(12pt)[${escapeText(CERTIFICATE_WORDS.contest)}]`,
    '  #linebreak()',
    `  #text(18pt, weight: "bold")[${escapeText(input.contestName)}]`,
    ']',
    '#v(2em)',
    '#align(right)[',
    `  #text(11pt)[${escapeText(`${CERTIFICATE_WORDS.dated}: ${formatDay(input.endTime)}`)}]`,
    '  #linebreak()',
    `  #text(11pt)[${escapeText(input.issuer)}]`,
    '  #v(0.4em)',
    '  #line(length: 6cm)',
    '  #linebreak()',
    `  #text(10pt)[${escapeText(CERTIFICATE_WORDS.signature)}]`,
    ']',
  ].join('\n');
}

/**
 * One A4 landscape certificate per row (D71), in the order given.
 *
 * The signature rule is `#line`, not a run of underscores: `escapeText`
 * escapes `_`, so a typed rule would print as literal backslashed
 * underscores across the foot of every certificate.
 *
 * No page numbering — a certificate is handed to one person, and "3/40" in
 * its corner says out loud how many other people got the same one.
 */
export function certificatesToTypst(input: ResultsInput): string {
  const head = ['#set page(paper: "a4", flipped: true, margin: 2cm)', '#set text(12pt)'].join('\n');
  // The break goes BETWEEN certificates: a leading one prints a blank first
  // page and a trailing one a blank last.
  const pages = input.rows.map((row) => certificatePage(input, row)).join('\n#pagebreak()\n');
  return (input.rows.length === 0 ? head : `${head}\n${pages}`) + '\n';
}
