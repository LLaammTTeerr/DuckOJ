/**
 * Phase F35 — printable seat slips for a contest (D129).
 *
 * Three layers, exactly as `contest-results.spec.ts` orders them: the pure
 * builder (no binary), the real typst binary when one exists, and the route —
 * where **visibility comes before capability**, so a contest the caller may
 * not see 404s and one they may see but do not run 403s, both on a server
 * that would otherwise answer 501.
 *
 * A seat slip carries **no password** (D61): the credentials a roster import
 * mints are shown once and are never re-derivable afterwards, so there is
 * nothing here for a slip to print even if it wanted to.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  contestParticipations,
  contestProblems,
  contests,
  orgMembers,
  organizations,
  problems,
  teamMembers,
  teams,
} from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { seatsToTypst, type SeatSlipsInput } from '../src/statements/seats.js';
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

const MINUTE = 60_000;

function input(over: Partial<SeatSlipsInput> = {}): SeatSlipsInput {
  return {
    contestName: 'Thi thử tỉnh',
    startTime: new Date('2026-08-29T02:00:00Z'),
    endTime: new Date('2026-08-29T07:00:00Z'),
    timeZone: null,
    siteUrl: 'https://oj.example',
    rows: [{ displayName: 'Nguyễn Văn An', username: 'an', members: [] }],
    ...over,
  };
}

/* --------------------------------------------------------- the builder */

