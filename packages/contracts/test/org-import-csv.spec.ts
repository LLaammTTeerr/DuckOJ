/**
 * The roster file, cut into requests (D61 amended).
 *
 * The server reads each chunk on its own, so the split has to preserve two
 * things the naive `text.split('\n')` destroys: a record that contains a
 * newline inside quotes, and the header the file declared its columns with.
 */
import { describe, expect, it } from 'vitest';
import { importUsernames, parseCsvRecords, splitImportCsv } from '../src/org-import-csv.js';

describe('splitImportCsv', () => {
  it('carries the header into every chunk, so chunk two is not read as one', () => {
    const csv = 'username,name\nhs1,A\nhs2,B\nhs3,C\n';
    const chunks = splitImportCsv(csv, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('username,name\nhs1,A\nhs2,B\n');
    // Without the repeated header the server would take `hs3` for a header —
    // it names no known column, so it would be read as data positionally,
    // which is right only by luck and wrong the moment the file's columns
    // are in another order.
    expect(chunks[1]).toBe('username,name\nhs3,C\n');
  });

  it('adds no header to a file that has none', () => {
    expect(splitImportCsv('hs1,A\nhs2,B\n', 1)).toEqual(['hs1,A\n', 'hs2,B\n']);
  });

  it('never cuts inside a quoted field', () => {
    const csv = 'hs1,"Nguyễn Văn A\nlớp 9A"\nhs2,B\n';
    const chunks = splitImportCsv(csv, 1);
    expect(chunks).toHaveLength(2);
    // Round-trips: the re-serialised chunk parses back to the same record.
    expect(parseCsvRecords(chunks[0]!)).toEqual([['hs1', 'Nguyễn Văn A\nlớp 9A']]);
  });

  it('is empty for an empty file, and for a header with no rows under it', () => {
    expect(splitImportCsv('', 500)).toEqual([]);
    expect(splitImportCsv('username,name\n', 500)).toEqual([]);
  });
});

describe('importUsernames', () => {
  it('reads the username column the header names, not the first one', () => {
    expect(importUsernames('name,username\nA,hs1\nB,hs2\n')).toEqual(['hs1', 'hs2']);
  });

  it('reads a headerless file positionally', () => {
    expect(importUsernames('hs1,A\nhs2,B\n')).toEqual(['hs1', 'hs2']);
  });
});
