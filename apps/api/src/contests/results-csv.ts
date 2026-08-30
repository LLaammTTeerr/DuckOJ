/**
 * The final standings as a spreadsheet (D71).
 *
 * Three decisions carry this file, and each of them is about the program on
 * the other end being Excel on a school office's Windows machine.
 *
 * **A BOM.** Excel does not sniff UTF-8: a `.csv` without `U+FEFF` is opened
 * in the machine's ANSI code page, and every Vietnamese name in it becomes
 * mojibake — `Nguyễn` reads as `Nguyá»…n`. The BOM is the one byte sequence
 * Excel does take as "this is UTF-8", and every other consumer (LibreOffice,
 * pandas, `csv.reader`) either strips it or ignores it.
 *
 * **CRLF.** RFC 4180's line terminator, and the one Excel writes back if the
 * file is ever re-saved. A quoted field containing a newline therefore stays
 * unambiguous.
 *
 * **A formula guard.** `display_name`, `username` and the organization names
 * are typed by people. A cell whose text starts `=`, `+`, `-`, `@`, a tab or
 * a carriage return is a FORMULA to Excel, so a display name of
 * `=HYPERLINK("http://evil","Nguyễn")` executes when a teacher opens the
 * results — CSV injection, and this file is the exact shape it targets: user
 * text, exported by an administrator, opened in a spreadsheet. Such a field
 * is prefixed with an apostrophe, the OWASP mitigation. Numeric columns are
 * generated here and never guarded: a score cannot start with `=`, and a
 * guard that fired on them would turn every number into text.
 */
import { csvSheet, csvText } from '@duckoj/contracts';
import type { ResultsInput, ResultRow } from '../statements/results.js';
import { formatResultPoints } from '../statements/results.js';

// The three rules above are `@duckoj/contracts/spreadsheet-csv.ts` now: the
// roster credential sheet (D61) and the homework grid (D66) are the same
// file aimed at the same program, and each had grown its own `escape` that
// did RFC 4180 quoting and no formula guard at all.
export { CSV_BOM } from '@duckoj/contracts';

/** Neutralised against formula evaluation, then quoted. Person-typed only. */
const text = csvText;

/**
 * The columns, in order. **ASCII snake_case, never translated**: a header row
 * is the file's contract with whatever script reads it next, and a column
 * that renames itself when the exporter's locale changes is a column nobody
 * can write a formula against. The Vietnamese in this file is the DATA, which
 * is what the BOM is there for.
 */
function headerRow(input: ResultsInput): string[] {
  return [
    'rank',
    'username',
    'display_name',
    'orgs',
    ...input.problems.flatMap((problem) => [
      `${problem.label}_points`,
      `${problem.label}_attempts`,
      `${problem.label}_time_seconds`,
    ]),
    'total',
    'penalty',
    'disqualified',
    'virtual',
  ];
}

function bodyRow(input: ResultsInput, row: ResultRow): string[] {
  return [
    String(row.rank),
    text(row.username),
    text(row.displayName),
    // Semicolon, not comma: a comma inside the field would be correct CSV
    // and would still read as two columns to every human scanning the file.
    text(row.orgs.join('; ')),
    ...input.problems.flatMap((problem) => {
      const entry = row.cells[problem.code];
      if (entry === undefined) return ['', '', ''];
      return [
        formatResultPoints(entry.points, input.pointsPrecision),
        // Empty, never `0`: only `icpc` counts tries, and a `0` here would
        // claim every competitor in an IOI contest never submitted.
        entry.attempts === null ? '' : String(entry.attempts),
        String(entry.timeSeconds),
      ];
    }),
    formatResultPoints(row.total, input.pointsPrecision),
    String(row.penalty),
    // `true`/`false`, not `1`/`0`: a disqualification is the one column an
    // organiser filters on by eye, and `1` in a sea of scores is not it.
    // The row is PRESENT — D37 keeps a disqualified competitor on the record
    // and this file flags them rather than dropping them (D71).
    row.disqualified ? 'true' : 'false',
    // The number, not a flag: `0` is live and `n` is the n-th virtual
    // replay, and which replay it was is a fact the export would otherwise
    // destroy. Spectators (`-1`) are never ranked, so they never appear.
    String(row.virtual),
  ];
}

/** The whole sheet: BOM, header, one line per ranked participation. */
export function resultsCsv(input: ResultsInput): string {
  return csvSheet([headerRow(input), ...input.rows.map((row) => bodyRow(input, row))]);
}
