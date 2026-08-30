/**
 * Phase F6 — the contest PDF booklet (D48).
 *
 * Three layers, exactly as `statement-pdf.spec.ts` tests the single-problem
 * PDF: the pure lowering (every branch, no binary), the real typst binary
 * when one exists, and the route — where **visibility comes before
 * capability**, so a contest the caller may not see (and one that has not
 * started) 404s on a server that answers 501 for everything else.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { contestProblems, contests, problemRevisions, problems } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { ensureRedisUrl } from './redis.harness.js';
import { insertUser, registerAndLogin } from './submissions.fixtures.js';
import { STATEMENT_RENDERER, type StatementRenderer } from '../src/statements/statement-renderer.js';
import {
  bookletToTypst,
  statementSection,
  type BookletProblem,
} from '../src/statements/markdown-to-typst.js';
import { TypstStatementRenderer } from '../src/statements/statement-renderer.js';

const TYPST_BIN =
  process.env.TYPST_BIN ??
  (existsSync(join(homedir(), '.local/bin/typst')) ? join(homedir(), '.local/bin/typst') : null);

const BILINGUAL = [
  '# Tổng hai số',
  '',
  'Cho hai số nguyên $a$ và $b$.',
  '',
  '---',
  '',
  '## English',
  '',
  'Given two integers $a$ and $b$.',
].join('\n');

function problem(over: Partial<BookletProblem> = {}): BookletProblem {
  return {
    label: 'A',
    name: 'Tổng hai số',
    statement: 'Cho $a + b$.',
    timeMs: 1000,
    memoryKb: 262_144,
    ...over,
  };
}

const WINDOW = { startTime: new Date('2026-08-29T02:00:00Z'), endTime: new Date('2026-08-29T07:00:00Z') };

describe('statementSection (D48)', () => {
  it('splits a bilingual statement on the top-level English heading', () => {
    expect(statementSection(BILINGUAL, 'vi')).toContain('Cho hai số nguyên');
    expect(statementSection(BILINGUAL, 'vi')).not.toContain('Given two integers');
    expect(statementSection(BILINGUAL, 'en')).toContain('Given two integers');
    expect(statementSection(BILINGUAL, 'en')).not.toContain('Cho hai số nguyên');
  });

  it('drops the thematic break the corpus puts before the heading', () => {
    // `escapeText` escapes `-`, so a surviving rule prints as literal dashes
    // at the foot of every Vietnamese booklet page.
    expect(statementSection(BILINGUAL, 'vi').trimEnd().endsWith('---')).toBe(false);
    expect(statementSection(BILINGUAL, 'vi')).not.toContain('---');
  });

  it('falls back to the whole text when no marker is present', () => {
    const plain = '# Bài\n\nchỉ tiếng Việt';
    expect(statementSection(plain, 'vi')).toContain('chỉ tiếng Việt');
    expect(statementSection(plain, 'en')).toContain('chỉ tiếng Việt');
  });

  it('splits the other way round when the marker names Vietnamese', () => {
    const enFirst = ['English text.', '', '## Tiếng Việt', '', 'Chữ tiếng Việt.'].join('\n');
    expect(statementSection(enFirst, 'en')).toContain('English text.');
    expect(statementSection(enFirst, 'en')).not.toContain('Chữ tiếng Việt');
    expect(statementSection(enFirst, 'vi')).toContain('Chữ tiếng Việt.');
  });

  it('ignores a heading inside a fenced block', () => {
    const fenced = ['vi text', '```', '## English', '```', 'more vi'].join('\n');
    expect(statementSection(fenced, 'vi')).toContain('more vi');
    expect(statementSection(fenced, 'en')).toContain('more vi');
  });
});

describe('bookletToTypst (D48)', () => {
  it('covers the contest, its window and a limits table, then one problem per page', () => {
    const doc = bookletToTypst({
      name: 'Thi thử tỉnh',
      ...WINDOW,
      lang: 'vi',
      problems: [problem(), problem({ label: 'B', name: 'Sàng', statement: 'Đếm số nguyên tố.' })],
    });
    expect(doc).toContain('Thi thử tỉnh');
    // Asia/Ho_Chi_Minh, stated on the page — a booklet printed for a room
    // in Vietnam must not be dated in UTC. Read through the escaping: a
    // date's `-` is escaped like every other hyphen, because typst turns a
    // bare `--` into an en dash.
    const unescaped = doc.replace(/\\/g, '');
    expect(unescaped).toContain('2026-08-29 09:00');
    expect(unescaped).toContain('2026-08-29 14:00');
    expect(doc).toContain('GMT+7');
    expect(doc).toContain('#table(');
    expect(doc).toContain('1000 ms');
    // Page numbering, and a break between every problem — but not one
    // trailing the last.
    expect(doc).toContain('numbering: "1"');
    expect(doc.match(/#pagebreak\(\)/g)).toHaveLength(2);
    // The break goes BEFORE each problem, so the booklet never ends on a
    // blank page.
    expect(doc).toContain('#pagebreak()\n= Bài A.');
    expect(doc.trimEnd().endsWith('#pagebreak()')).toBe(false);
    expect(doc).toContain('= Bài A. Tổng hai số');
    expect(doc).toContain('= Bài B. Sàng');
  });

  it('says "Problem" in English and picks the English heading word', () => {
    const doc = bookletToTypst({ name: 'Provincial mock', ...WINDOW, lang: 'en', problems: [problem()] });
    expect(doc).toContain('= Problem A. Tổng hai số');
    expect(doc).not.toContain('= Bài A.');
  });

  it('hoists the mitex import exactly once, and only when some statement has math', () => {
    const withMath = bookletToTypst({
      name: 'C',
      ...WINDOW,
      lang: 'vi',
      problems: [problem({ statement: 'no math' }), problem({ label: 'B', statement: 'so $x^2$' })],
    });
    expect(withMath.match(/@preview\/mitex/g)).toHaveLength(1);
    expect(withMath.startsWith('#import')).toBe(true);
    const mathless = bookletToTypst({
      name: 'C',
      ...WINDOW,
      lang: 'vi',
      problems: [problem({ statement: 'no math at all' })],
    });
    expect(mathless).not.toContain('mitex');
  });

  it('escapes the contest name and prints a dash for a missing limit', () => {
    const doc = bookletToTypst({
      name: 'A #1 contest',
      ...WINDOW,
      lang: 'vi',
      problems: [problem({ timeMs: null, memoryKb: null })],
    });
    expect(doc).toContain('A \\#1 contest');
    expect(doc).not.toContain('1000 ms');
  });

  it('renders a contest with no problems without a stray page break', () => {
    const doc = bookletToTypst({ name: 'Empty', ...WINDOW, lang: 'vi', problems: [] });
    expect(doc).not.toContain('#pagebreak()');
    expect(doc).toContain('Empty');
  });
});

describe.skipIf(TYPST_BIN === null)('the booklet document actually compiles', () => {
  it('compiles a two-problem bilingual booklet to a real PDF', async () => {
    const doc = bookletToTypst({
      name: 'Thi thử tỉnh',
      ...WINDOW,
      lang: 'vi',
      problems: [
        problem({ statement: statementSection(BILINGUAL, 'vi') }),
        problem({ label: 'B', name: 'Sàng', statement: '## Dữ liệu vào\n\n$N \\le 10^7$\n\n```\nraw #block\n```' }),
      ],
    });
    const pdf = await new TypstStatementRenderer(TYPST_BIN!).renderDocument(doc);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  }, 120_000);
});

/* ------------------------------------------------------- the route (D48) */

