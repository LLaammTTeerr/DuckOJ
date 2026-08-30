/**
 * The bytes a CSV this judge hands to a human has to be made of.
 *
 * D71 wrote this rule down for the contest results sheet and implemented it
 * there alone, while two other exports — the roster import's credential
 * sheet (D61) and the homework progress grid (D66) — were built by
 * hand-rolled `escape` closures that did RFC 4180 quoting and nothing else.
 * Every argument D71 makes applies to all three unchanged, because the
 * argument is about the program on the other end:
 *
 * - **A BOM.** Excel does not sniff encodings. A `.csv` without `U+FEFF` is
 *   opened in the machine's ANSI code page and `Nguyễn` arrives as
 *   `Nguyá»…n`. A Vietnamese deployment's roster sheet and class list are
 *   the two files most made of Vietnamese names in the whole system.
 * - **CRLF.** RFC 4180's terminator, and what Excel writes back on a re-save.
 * - **A formula guard.** A cell starting `=`, `+`, `-`, `@`, tab or CR is a
 *   FORMULA to a spreadsheet, so a display name of
 *   `=HYPERLINK("http://evil","Nguyễn Văn A")` executes on the teacher's
 *   machine when they open the class list. These files are the exact shape
 *   CSV injection targets: stranger-supplied text, exported by a member of
 *   staff, opened in Excel. The apostrophe prefix is the OWASP mitigation —
 *   it is data, visible in `cat`, and stripped by Excel on display.
 *
 * Only text a PERSON typed is guarded. Generated numbers never are: a score
 * cannot begin `=`, and a guard firing on one would turn every number in the
 * sheet into text.
 *
 * It lives in `@duckoj/contracts` rather than beside any one exporter for
 * `org-import-csv.ts`'s reason — three callers in three packages (the API,
 * the `org:import` CLI, and the web panel that merges a split roster's
 * credentials) have to agree about it, and `apps/api/**` is importable by
 * none of the others.
 */

/** Excel's "this file is UTF-8" marker. Not optional — see the header. */
export const CSV_BOM = '﻿';

/**
 * RFC 4180: quote when the field carries a delimiter, a quote or a newline —
 * and also when it has leading or trailing whitespace, which a bare field
 * would silently lose.
 */
export function csvQuote(field: string): string {
  if (!/[",\r\n]/.test(field) && field.trim() === field) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/**
 * A field a person typed: neutralised against formula evaluation, then
 * quoted. Everything else goes through `csvQuote` alone.
 */
export function csvText(field: string): string {
  return csvQuote(/^[=+\-@\t\r]/.test(field) ? `'${field}` : field);
}

/**
 * Rows of already-escaped cells as one file: BOM, CRLF, trailing newline.
 *
 * The cells arrive escaped rather than raw because only the caller knows
 * which of its columns a person typed and which it generated itself, and
 * that is exactly the distinction the formula guard turns on.
 */
export function csvSheet(rows: string[][]): string {
  return CSV_BOM + rows.map((cells) => cells.join(',')).join('\r\n') + '\r\n';
}
