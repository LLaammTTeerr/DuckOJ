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
import request from 'supertest';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  contestOrgs,
  contestParticipations,
  contestProblems,
  contests,
  orgMembers,
  organizations,
  problems,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import {
  DEFAULT_ISSUER,
  certificatesToTypst,
  standingsToTypst,
  type ResultRow,
  type ResultsInput,
} from '../src/statements/results.js';
import { CSV_BOM, resultsCsv } from '../src/contests/results-csv.js';
import {
  STATEMENT_RENDERER,
  TypstStatementRenderer,
  type StatementRenderer,
} from '../src/statements/statement-renderer.js';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { ensureRedisUrl } from './redis.harness.js';
import { insertUser, registerAndLogin, userIdOf } from './submissions.fixtures.js';

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

/* --------------------------------------------------------- the routes (D71) */

/** A renderer that records every document it is handed and returns a stub PDF. */
function fakeRenderer(): StatementRenderer & { documents: string[] } {
  const documents: string[] = [];
  return {
    documents,
    render: () => Promise.reject(new Error('unused')),
    renderDocument: (document: string) => {
      documents.push(document);
      return Promise.resolve(Buffer.from('%PDF-fake'));
    },
  };
}

const MINUTE = 60_000;

/** This file's own logical Redis database — see `redis.harness.ts`. */
const REDIS_DB = 4;

async function freshRedis(): Promise<string> {
  const url = await ensureRedisUrl(REDIS_DB);
  const redis = new Redis(url);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
  return url;
}

/**
 * A finished, public `icpc` contest owned by `ownerId`, with one problem and
 * three ranked rows: a clean live entrant who belongs to a school, a
 * disqualified live entrant, and a virtual replay.
 *
 * That triple is the whole point of the fixture: the CSV must carry all
 * three, and the certificates must carry only the first.
 */
async function seedResultsContest(
  db: Db,
  key: string,
  ownerId: number,
  opts: { visibility?: 'public' | 'private'; withOrg?: boolean } = {},
): Promise<number> {
  const now = Date.now();
  const [problem] = await db
    .insert(problems)
    .values({
      code: `${key}-a`,
      name: 'Tổng hai số',
      statement: 'Cho $a+b$.',
      visibility: 'public',
      createdBy: ownerId,
    })
    .returning({ id: problems.id });
  const [contest] = await db
    .insert(contests)
    .values({
      key,
      name: 'Thi thử tỉnh',
      startTime: new Date(now - 120 * MINUTE),
      endTime: new Date(now - 60 * MINUTE),
      format: 'icpc',
      visibility: opts.visibility ?? 'public',
      createdBy: ownerId,
    })
    .returning({ id: contests.id });
  await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: problem!.id, label: 'A', points: 100, order: 0 });

  const an = await insertUser(db, `${key}-an`);
  const binh = await insertUser(db, `${key}-binh`);
  const cuong = await insertUser(db, `${key}-cuong`);
  await db
    .update(schema.users)
    .set({ displayName: 'Nguyễn Văn An' })
    .where(eq(schema.users.id, an.id));
  await db.insert(contestParticipations).values([
    { contestId: contest!.id, userId: an.id, virtual: 0, startTime: new Date(now - 110 * MINUTE) },
    {
      contestId: contest!.id,
      userId: binh.id,
      virtual: 0,
      startTime: new Date(now - 110 * MINUTE),
      isDisqualified: true,
    },
    {
      contestId: contest!.id,
      userId: cuong.id,
      virtual: 1,
      startTime: new Date(now - 90 * MINUTE),
    },
  ]);

  if (opts.withOrg === true) {
    const [org] = await db
      .insert(organizations)
      .values({ slug: `${key}-truong`, name: 'THPT Chuyên Hạ Long', visibility: 'public' })
      .returning({ id: organizations.id });
    await db.insert(orgMembers).values({ orgId: org!.id, userId: an.id, role: 'member' });
    await db.insert(contestOrgs).values({ contestId: contest!.id, orgId: org!.id });
  }
  return contest!.id;
}

