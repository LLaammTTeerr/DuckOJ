/**
 * Phase 7b — statement PDFs.
 *
 * Three layers, tested at three depths:
 *  1. the pure Markdown → Typst lowering (every branch, no binary);
 *  2. the real typst binary, when one exists on this machine (`TYPST_BIN`
 *     or ~/.local/bin/typst) — skipped in CI, which has none: what CI
 *     gates is the lowering, what the binary run proves locally is that
 *     the lowering's output actually compiles;
 *  3. the route: **visibility before capability** — a hidden problem 404s
 *     even on a server that answers 501 for everything else, or the PDF
 *     route becomes an existence oracle the JSON route is not.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { problemRevisions, problems } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import { buildApp } from './app.harness.js';
import { withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';
import { markdownToTypst } from '../src/statements/markdown-to-typst.js';
import { TypstStatementRenderer } from '../src/statements/statement-renderer.js';

const TYPST_BIN =
  process.env.TYPST_BIN ??
  (existsSync(join(homedir(), '.local/bin/typst')) ? join(homedir(), '.local/bin/typst') : null);

const STATEMENT = [
  '# Input',
  'Two integers $a$ and $b$ with $\\frac{a}{b} \\le 10^9$.',
  '',
  'Text with typst markup: #set, *stars*, @refs and [brackets].',
  '',
  '- a **bold** item',
  '- `inline code`',
  '',
  '```',
  'raw #block $stays$ verbatim',
  '```',
].join('\n');

async function seedProblem(
  db: Db,
  opts: { code: string; visibility: 'public' | 'private'; statement?: string },
): Promise<void> {
  const user = await insertUser(db, `owner-${opts.code}`, 'admin');
  const [problem] = await db
    .insert(problems)
    .values({
      code: opts.code,
      name: 'A plus B',
      statement: opts.statement ?? STATEMENT,
      visibility: opts.visibility,
      createdBy: user.id,
    })
    .returning();
  const hash = `hash-${opts.code}`;
  await db.insert(schema.packages).values({ hash, sizeBytes: 1, fileCount: 1 });
  const [revision] = await db
    .insert(problemRevisions)
    .values({
      problemId: problem!.id,
      version: 1,
      packageHash: hash,
      state: 'published',
      createdBy: user.id,
      timeMs: 1000,
      memoryKb: 256_000,
      testCount: 5,
      totalPoints: 100,
      checkerKind: 'wcmp',
    })
    .returning();
  await db
    .update(problems)
    .set({ currentRevisionId: revision!.id })
    .where(eq(problems.id, problem!.id));
}

describe('markdownToTypst', () => {
  it('escapes typst markup in plain text', () => {
    const doc = markdownToTypst('P', 'a #set and *stars* outside emphasis? no: 2\\*3');
    expect(doc).toContain('\\#set');
    expect(doc).toContain('2\\\\\\*3');
    // The "*stars*" was valid Markdown emphasis, so it became typst
    // emphasis — as a function call, never a bare `_..._` delimiter, whose
    // meaning in typst depends on the characters flanking it.
    expect(doc).toContain('#emph[stars]');
  });

  it('lowers headings, lists, bold, code and links', () => {
    const doc = markdownToTypst('P', '# In\n- **x**\n1. `y`\n[t](https://e.x)');
    expect(doc).toContain('== In');
    expect(doc).toContain('- #strong[x]');
    expect(doc).toContain('+ `y`');
    expect(doc).toContain('#link("https://e.x")[t]');
  });

  it('routes math through mitex, and imports mitex only when math exists', () => {
    const withMath = markdownToTypst('P', 'so $\\frac{a}{b}$');
    expect(withMath).toContain('#mi(`\\frac{a}{b}`)');
    expect(withMath).toContain('@preview/mitex');
    // A mathless statement must not touch the network for a package.
    expect(markdownToTypst('P', 'no math here')).not.toContain('mitex');
  });

  it('keeps fenced blocks verbatim — including an unterminated one', () => {
    const doc = markdownToTypst('P', '```\n#raw $x$ *y*\n```');
    expect(doc).toContain('#raw $x$ *y*');
    expect(doc).not.toContain('\\#raw');
    expect(markdownToTypst('P', '```\nlost?')).toContain('lost?');
  });

  it('titles the document with the problem name, escaped', () => {
    expect(markdownToTypst('A #1 problem', 'x')).toContain('= A \\#1 problem');
  });
});

describe.skipIf(TYPST_BIN === null)('TypstStatementRenderer (real binary)', () => {
  it('compiles the full nasty statement to a real PDF', async () => {
    const renderer = new TypstStatementRenderer(TYPST_BIN!);
    const pdf = await renderer.render('A plus B', STATEMENT);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  }, 120_000);

  it('a typst failure surfaces as statement_pdf_failed, not a hang', async () => {
    const renderer = new TypstStatementRenderer('/nonexistent/typst');
    await expect(renderer.render('P', 'x')).rejects.toMatchObject({
      code: 'statement_pdf_failed',
    });
  });
});

describe('GET /problems/{code}/statement.pdf', () => {
  it('404s a hidden problem BEFORE revealing whether PDFs are configured', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblem(db, { code: 'hidden-pdf', visibility: 'private' });
        // Visibility first: anonymous gets the same 404 the JSON route gives,
        // never the 501 that would say "this problem exists".
        const res = await request(app.getHttpServer()).get('/problems/hidden-pdf/statement.pdf');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('problem_not_found');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it('answers an honest 501 for a visible problem when no typst is configured', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db);
      try {
        await seedProblem(db, { code: 'public-pdf', visibility: 'public' });
        const res = await request(app.getHttpServer()).get('/problems/public-pdf/statement.pdf');
        expect(res.status).toBe(501);
        expect(res.body.code).toBe('statement_pdf_unavailable');
      } finally {
        await app.close();
      }
    });
  }, 120_000);

  it.skipIf(TYPST_BIN === null)('serves the PDF end-to-end when typst is configured', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp(db, { configOverrides: { typstBin: TYPST_BIN! } });
      try {
        await seedProblem(db, { code: 'real-pdf', visibility: 'public' });
        const res = await request(app.getHttpServer())
          .get('/problems/real-pdf/statement.pdf')
          .buffer(true)
          .parse((response, callback) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => callback(null, Buffer.concat(chunks)));
          });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/pdf');
        expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