const MINUTE = 60_000;

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

async function seedContest(
  db: Db,
  opts: {
    key: string;
    visibility: 'public' | 'private';
    startsInMs: number;
    ownerName?: string;
    statement?: string;
  },
): Promise<{ ownerId: number; problemId: number }> {
  const owner = opts.ownerName
    ? await userIdByUsername(db, opts.ownerName)
    : (await insertUser(db, `owner-${opts.key}`, 'admin')).id;
  const [problem] = await db
    .insert(problems)
    .values({
      code: `p-${opts.key}`,
      name: 'Tổng hai số',
      statement: opts.statement ?? BILINGUAL,
      visibility: 'public',
      createdBy: owner,
    })
    .returning();
  const hash = `hash-${opts.key}`;
  await db.insert(schema.packages).values({ hash, sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: hash,
      state: 'published',
      createdBy: owner,
      timeMs: 1000,
      memoryKb: 262_144,
      testCount: 5,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning();
  await db.update(problems).set({ currentRevisionId: revision!.id }).where(eq(problems.id, problem!.id));
  const [contest] = await db
    .insert(contests)
    .values({
      key: opts.key,
      name: 'Thi thử tỉnh',
      startTime: new Date(Date.now() + opts.startsInMs),
      endTime: new Date(Date.now() + opts.startsInMs + 300 * MINUTE),
      format: 'icpc',
      visibility: opts.visibility,
      createdBy: owner,
    })
    .returning({ id: contests.id });
  await db
    .insert(contestProblems)
    .values({ contestId: contest!.id, problemId: problem!.id, label: 'A', points: 100, order: 0 });
  return { ownerId: owner, problemId: problem!.id };
}

async function userIdByUsername(db: Db, username: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  return row!.id;
}

/** A live Redis, emptied first — see `contest-scoreboard-cache.spec.ts`. */
async function freshRedis(): Promise<string> {
  const url = await ensureRedisUrl();
  const redis = new Redis(url);
  try {
    await redis.flushall();
  } finally {
    redis.disconnect();
  }
  return url;
}

describe('GET /contests/{key}/booklet.pdf', () => {
  it('404s a contest the caller may not see BEFORE revealing whether PDFs are configured', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedContest(db, { key: 'hidden', visibility: 'private', startsInMs: -MINUTE });
        const res = await request(app.getHttpServer()).get('/contests/hidden/booklet.pdf');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('contest_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('404s before the start for everyone but the people who run the contest', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      const agent = request.agent(app.getHttpServer());
      try {
        const cookie = await registerAndLogin(agent, 'runner');
        await seedContest(db, {
          key: 'later',
          visibility: 'public',
          startsInMs: 30 * MINUTE,
          ownerName: 'runner',
        });
        // Concealed pre-start, exactly as the contest's problem LIST is —
        // and 404, not the scoreboard's 409: "starts later" is itself the
        // fact being withheld.
        const anon = await request(app.getHttpServer()).get('/contests/later/booklet.pdf');
        expect(anon.status).toBe(404);
        // Its creator gets as far as the renderer, which this server has none of.
        const owner = await agent.get('/contests/later/booklet.pdf').set('Cookie', cookie);
        expect(owner.status).toBe(501);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('answers an honest 501 for a visible, started contest when no typst is configured', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedContest(db, { key: 'open', visibility: 'public', startsInMs: -MINUTE });
        const res = await request(app.getHttpServer()).get('/contests/open/booklet.pdf');
        expect(res.status).toBe(501);
        expect(res.body.code).toBe('statement_pdf_unavailable');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('refuses an unknown ?lang=', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedContest(db, { key: 'langs', visibility: 'public', startsInMs: -MINUTE });
        const res = await request(app.getHttpServer()).get('/contests/langs/booklet.pdf?lang=fr');
        expect(res.status).toBe(422);
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('picks the language section, caches for a minute, and rehashes when a statement changes', async () => {
    await withTestDb(async (db) => {
      const renderer = fakeRenderer();
      const spy = vi.spyOn(renderer, 'renderDocument');
      const app = await buildApp(db, {
        configOverrides: { redisUrl: await freshRedis() },
        overrides: [{ provide: STATEMENT_RENDERER, useValue: renderer }],
      });
      try {
        await seedContest(db, { key: 'cached', visibility: 'public', startsInMs: -MINUTE });

        // One throwaway request first. The store's Redis connection is lazy
        // and `enableOfflineQueue` is off, so the very first command a fresh
        // worker sends fails while the socket is still connecting — the
        // store reports it and answers as if the key were absent, which is
        // the designed behaviour and not what this test is about. A real
        // render takes long enough that the connection is up by the time the
        // entry is written; a stub that resolves in the same tick is not.
        await request(app.getHttpServer()).get('/contests/cached/booklet.pdf');

        const first = await request(app.getHttpServer()).get('/contests/cached/booklet.pdf');
        expect(first.status).toBe(200);
        expect(first.headers['content-type']).toContain('application/pdf');
        expect(first.headers['x-booklet-cache']).toBe('miss');
        expect(renderer.documents[0]).toContain('Cho hai số nguyên');
        expect(renderer.documents[0]).not.toContain('Given two integers');

        const second = await request(app.getHttpServer()).get('/contests/cached/booklet.pdf');
        expect(second.headers['x-booklet-cache']).toBe('hit');
        expect(spy).toHaveBeenCalledTimes(2);

        // A different language is a different key, never the cached booklet.
        const english = await request(app.getHttpServer()).get('/contests/cached/booklet.pdf?lang=en');
        expect(english.headers['x-booklet-cache']).toBe('miss');
        expect(renderer.documents.at(-1)).toContain('Given two integers');
        expect(renderer.documents.at(-1)).not.toContain('Cho hai số nguyên');

        // The key is the hash of the document, not the revision set: a
        // statement lives on `problems`, so an edit changes no revision id
        // and would otherwise have gone on serving the stale PDF for a minute.
        await db
          .update(problems)
          .set({ statement: 'Đề bài đã sửa.' })
          .where(eq(problems.code, 'p-cached'));
        const edited = await request(app.getHttpServer()).get('/contests/cached/booklet.pdf');
        expect(edited.headers['x-booklet-cache']).toBe('miss');
        expect(renderer.documents.at(-1)).toContain('Đề bài đã sửa');
      } finally {
        await app.close();
      }
    });
  }, 180_000);
});