describe('GET /contests/{key}/results.csv', () => {
  it('refuses an anonymous caller with 401', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'anon-owner');
        await seedResultsContest(db, 'anon', owner.id);
        // Deny-by-default: the export is the live board, so there is no
        // anonymous reading of it for a service to gate. Two things enforce
        // that and this pins the OUTCOME rather than either mechanism — the
        // absent `@Public()` marker, and `@CurrentActor()`, which throws 401
        // rather than hand a handler `null` (it "still fails closed on a
        // route the guard does not protect", by its own doc comment). Adding
        // `@Public()` to this route therefore does not make it anonymous;
        // it would have to change the decorator too, and that does not
        // typecheck.
        const res = await request(app.getHttpServer()).get('/contests/anon/results.csv');
        expect(res.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('404s a contest the caller may not see, and 403s one they may but do not run', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'nosy');
        const owner = await insertUser(db, 'gate-owner');
        await seedResultsContest(db, 'hidden', owner.id, { visibility: 'private' });
        await seedResultsContest(db, 'shown', owner.id);

        // Existence is the thing being protected, so 404.
        const hidden = await agent.get('/contests/hidden/results.csv').set('Cookie', cookie);
        expect(hidden.status).toBe(404);
        expect(hidden.body.code).toBe('contest_not_found');

        // Here there is no existence left to protect — the caller is looking
        // at the contest — so the honest answer is 403.
        const shown = await agent.get('/contests/shown/results.csv').set('Cookie', cookie);
        expect(shown.status).toBe(403);
        expect(shown.body.code).toBe('contest_forbidden');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('serves the creator a BOM-led attachment with every row, DQ flagged', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'organiser');
        const ownerId = await userIdOf(db, 'organiser');
        await seedResultsContest(db, 'final', ownerId, { withOrg: true });

        const res = await agent.get('/contests/final/results.csv').set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/csv');
        expect(res.headers['content-disposition']).toBe('attachment; filename="final-results.csv"');
        const csv = res.text;
        expect(csv.startsWith('﻿')).toBe(true);
        // The display name and the competitor's own school, neither of which
        // the scoreboard response carries.
        expect(csv).toContain('Nguyễn Văn An');
        expect(csv).toContain('THPT Chuyên Hạ Long');
        // All three rows are present, and the disqualified one is FLAGGED
        // rather than dropped.
        expect(csv).toContain('final-binh');
        expect(csv).toMatch(/final-binh.*,true,0/);
        expect(csv).toMatch(/final-cuong.*,false,1/);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('serves a global admin who did not create the contest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'root');
        await db
          .update(schema.users)
          .set({ globalRole: 'admin' })
          .where(eq(schema.users.username, 'root'));
        const owner = await insertUser(db, 'someone-else');
        await seedResultsContest(db, 'admin-sees', owner.id);
        const res = await agent.get('/contests/admin-sees/results.csv').set('Cookie', cookie);
        expect(res.status).toBe(200);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  /**
   * The CSV needs no typesetter, and a server without one must still serve
   * it. Routing all three exports through one handler would have made this
   * answer 501 for a file that is a string.
   */
  it('is served on a server with no typst configured, where the PDFs are not', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'no-typst');
        const ownerId = await userIdOf(db, 'no-typst');
        await seedResultsContest(db, 'binless', ownerId);
        const csv = await agent.get('/contests/binless/results.csv').set('Cookie', cookie);
        expect(csv.status).toBe(200);
        const pdf = await agent.get('/contests/binless/results.pdf').set('Cookie', cookie);
        expect(pdf.status).toBe(501);
        expect(pdf.body.code).toBe('statement_pdf_unavailable');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('GET /contests/{key}/results.pdf', () => {
  it('403s before the renderer is asked, so 501 never leaks entitlement', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const app = await buildApp(db, {
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'bystander');
        const owner = await insertUser(db, 'pdf-owner');
        await seedResultsContest(db, 'standings', owner.id);
        const res = await agent.get('/contests/standings/results.pdf').set('Cookie', cookie);
        expect(res.status).toBe(403);
        // Authorization BEFORE capability: the renderer was never reached.
        expect(renderer.documents).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('renders the standings and caches them for a minute', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const redisUrl = await freshRedis();
      const app = await buildApp(db, {
        configOverrides: { redisUrl },
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'printer');
        const ownerId = await userIdOf(db, 'printer');
        await seedResultsContest(db, 'printed', ownerId, { withOrg: true });

        // One throwaway request: the store's Redis connection is lazy and
        // `enableOfflineQueue` is off, so the very first command a fresh
        // worker sends fails while the socket is still connecting — the
        // designed behaviour, and not what this test is about. Whether that
        // first request managed to WRITE its entry is a race, so the
        // database is emptied again afterwards: the assertions below are
        // about the cache, not about how fast a socket opened.
        await agent.get('/contests/printed/results.pdf').set('Cookie', cookie);
        const redis = new Redis(redisUrl);
        try {
          await redis.flushdb();
        } finally {
          redis.disconnect();
        }

        const first = await agent.get('/contests/printed/results.pdf').set('Cookie', cookie);
        expect(first.status).toBe(200);
        expect(first.headers['content-type']).toContain('application/pdf');
        expect(first.headers['x-results-cache']).toBe('miss');
        expect(renderer.documents.at(-1)).toContain('Nguyễn Văn An');
        expect(renderer.documents.at(-1)).toContain('flipped: true');
        // A statement never reaches a standings sheet (D62 by construction).
        expect(renderer.documents.at(-1)).not.toContain('Cho $a+b$');

        const second = await agent.get('/contests/printed/results.pdf').set('Cookie', cookie);
        expect(second.headers['x-results-cache']).toBe('hit');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});

describe('GET /contests/{key}/certificates.pdf', () => {
  it('refuses a request that names no scope, or names both', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'certs-owner');
        const ownerId = await userIdOf(db, 'certs-owner');
        await seedResultsContest(db, 'certs', ownerId);
        const none = await agent.get('/contests/certs/certificates.pdf').set('Cookie', cookie);
        expect(none.status).toBe(422);
        const both = await agent
          .get('/contests/certs/certificates.pdf?top=1&username=certs-an')
          .set('Cookie', cookie);
        expect(both.status).toBe(422);
        // The bounds, on the path an organiser's typo actually takes: a
        // `top` outside 1..1000, or one that is not a whole number at all,
        // must be a validation refusal and never a 500 out of `z.coerce`
        // (which turns `abc` into `NaN` and hands it to `.int()`).
        for (const bad of ['top=0', 'top=1001', 'top=abc', 'top=1.5', 'top=-3']) {
          const res = await agent
            .get(`/contests/certs/certificates.pdf?${bad}`)
            .set('Cookie', cookie);
          expect(res.status, bad).toBe(422);
        }
        // And the edges of the range are accepted — a cap that refused its
        // own boundary would be a cap of 999.
        const edge = await agent
          .get('/contests/certs/certificates.pdf?top=1000')
          .set('Cookie', cookie);
        expect(edge.status).toBe(501);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('prints the top N, excluding the disqualified and the virtual', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const app = await buildApp(db, {
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'awarder');
        const ownerId = await userIdOf(db, 'awarder');
        await seedResultsContest(db, 'awards', ownerId, { withOrg: true });

        const res = await agent
          .get('/contests/awards/certificates.pdf?top=10')
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        // Read through the escaping: `escapeText` escapes `-`, so a
        // username written literally into this assertion would never match
        // the document even when the row IS in it — the assertion would
        // pass for the wrong reason.
        const doc = renderer.documents.at(-1)!.replace(/\\/g, '');
        expect(doc).toContain('GIẤY CHỨNG NHẬN');
        expect(doc).toContain('Nguyễn Văn An');
        // A certificate is an award, not a record: neither the expelled
        // competitor nor the virtual replay gets one, even at `top=10`.
        expect(doc).toContain('(awards-an)');
        expect(doc).not.toContain('awards-binh');
        expect(doc).not.toContain('awards-cuong');
        // Signed by the contest's own organization (D56).
        expect(doc).toContain('THPT Chuyên Hạ Long');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('falls back to the site as issuer when the contest names no organization', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const app = await buildApp(db, {
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'unaffiliated');
        const ownerId = await userIdOf(db, 'unaffiliated');
        await seedResultsContest(db, 'nobrand', ownerId);
        const res = await agent
          .get('/contests/nobrand/certificates.pdf?top=1')
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(renderer.documents.at(-1)).toContain('DuckOJ');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('prints one named competitor, and 404s one with no certifiable result', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const app = await buildApp(db, {
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'namer');
        const ownerId = await userIdOf(db, 'namer');
        await seedResultsContest(db, 'byname', ownerId);

        const one = await agent
          .get('/contests/byname/certificates.pdf?username=BYNAME-AN')
          .set('Cookie', cookie);
        expect(one.status).toBe(200);
        // Case-insensitive, as every username lookup in this codebase is.
        expect(renderer.documents.at(-1)).toContain('Nguyễn Văn An');
        expect(renderer.documents.at(-1)!.match(/#pagebreak\(\)/g)).toBeNull();

        // Disqualified: not certifiable, and the refusal does not say which
        // of the three reasons applied.
        const dq = await agent
          .get('/contests/byname/certificates.pdf?username=byname-binh')
          .set('Cookie', cookie);
        expect(dq.status).toBe(404);
        expect(dq.body.code).toBe('contest_participant_not_found');

        const missing = await agent
          .get('/contests/byname/certificates.pdf?username=nobody')
          .set('Cookie', cookie);
        expect(missing.status).toBe(404);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
