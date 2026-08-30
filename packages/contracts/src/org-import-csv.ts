/**
 * The CSV grammar of D61's roster import, shared by everything that has to
 * agree about it.
 *
 * It lives in `@duckoj/contracts` rather than beside the server's validation
 * because THREE callers now read the same file: the API (which maps records
 * to rows), the `org:import` CLI, and — since the 500-row cap — the web
 * panel, which has to cut a large roster into requests along the same record
 * boundaries the server will read them back on. A second parser in the
 * browser is a parser that disagrees about where a quoted newline ends, and
 * the symptom would be a 422 about a pupil nobody typed.
 *
 * Nothing here validates: a record is a record, and whether it names an
 * acceptable account is `org-import.core.ts`'s question.
 */
import { csvQuote, csvSheet, csvText } from './spreadsheet-csv.js';

/**
 * RFC 4180 with the concessions a spreadsheet export actually needs: CRLF or
 * LF, `""` for a literal quote inside a quoted field, and a trailing newline
 * that does not invent an empty final row.
 *
 * Hand-written rather than a dependency because the whole grammar is thirty
 * lines and the alternative is a parser with its own options, its own
 * type-coercion opinions and its own idea of what a header is — three things
 * that would each need pinning down here anyway.
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ',' || ch === ';' || ch === '\t') {
      record.push(field);
      field = '';
      sawAnyChar = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      record.push(field);
      if (sawAnyChar || record.some((cell) => cell.trim() !== '')) records.push(record);
      record = [];
      field = '';
      sawAnyChar = false;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }
  record.push(field);
  if (sawAnyChar || record.some((cell) => cell.trim() !== '')) records.push(record);
  return records;
}

/** The three things a roster row can say. */
export type ImportColumn = 'username' | 'displayName' | 'email';

/**
 * Header names recognised, in both languages a teacher's spreadsheet is
 * likely to be in. A file with none of them is read positionally
 * (`username, displayName, email`), which is what a file pasted out of a
 * mail merge looks like.
 */
const HEADER_ALIASES: Record<string, ImportColumn> = {
  username: 'username',
  user: 'username',
  tendangnhap: 'username',
  taikhoan: 'username',
  displayname: 'displayName',
  display_name: 'displayName',
  name: 'displayName',
  fullname: 'displayName',
  hoten: 'displayName',
  email: 'email',
  mail: 'email',
  thudientu: 'email',
};

/** The positional reading of a file that has no header. */
export const DEFAULT_IMPORT_COLUMNS: Array<ImportColumn | null> = ['username', 'displayName', 'email'];

/** Lowercased, stripped of spaces, punctuation and Vietnamese diacritics. */
function headerKey(cell: string): string {
  return cell
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z_]/g, '');
}

/**
 * The columns a record declares, or `null` when it is not a header at all.
 *
 * A header is detected rather than assumed: a first record naming at least a
 * username column is a header, anything else is data. Assuming one would
 * silently swallow the first pupil of every headerless file; requiring one
 * would refuse the file a teacher typed by hand.
 */
export function importHeaderColumns(record: string[]): Array<ImportColumn | null> | null {
  const columns = record.map((cell) => HEADER_ALIASES[headerKey(cell)] ?? null);
  return columns.includes('username') ? columns : null;
}

/** Strips the BOM a spreadsheet export puts in front of everything. */
export function importRecords(text: string): string[][] {
  return parseCsvRecords(text.replace(/^\ufeff/, ''));
}

