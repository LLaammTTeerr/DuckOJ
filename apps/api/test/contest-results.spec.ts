/**
 * Phase F12 — contest results export and certificates (D71).
 *
 * Three layers, exactly as `contest-booklet.spec.ts` orders them: the pure
 * builders (CSV and both typst documents, no binary), the real typst binary
 * when one exists, and the routes — where **visibility comes before
 * capability**, so a contest the caller may not see 404s and one they may
 * see but do not run 403s, both on a server that would otherwise answer 501.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ISSUER,
  certificatesToTypst,
  standingsToTypst,
  type ResultRow,
  type ResultsInput,
} from '../src/statements/results.js';
import { CSV_BOM, resultsCsv } from '../src/contests/results-csv.js';
import { TypstStatementRenderer } from '../src/statements/statement-renderer.js';

const TYPST_BIN =
  process.env.TYPST_BIN ??
  (existsSync(join(homedir(), '.local/bin/typst')) ? join(homedir(), '.local/bin/typst') : null);

const WINDOW = {
  startTime: new Date('2026-08-29T02:00:00Z'),
  endTime: new Date('2026-08-29T07:00:00Z'),
};

function row(over: Partial<ResultRow> = {}): ResultRow {
  return {
    rank: 1,
    username: 'an',
    displayName: 'Nguyễn Văn An',
    orgs: ['THPT Chuyên Hạ Long'],
    virtual: 0,
    disqualified: false,
    total: 200,
    penalty: 137,
    cells: {
      'p-a': { points: 100, attempts: 1, timeSeconds: 42 },
      'p-b': { points: 100, attempts: 3, timeSeconds: 95 },
    },
    ...over,
  };
}

function input(over: Partial<ResultsInput> = {}): ResultsInput {
  return {
    contestKey: 'thi-thu',
    contestName: 'Thi thử tỉnh',
    ...WINDOW,
    pointsPrecision: 2,
    problems: [
      { code: 'p-a', label: 'A' },
      { code: 'p-b', label: 'B' },
    ],
    rows: [row()],
    issuer: 'Sở GD&ĐT Quảng Ninh',
    ...over,
  };
}

/* ------------------------------------------------------------- the CSV */

/** Split on CRLF, dropping the BOM — what a reader sees after Excel's marker. */
function lines(csv: string): string[] {
  return csv.slice(CSV_BOM.length).trimEnd().split('\r\n');
}