describe('seatsToTypst (D129)', () => {
  it('prints one card per participant on A4 portrait, with dashed cut lines', () => {
    const doc = seatsToTypst(input());
    expect(doc).toContain('paper: "a4"');
    // Portrait, deliberately: the cards are a grid, not the standings' wide
    // table, and a portrait sheet is what a paper cutter is fed.
    expect(doc).not.toContain('flipped: true');
    expect(doc).toContain('dash: "dashed"');
    expect(doc).toContain('columns: (1fr, 1fr)');
  });

  it('carries the contest, the name, the account, the window, the site and a seat rule', () => {
    const doc = seatsToTypst(input());
    expect(doc).toContain('Thi thử tỉnh');
    expect(doc).toContain('Nguyễn Văn An');
    expect(doc).toContain('Tài khoản: an');
    // `escapeText` backslashes every `-`, so the dates read `2026\\-08\\-29` in
    // the SOURCE and `2026-08-29` on the page.
    expect(doc).toContain('2026\\-08\\-29 09:00');
    expect(doc).toContain('2026\\-08\\-29 14:00');
    expect(doc).toContain('GMT+7');
    expect(doc).toContain('https://oj.example');
    expect(doc).toContain('Phòng / Số báo danh');
    // The blank is a rule, never a run of underscores: `escapeText` escapes
    // `_`, so a typed blank prints backslashes across every card.
    expect(doc).toContain('#line(');
  });

  it('never prints a password — there is none to print (D61)', () => {
    const doc = seatsToTypst(input());
    expect(doc.toLowerCase()).not.toContain('mật khẩu');
    expect(doc.toLowerCase()).not.toContain('password');
  });

  it('lists a team’s members instead of one account (D99)', () => {
    const doc = seatsToTypst(
      input({ rows: [{ displayName: 'Đội 1', username: 'Đội 1', members: ['anh', 'binh'] }] }),
    );
    expect(doc).toContain('Đội 1');
    expect(doc).toContain('anh');
    expect(doc).toContain('binh');
    expect(doc).toContain('Thành viên');
    // A team row's `username` IS the team's name, so the account label would
    // say the same thing twice.
    expect(doc).not.toContain('Tài khoản');
  });

  it('cannot be given a heading by a display name that BEGINS with a marker', () => {
    const doc = seatsToTypst(
      input({ rows: [{ displayName: '= GIẢI NHẤT', username: 'an', members: [] }] }),
    );
    for (const line of doc.split('\n')) {
      expect(line.trimStart().startsWith('= ')).toBe(false);
    }
    expect(doc).toContain('\\= GIẢI NHẤT');
  });

  it('cannot be given one by a display name carrying a newline', () => {
    const doc = seatsToTypst(
      input({ rows: [{ displayName: 'An\n= GIẢI NHẤT', username: 'an', members: [] }] }),
    );
    for (const line of doc.split('\n')) {
      expect(line.trimStart().startsWith('= ')).toBe(false);
    }
  });

  it('escapes a hostile MEMBER username too', () => {
    const doc = seatsToTypst(
      input({ rows: [{ displayName: 'Đội 1', username: 'Đội 1', members: ['#read("/etc/passwd")'] }] }),
    );
    // Escaped, so typst reads it as text: the only `#read` in the document
    // is one with a backslash in front of it.
    expect(doc).not.toMatch(/(?<!\\)#read/);
    expect(doc).toContain('\\#read');
  });

  it('orders the cards by display name, so the same room prints the same sheet', () => {
    const rows = [
      { displayName: 'Cường', username: 'c', members: [] },
      { displayName: 'An', username: 'a', members: [] },
      { displayName: 'Bình', username: 'b', members: [] },
    ];
    const doc = seatsToTypst(input({ rows }));
    expect(doc.indexOf('An')).toBeLessThan(doc.indexOf('Bình'));
    expect(doc.indexOf('Bình')).toBeLessThan(doc.indexOf('Cường'));
    // Deterministic whatever order the board handed them over in: the cache
    // key is a hash of this document, and an incidental order never hits.
    expect(seatsToTypst(input({ rows: [...rows].reverse() }))).toBe(doc);
  });

  it('dates the window in the ORGANISER’s zone and derives the offset (D57/D64)', () => {
    const doc = seatsToTypst(input({ timeZone: 'Asia/Tokyo' }));
    expect(doc).toContain('2026\\-08\\-29 11:00');
    expect(doc).toContain('GMT+9');
  });

  it('falls back to Indochina Time for an unresolvable zone rather than throwing', () => {
    const doc = seatsToTypst(input({ timeZone: 'Mars/Olympus' }));
    expect(doc).toContain('2026\\-08\\-29 09:00');
    expect(doc).toContain('GMT+7');
  });

  it('prints a heading and no table for a contest nobody has entered', () => {
    const doc = seatsToTypst(input({ rows: [] }));
    expect(doc).toContain('Phiếu dự thi');
    // A trailing comma in an empty `#table(` is a document that fails to
    // compile — the standings sheet's own rule.
    expect(doc).not.toContain('#table(');
  });
});

/* ---------------------------------------------- the real binary, when present */

/** `ok`, or typst's own diagnostic — the booklet spec's own shape. */
async function compileStatus(document: string): Promise<string> {
  if (TYPST_BIN === null) return 'ok';
  try {
    await new TypstStatementRenderer(TYPST_BIN).renderDocument(document);
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe.skipIf(TYPST_BIN === null)('seat slips compile (typst)', () => {
  it('compiles a full sheet, a team card and a name of pure typst syntax', async () => {
    // The worst case on purpose: a table cell here has a FIXED height, so a
    // card that grows (a team of three, a long name) is the one that would
    // show up as a broken sheet rather than as a failed compile.
    const rows = Array.from({ length: 11 }, (_, index) => ({
      displayName: `Nguyễn Văn ${String(index)}`,
      username: `u${String(index)}`,
      members: [],
    }));
    expect(
      await compileStatus(
        seatsToTypst(
          input({
            rows: [
              ...rows,
              { displayName: '#read("/etc/hosts") = _*x*_', username: 'x', members: [] },
              { displayName: 'Đội Sao Mai', username: 'Đội Sao Mai', members: ['anh', 'binh', 'cuong'] },
            ],
          }),
        ),
      ),
    ).toBe('ok');
  }, 120_000);

  it('compiles a contest nobody has entered', async () => {
    expect(await compileStatus(seatsToTypst(input({ rows: [] })))).toBe('ok');
  }, 120_000);
});

/* --------------------------------------------------------- the route (D129) */

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

/** This file's own logical Redis database — see `redis.harness.ts`. */
const REDIS_DB = 9;

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
 * A contest that has NOT started, owned by `ownerId`, with three participations:
 * two live entrants and one virtual replay.
 *
 * Not-yet-started is the realistic case and the load-bearing one: seat slips
 * are cut up the night before, so a route that only worked on a finished
 * contest would be useless. The replay is there so the filter has something to
 * drop.
 */
async function seedSeatContest(
  db: Db,
  key: string,
  ownerId: number,
  opts: { visibility?: 'public' | 'private' } = {},
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
      startTime: new Date(now + 60 * MINUTE),
      endTime: new Date(now + 180 * MINUTE),
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
  await db
    .update(schema.users)
    .set({ displayName: 'Trần Thị Bình' })
    .where(eq(schema.users.id, binh.id));
  await db
    .update(schema.users)
    .set({ displayName: 'Lê Văn Cường' })
    .where(eq(schema.users.id, cuong.id));
  await db.insert(contestParticipations).values([
    { contestId: contest!.id, userId: an.id, virtual: 0, startTime: new Date(now + 60 * MINUTE) },
    { contestId: contest!.id, userId: binh.id, virtual: 0, startTime: new Date(now + 60 * MINUTE) },
    // The replay: on the board, and never on a desk.
    { contestId: contest!.id, userId: cuong.id, virtual: 1, startTime: new Date(now - 10 * MINUTE) },
  ]);
  return contest!.id;
}

describe('GET /contests/{key}/seats.pdf', () => {
  it('refuses an anonymous caller with 401', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        const owner = await insertUser(db, 'seat-anon-owner');
        await seedSeatContest(db, 'seat-anon', owner.id);
        const res = await request(app.getHttpServer()).get('/api/v1/contests/seat-anon/seats.pdf');
        expect(res.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('404s a contest the caller may not see, and 403s one they may but do not run', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const app = await buildApp(db, {
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'nosy');
        const owner = await insertUser(db, 'seat-owner');
        await seedSeatContest(db, 'hidden', owner.id, { visibility: 'private' });
        await seedSeatContest(db, 'seen', owner.id);

        const hidden = await agent.get('/api/v1/contests/hidden/seats.pdf').set('Cookie', cookie);
        expect(hidden.status).toBe(404);
        const seen = await agent.get('/api/v1/contests/seen/seats.pdf').set('Cookie', cookie);
        expect(seen.status).toBe(403);
        // Authorization BEFORE capability: neither refusal reached the
        // renderer, so a server with no typst cannot answer 501 to somebody
        // who was never entitled to the document.
        expect(renderer.documents).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('answers an honest 501 to the organiser when no typst is configured', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'notypst');
        const ownerId = await userIdOf(db, 'notypst');
        await seedSeatContest(db, 'no-typst', ownerId);
        const res = await agent.get('/api/v1/contests/no-typst/seats.pdf').set('Cookie', cookie);
        expect(res.status).toBe(501);
        expect(res.body.code).toBe('statement_pdf_unavailable');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('serves the organiser a card per live entrant BEFORE the contest, and caches it', async () => {
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
        await seedSeatContest(db, 'seats', ownerId);

        // One throwaway request: the store's Redis connection is lazy and
        // `enableOfflineQueue` is off, so a fresh worker's very first command
        // fails while the socket is still connecting. Whether it managed to
        // write is a race, so the database is emptied again afterwards.
        await agent.get('/api/v1/contests/seats/seats.pdf').set('Cookie', cookie);
        const redis = new Redis(redisUrl);
        try {
          await redis.flushdb();
        } finally {
          redis.disconnect();
        }

        const first = await agent.get('/api/v1/contests/seats/seats.pdf').set('Cookie', cookie);
        expect(first.status).toBe(200);
        expect(first.headers['content-type']).toContain('application/pdf');
        expect(first.headers['x-seats-cache']).toBe('miss');
        expect(first.headers['content-disposition']).toContain('seats-seats.pdf');

        const doc = renderer.documents.at(-1)!;
        expect(doc).toContain('Nguyễn Văn An');
        expect(doc).toContain('Trần Thị Bình');
        // The virtual replay has no desk in the hall.
        expect(doc).not.toContain('Lê Văn Cường');
        // The site the competitor signs in at — `PUBLIC_ORIGIN`, not a literal.
        expect(doc).toContain('http://localhost:5173');
        // A statement never reaches a seat slip, and neither does a password.
        expect(doc).not.toContain('Cho $a+b$');
        expect(doc.toLowerCase()).not.toContain('password');

        const second = await agent.get('/api/v1/contests/seats/seats.pdf').set('Cookie', cookie);
        expect(second.headers['x-seats-cache']).toBe('hit');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('prints ONE card for a team, naming every member (D99)', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const app = await buildApp(db, {
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'coach');
        const ownerId = await userIdOf(db, 'coach');
        const contestId = await seedSeatContest(db, 'team-seats', ownerId);
        await db
          .update(contests)
          .set({ participationMode: 'team' })
          .where(eq(contests.id, contestId));

        const [org] = await db
          .insert(organizations)
          .values({ slug: 'truong', name: 'THPT Chuyên Hạ Long', visibility: 'public' })
          .returning({ id: organizations.id });
        const [team] = await db
          .insert(teams)
          .values({ orgId: org!.id, slug: 'doi-1', name: 'Đội Sao Mai', createdBy: ownerId })
          .returning({ id: teams.id });
        const anId = await userIdOf(db, 'team-seats-an');
        const binhId = await userIdOf(db, 'team-seats-binh');
        await db.insert(orgMembers).values([
          { orgId: org!.id, userId: anId, role: 'member' },
          { orgId: org!.id, userId: binhId, role: 'member' },
        ]);
        await db.insert(teamMembers).values([
          { teamId: team!.id, userId: anId },
          { teamId: team!.id, userId: binhId },
        ]);
        // The two individual rows become ONE team participation: a team is
        // one participant, and therefore one card.
        await db.delete(contestParticipations).where(eq(contestParticipations.contestId, contestId));
        await db.insert(contestParticipations).values({
          contestId,
          userId: anId,
          teamId: team!.id,
          virtual: 0,
          startTime: new Date(Date.now() + 60 * MINUTE),
        });

        const res = await agent.get('/api/v1/contests/team-seats/seats.pdf').set('Cookie', cookie);
        expect(res.status).toBe(200);
        const doc = renderer.documents.at(-1)!;
        expect(doc).toContain('Đội Sao Mai');
        expect(doc).toContain('Thành viên');
        expect(doc).toContain('team\\-seats\\-an');
        expect(doc).toContain('team\\-seats\\-binh');
        // One card, not one per member.
        expect(doc.match(/#line\(length: 5cm\)/g)).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('dates the window in the ORGANISER’s own timezone (D57/D64)', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const app = await buildApp(db, {
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'tokyo');
        const ownerId = await userIdOf(db, 'tokyo');
        await seedSeatContest(db, 'zoned', ownerId);

        const ict = await agent.get('/api/v1/contests/zoned/seats.pdf').set('Cookie', cookie);
        expect(ict.status).toBe(200);
        // `users.timezone` is NULL until somebody chooses one, and D57 reads
        // that as "not chosen" — which on this judge means ICT (D18).
        expect(renderer.documents.at(-1)).toContain('GMT+7');

        await db
          .update(schema.users)
          .set({ timezone: 'Asia/Tokyo' })
          .where(eq(schema.users.id, ownerId));
        const jst = await agent.get('/api/v1/contests/zoned/seats.pdf').set('Cookie', cookie);
        expect(jst.status).toBe(200);
        // Derived from the zone at the contest's START, never a literal.
        expect(renderer.documents.at(-1)).toContain('GMT+9');
      } finally {
        await app.close();
      }
    });
  }, 180_000);

  it('escapes a hostile display name on the wire, not just in the unit test', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const app = await buildApp(db, {
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'victim');
        const ownerId = await userIdOf(db, 'victim');
        await seedSeatContest(db, 'hostile', ownerId);
        await db
          .update(schema.users)
          .set({ displayName: '= GIẢI NHẤT\n#read("/etc/hosts")' })
          .where(eq(schema.users.username, 'hostile-an'));

        const res = await agent.get('/api/v1/contests/hostile/seats.pdf').set('Cookie', cookie);
        expect(res.status).toBe(200);
        const doc = renderer.documents.at(-1)!;
        for (const line of doc.split('\n')) {
          expect(line.trimStart().startsWith('= ')).toBe(false);
        }
        expect(doc).not.toMatch(/(?<!\\)#read/);
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