/** One record back to a CSV line, escaped as RFC 4180 wants it. */
function csvLine(record: string[]): string {
  return record
    .map((cell) => (/[",;\t\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',');
}

/**
 * One roster file as several, each at most `size` DATA rows and each
 * carrying the file's own header when it has one.
 *
 * The header travels with every chunk rather than only the first: the server
 * reads each request on its own and would otherwise take chunk two's first
 * pupil for a header row — or, worse, read a headerless file's columns in a
 * different order from the one the teacher wrote.
 *
 * Records are re-serialised rather than sliced out of the original text so a
 * quoted newline cannot become a chunk boundary; they round-trip through
 * `parseCsvRecords` unchanged.
 *
 * A file with NO header gets one anyway — `username,displayName,email`, the
 * names of `DEFAULT_IMPORT_COLUMNS`, which is exactly the positional reading
 * such a file already had. Emitting the chunks bare looks equivalent and is
 * not, because the server detects a header per request rather than being
 * told one: whichever record happens to land first in a chunk decides that
 * chunk's columns. `user`, `taikhoan` and `tendangnhap` are all valid
 * usernames (D8 allows any 3–32 characters of the class) and all header
 * aliases, so one pupil whose row opens a chunk is read as that chunk's
 * header — swallowed silently, or, worse, taken as a column layout that
 * re-reads every remaining row in the chunk. The import answers 201 either
 * way and the credential sheet is short of the class with nothing to say so.
 * Declaring the reading makes every chunk say what the whole file said.
 */
export function splitImportCsv(text: string, size: number): string[] {
  const records = importRecords(text);
  if (records.length === 0) return [];
  const declared = importHeaderColumns(records[0]!);
  const header = declared === null ? DEFAULT_HEADER_RECORD : records[0]!;
  const body = declared === null ? records : records.slice(1);
  if (body.length === 0) return [];

  const chunks: string[] = [];
  for (let start = 0; start < body.length; start += size) {
    const lines = body.slice(start, start + size).map(csvLine);
    lines.unshift(csvLine(header));
    chunks.push(`${lines.join('\n')}\n`);
  }
  return chunks;
}

/**
 * `DEFAULT_IMPORT_COLUMNS` written out as a header record — the one a
 * headerless file's chunks carry. Every name here is its own alias in
 * `HEADER_ALIASES`, so the server reads it back as the same positional
 * layout; a test pins that round trip.
 */
const DEFAULT_HEADER_RECORD = ['username', 'displayName', 'email'];

/**
 * Every username the file names, in order — the one field that has to be
 * unique across the WHOLE roster rather than within one request.
 *
 * The server validates a request against itself and against the database; it
 * cannot see a repeat that lands in a different chunk, and by the time the
 * unique index catches one, earlier chunks have already created accounts.
 * The caller doing the splitting is the only place that can refuse it first.
 */
export function importUsernames(text: string): string[] {
  const records = importRecords(text);
  if (records.length === 0) return [];
  const declared = importHeaderColumns(records[0]!);
  const columns = declared ?? DEFAULT_IMPORT_COLUMNS;
  const body = declared === null ? records : records.slice(1);
  const at = columns.indexOf('username');
  return body.map((record) => (at === -1 ? '' : (record[at] ?? '').trim()));
}

/** One imported account, as the credential sheet lists it. */
export interface ImportedCredential {
  username: string;
  displayName: string;
  password: string;
}

/**
 * The credential sheet, as a CSV a teacher can open in a spreadsheet.
 *
 * Here rather than beside the server's import for the reason the record
 * grammar above is: THREE callers build or merge this file — the API, the
 * `org:import` CLI, and the web panel, which sends a large roster as several
 * requests and has to hand back ONE sheet rather than the responses
 * concatenated (which put a second header row in the middle of the file,
 * where Excel reads it as a pupil called `username`).
 *
 * It is `spreadsheet-csv.ts`'s shape — BOM, CRLF, and the formula guard on
 * the two fields a person typed. A generated password is never guarded: its
 * alphabet holds no `=`, `+`, `-` or `@` (D61), and an apostrophe in front
 * of a credential somebody has to read off paper and type in is a support
 * call.
 */
export function credentialsCsv(created: ImportedCredential[]): string {
  return csvSheet([
    ['username', 'displayName', 'password'],
    ...created.map((row) => [
      csvText(row.username),
      csvText(row.displayName),
      csvQuote(row.password),
    ]),
  ]);
}
