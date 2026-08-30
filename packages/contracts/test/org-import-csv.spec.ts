/**
 * The roster file, cut into requests (D61 amended).
 *
 * The server reads each chunk on its own, so the split has to preserve two
 * things the naive `text.split('\n')` destroys: a record that contains a
 * newline inside quotes, and the header the file declared its columns with.
 */
import { describe, expect, it } from 'vitest';
import {
  importHeaderColumns,
  importIdentities,
  importUsernames,
  parseCsvRecords,
  splitImportCsv,
} from '../src/org-import-csv.js';

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

  it('declares the positional columns for a file that has none', () => {
    // A headerless chunk is read by DETECTION, and detection is per-request:
    // whatever record happens to land first in chunk two decides that
    // chunk's columns. Every chunk therefore states the reading the whole
    // file was split under.
    expect(splitImportCsv('hs1,A\nhs2,B\n', 1)).toEqual([
      'username,displayName,email\nhs1,A\n',
      'username,displayName,email\nhs2,B\n',
    ]);
  });

  it('loses no pupil when a headerless chunk starts on a row that looks like a header', () => {
    // `user` is a perfectly valid username (D8: 3–32 characters) and is also
    // one of the header aliases. Split headerless, that pupil begins chunk
    // two, the server reads their row as the chunk's header — and the sheet
    // the teacher prints is one account short of the class, with a 201 and
    // no warning anywhere.
    const csv = 'hs1,A\nhs2,B\nuser,C\nhs4,D\n';
    const rows = splitImportCsv(csv, 2).flatMap((chunk) => {
      const records = parseCsvRecords(chunk);
      const declared = importHeaderColumns(records[0]!);
      return declared === null ? records : records.slice(1);
    });
    expect(rows.map((record) => record[0])).toEqual(['hs1', 'hs2', 'user', 'hs4']);
  });

  it('never cuts inside a quoted field', () => {
    const csv = 'hs1,"Nguyễn Văn A\nlớp 9A"\nhs2,B\n';
    const chunks = splitImportCsv(csv, 1);
    expect(chunks).toHaveLength(2);
    // Round-trips: the re-serialised chunk parses back to the same record.
    expect(parseCsvRecords(chunks[0]!)).toEqual([
      ['username', 'displayName', 'email'],
      ['hs1', 'Nguyễn Văn A\nlớp 9A'],
    ]);
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

describe('importIdentities', () => {
  it('reads both identity columns by the names the header gives them', () => {
    expect(importIdentities('email,name,username\na@x.vn,A,hs1\nb@x.vn,B,hs2\n')).toEqual([
      { username: 'hs1', email: 'a@x.vn' },
      { username: 'hs2', email: 'b@x.vn' },
    ]);
  });

  it('reads a headerless file positionally, as username,displayName,email', () => {
    expect(importIdentities('hs1,A,a@x.vn\nhs2,B,b@x.vn\n')).toEqual([
      { username: 'hs1', email: 'a@x.vn' },
      { username: 'hs2', email: 'b@x.vn' },
    ]);
  });

  it('gives an empty address to a file with no email column, and to a row that omits one', () => {
    // The server invents `<username>@<slug>.import.invalid` for these (D61),
    // which can only collide when the username already has — so the caller
    // must be able to tell "no address" from "this address" and skip it.
    expect(importIdentities('username,displayName\nhs1,A\n')).toEqual([
      { username: 'hs1', email: '' },
    ]);
    expect(importIdentities('username,displayName,email\nhs1,A,\n')).toEqual([
      { username: 'hs1', email: '' },
    ]);
  });
});