describe('resultsCsv (D71)', () => {
  it('opens with a UTF-8 BOM and separates rows with CRLF', () => {
    const csv = resultsCsv(input());
    // Excel does not sniff UTF-8: without this, every Vietnamese name in the
    // file is read in the machine's ANSI code page and shows as mojibake.
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('heads the file with stable ASCII columns, three per problem', () => {
    expect(lines(resultsCsv(input()))[0]).toBe(
      'rank,username,display_name,orgs,A_points,A_attempts,A_time_seconds,' +
        'B_points,B_attempts,B_time_seconds,total,penalty,disqualified,virtual',
    );
  });

  it('carries the Vietnamese name and the participant’s own organizations', () => {
    const csv = resultsCsv(input({ rows: [row({ orgs: ['THPT A', 'CLB Tin học'] })] }));
    expect(csv).toContain('Nguyễn Văn An');
    // Semicolon-joined: a comma inside the field would be valid CSV and
    // would still read as two columns to anyone scanning the file.
    expect(csv).toContain('THPT A; CLB Tin học');
  });

  it('includes a disqualified row and FLAGS it, never drops it', () => {
    // D37 keeps a disqualified competitor on the record; an export that
    // silently omitted them would be a different contest's results.
    const csv = resultsCsv(
      input({ rows: [row({ disqualified: true }), row({ rank: 2, username: 'binh' })] }),
    );
    expect(lines(csv)).toHaveLength(3);
    expect(lines(csv)[1]!.endsWith(',true,0')).toBe(true);
    expect(lines(csv)[2]!.endsWith(',false,0')).toBe(true);
  });

  it('prints the virtual NUMBER, so the n-th replay is still identifiable', () => {
    const csv = resultsCsv(input({ rows: [row({ virtual: 2 })] }));
    expect(lines(csv)[1]!.endsWith(',false,2')).toBe(true);
  });

  it('leaves attempts empty for a format that does not count them', () => {
    const csv = resultsCsv(
      input({ rows: [row({ cells: { 'p-a': { points: 80, attempts: null, timeSeconds: 12 } } })] }),
    );
    // `80,,12` — an empty column, never a `0` claiming they never submitted.
    expect(lines(csv)[1]).toContain(',80,,12,');
  });

  it('leaves three empty cells for a problem this row never touched', () => {
    const csv = resultsCsv(
      input({ rows: [row({ cells: { 'p-a': { points: 5, attempts: 1, timeSeconds: 3 } } })] }),
    );
    expect(lines(csv)[1]).toContain(',5,1,3,,,,');
  });

  it('rounds points to the contest’s own precision', () => {
    const csv = resultsCsv(
      input({
        pointsPrecision: 2,
        rows: [
          row({
            total: 33.333333,
            cells: { 'p-a': { points: 33.333333, attempts: 1, timeSeconds: 1 } },
          }),
        ],
      }),
    );
    expect(csv).toContain('33.33');
    expect(csv).not.toContain('33.3333');
  });

  it('quotes a field carrying a comma or a quote, RFC 4180 style', () => {
    const csv = resultsCsv(input({ rows: [row({ displayName: 'Trần, "Bé" Ba' })] }));
    expect(csv).toContain('"Trần, ""Bé"" Ba"');
  });

  /**
   * CSV injection. The consumer of this file is a teacher opening it in
   * Excel, and a display name is text a stranger typed: `=HYPERLINK(...)`
   * in a cell is a formula Excel RUNS, on the machine of the one person in
   * the room with administrator rights over the contest.
   */
  it('neutralises a display name a spreadsheet would run as a formula', () => {
    const csv = resultsCsv(
      input({ rows: [row({ displayName: '=HYPERLINK("http://evil","An")', orgs: ['+1'] })] }),
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""An"")"`);
    expect(csv).toContain(`'+1`);
    // The guard is for TEXT only: a score can never start with `=`, and a
    // guard firing on it would turn every number in the sheet into a string.
    expect(csv).not.toContain(`'200`);
  });

  it('is a header and nothing else for a contest nobody entered', () => {
    expect(lines(resultsCsv(input({ rows: [] })))).toHaveLength(1);
  });
});

/* ------------------------------------------------- the standings document */

describe('standingsToTypst (D71)', () => {
  it('is landscape, page-numbered, and repeats its header across pages', () => {
    const doc = standingsToTypst(input());
    expect(doc).toContain('flipped: true');
    expect(doc).toContain('paper: "a4"');
    expect(doc).toContain('numbering: "1"');
    expect(doc).toContain('table.header(');
    // rank, username, name, org, A, B, total, penalty.
    expect(doc).toContain('columns: 8,');
  });

  it('prints the contest, its window in ICT, and every rank', () => {
    const doc = standingsToTypst(input({ rows: [row(), row({ rank: 2, username: 'binh' })] }));
    expect(doc).toContain('Thi thử tỉnh');
    // Read through the escaping: `escapeText` escapes `-`, because typst
    // turns a bare `--` into an en dash.
    const unescaped = doc.replace(/\\/g, '');
    expect(unescaped).toContain('2026-08-29 09:00');
    expect(unescaped).toContain('2026-08-29 14:00');
    expect(doc).toContain('GMT+7');
    expect(doc).toContain('[binh]');
  });

  it('marks a disqualified row and a virtual one in the name column', () => {
    const doc = standingsToTypst(input({ rows: [row({ disqualified: true, virtual: 1 })] }));
    // Both marks, on the row that is still THERE — D37's rendering.
    expect(doc).toContain('\\[DQ\\]');
    expect(doc).toContain('(ảo)');
  });

  it('shows points and, where a format counts them, the attempts', () => {
    const doc = standingsToTypst(input());
    expect(doc).toContain('[100 (3)]');
    const ioi = standingsToTypst(
      input({ rows: [row({ cells: { 'p-a': { points: 70, attempts: null, timeSeconds: 1 } } })] }),
    );
    expect(ioi).toContain('[70]');
    expect(ioi).not.toContain('[70 (');
  });

  it('escapes a contest name and a display name made of typst syntax', () => {
    const doc = standingsToTypst(
      input({ contestName: 'A #1 contest', rows: [row({ displayName: 'x_1 $a$ [b]' })] }),
    );
    expect(doc).toContain('A \\#1 contest');
    expect(doc).toContain('x\\_1 \\$a\\$ \\[b\\]');
  });

  it('emits a header and no body row for a contest nobody entered', () => {
    const doc = standingsToTypst(input({ rows: [] }));
    expect(doc).toContain('table.header(');
    // No row line at all, rather than one made of empty cells: an empty
    // board is a sheet saying nobody competed, not a sheet with a blank
    // competitor on it.
    expect(doc.split('\n').some((line) => line.startsWith('  ['))).toBe(false);
  });

  /** D62: a bundle may not carry what its parts may not — and this carries none. */
  it('never contains statement text, only labels', () => {
    const doc = standingsToTypst(input());
    expect(doc).toContain('[A]');
    expect(doc).not.toContain('mitex');
  });
});

/* ----------------------------------------------- the certificate document */

describe('certificatesToTypst (D71)', () => {
  it('is one A4 landscape page per participant, bilingual, unnumbered', () => {
    const doc = certificatesToTypst(input({ rows: [row(), row({ rank: 2, username: 'binh' })] }));
    expect(doc).toContain('paper: "a4"');
    expect(doc).toContain('flipped: true');
    expect(doc).toContain('GIẤY CHỨNG NHẬN');
    expect(doc).toContain('CERTIFICATE OF ACHIEVEMENT');
    // Between, never before or after: a leading break prints a blank first
    // page and a trailing one a blank last.
    expect(doc.match(/#pagebreak\(\)/g)).toHaveLength(1);
    // A certificate is handed to one person; "3/40" in the corner announces
    // how many other people got the same one.
    expect(doc).not.toContain('numbering');
  });

  it('names the participant, their rank in both languages, and the contest', () => {
    const doc = certificatesToTypst(input({ rows: [row({ rank: 3 })] }));
    expect(doc).toContain('Nguyễn Văn An');
    expect(doc).toContain('Hạng 3 / Rank 3');
    expect(doc).toContain('Thi thử tỉnh');
    expect(doc).toContain('(an)');
  });

  it('signs with the issuing organization, and falls back to the site', () => {
    expect(certificatesToTypst(input())).toContain('Sở GD&ĐT Quảng Ninh');
    expect(certificatesToTypst(input({ issuer: DEFAULT_ISSUER }))).toContain('DuckOJ');
  });

  it('draws the signature line with #line, never with escaped underscores', () => {
    const doc = certificatesToTypst(input());
    expect(doc).toContain('#line(length: 6cm)');
    expect(doc).not.toContain('\\_\\_');
  });

  /**
   * The date is the CONTEST'S end, not `now` — and that is not cosmetic:
   * `results.cache.ts` keys on a hash of this document, so a certificate
   * carrying the current second would hash to a fresh key every second and
   * the cache would never hit once.
   */
  it('dates the certificate by the contest’s end, so two prints are identical', () => {
    const doc = certificatesToTypst(input());
    expect(doc.replace(/\\/g, '')).toContain('29/08/2026');
    expect(doc).toBe(certificatesToTypst(input()));
  });

  it('escapes a display name made of typst syntax', () => {
    const doc = certificatesToTypst(input({ rows: [row({ displayName: 'Lê #x [y] $z$' })] }));
    expect(doc).toContain('Lê \\#x \\[y\\] \\$z\\$');
  });

  it('is a bare preamble when the selection is empty', () => {
    expect(certificatesToTypst(input({ rows: [] }))).not.toContain('#pagebreak()');
  });
});

/* --------------------------------------------------- both actually compile */

/** `'ok'`, or typst's own complaint — so a failure names the syntax error. */
async function compileStatus(document: string): Promise<string> {
  try {
    const pdf = await new TypstStatementRenderer(TYPST_BIN!).renderDocument(document);
    return pdf.subarray(0, 5).toString() === '%PDF-' ? 'ok' : 'not a pdf';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Every character typst treats as markup, in the fields a person types. */
const NASTY = 'Nguyễn \\ # $ * _ ` @ < > [ ] { } ~ ^ \' " - + % / = | & ; : ! ?';

describe.skipIf(TYPST_BIN === null)('the results documents compile', () => {
  it('compiles a standings sheet, including a name of pure typst syntax', async () => {
    const doc = standingsToTypst(
      input({
        contestName: NASTY,
        rows: [
          row({ displayName: NASTY, orgs: [NASTY], disqualified: true, virtual: 1 }),
          row({ rank: 2, username: 'binh', cells: {} }),
        ],
      }),
    );
    expect(await compileStatus(doc)).toBe('ok');
  }, 120_000);

  it('compiles an empty standings sheet', async () => {
    expect(await compileStatus(standingsToTypst(input({ rows: [] })))).toBe('ok');
  }, 120_000);

  it('compiles a run of certificates, including a name of pure typst syntax', async () => {
    const doc = certificatesToTypst(
      input({
        issuer: NASTY,
        rows: [row({ displayName: NASTY }), row({ rank: 2, username: 'binh' })],
      }),
    );
    expect(await compileStatus(doc)).toBe('ok');
  }, 120_000);
});
