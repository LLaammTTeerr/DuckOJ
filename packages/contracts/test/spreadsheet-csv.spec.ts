/**
 * The credential sheet is bytes aimed at Excel, exactly as the results sheet
 * is (D71) — the rule was written for one export and implemented in one.
 */
import { describe, expect, it } from 'vitest';
import { credentialsCsv } from '../src/org-import-csv.js';
import { CSV_BOM, csvText } from '../src/spreadsheet-csv.js';

describe('csvText', () => {
  it("prefixes an apostrophe to every leading character a spreadsheet runs", () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvText(`${lead}cmd`).replace(/^"|"$/g, '')).toMatch(/^'/);
    }
  });

  it('leaves an ordinary name alone', () => {
    expect(csvText('Nguyễn Văn A')).toBe('Nguyễn Văn A');
  });
});

describe('credentialsCsv', () => {
  it('opens with a BOM and ends every line with CRLF', () => {
    const csv = credentialsCsv([{ username: 'hs001', displayName: 'Nguyễn Văn A', password: 'p' }]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toBe(
      `${CSV_BOM}username,displayName,password\r\nhs001,Nguyễn Văn A,p\r\n`,
    );
  });

  it('neutralises a display name the roster typed as a formula', () => {
    // The roster is a file a school uploads; the sheet is opened by the
    // teacher who ran the import. `=HYPERLINK(...)` in a display name
    // executes on their machine — the one shape CSV injection is about.
    const csv = credentialsCsv([
      { username: 'hs001', displayName: '=HYPERLINK("http://evil","A")', password: 'p' },
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""A"")"`);
  });

  it('neutralises a username that begins with a hyphen', () => {
    // D8 admits a leading hyphen, and `-1+1` is a formula to Excel.
    expect(credentialsCsv([{ username: '-hs1', displayName: 'A', password: 'p' }])).toContain(
      "'-hs1",
    );
  });

  it('still quotes a display name containing a comma', () => {
    const csv = credentialsCsv([{ username: 'u', displayName: 'Nguyễn, Văn A', password: 'p' }]);
    expect(csv).toBe(`${CSV_BOM}username,displayName,password\r\nu,"Nguyễn, Văn A",p\r\n`);
  });

  it('is one sheet with one header, however many chunks a roster was split into', () => {
    // The web panel sends a large roster as several requests and merges what
    // comes back. Concatenating the responses' files put a second header row
    // in the middle of the sheet, which Excel reads as a pupil.
    const merged = credentialsCsv([
      { username: 'a', displayName: 'A', password: '1' },
      { username: 'b', displayName: 'B', password: '2' },
    ]);
    expect(merged.split('\r\n').filter((line) => line.includes('displayName'))).toHaveLength(1);
  });
});
