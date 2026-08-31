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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  // A fenced block's content is emitted VERBATIM into a typst raw literal, so
  // the fence has to be longer than any backtick run inside it — exactly the
  // rule CommonMark itself has. It was hard-coded to four, and a statement
  // author (a problem setter, semi-trusted) could write four backticks in the
  // middle of a fenced line: the raw literal closed there and everything after
  // it reached `typst compile` as CODE rather than text.
  //
  // Proven against the real binary during the B10 security loop: the injected
  // `#read(...)` was evaluated and typst reported it trying to open the file.
  // Typst does sandbox reads to the project root (a `../` path is refused), so
  // the blast radius is the API's working directory rather than the whole host
  // — but arbitrary typst evaluation is not something a statement may do, and
  // D48 compiles every problem of a contest into ONE document, so a single
  // poisoned statement takes the whole booklet down on contest day.
  it('fences a raw block longer than any backtick run inside it', () => {
    const doc = markdownToTypst('P', '```\nx ```` #read("/etc/hostname") ```` y\n```');
    // The content is still verbatim...
    expect(doc).toContain('#read("/etc/hostname")');
    // ...but the delimiter around it must out-run the four backticks it holds,
    // or the `#read` is live typst code. Five is the minimum that does.
    expect(doc).toContain('`````\nx ```` #read("/etc/hostname") ```` y\n`````');
    // And nothing shorter may be doing the delimiting.
    expect(doc).not.toMatch(/(?<!`)````(?!`)\nx /);
  });

  it('leaves the ordinary fence at four backticks', () => {
    // A three-backtick run inside a four-backtick fence does NOT close it
    // (verified against the real binary), so the common case must not grow a
    // delimiter it does not need.
    const doc = markdownToTypst('P', '```\nplain code\n```');
    expect(doc).toContain('````\nplain code\n````');
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
        const res = await request(app.getHttpServer()).get('/api/v1/problems/hidden-pdf/statement.pdf');
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
        const res = await request(app.getHttpServer()).get('/api/v1/problems/public-pdf/statement.pdf');
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
          .get('/api/v1/problems/real-pdf/statement.pdf')
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

/**
 * The subprocess bound — B10's standing concern, closed.
 *
 * A statement is author-controlled input to a Turing-complete typesetter, so
 * `typst compile` can be made to run forever (`#while true { }`) or to emit an
 * unbounded document. B10 closed the injection that made a hang trivially
 * reachable and recorded the missing bound as a standing concern; this is the
 * bound.
 *
 * Exercised against a FAKE binary as well as the real one, because the real
 * one is skipped wherever typst is not installed — and these are exactly the
 * cases that must not regress unnoticed there. `spawn` does not care what it
 * runs: the renderer's contract is "kill the process group, answer 500 with a
 * reason", and a shell script exercises that precisely and in milliseconds.
 */
describe('TypstStatementRenderer subprocess bound', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'duckoj-typst-bound-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A fake `typst` that ignores its arguments and runs `body` instead. */
  async function fakeBin(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  }

  it('kills a render that outruns the timeout, and names the timeout', async () => {
    const bin = await fakeBin('slow.sh', 'sleep 30');
    const renderer = new TypstStatementRenderer(bin, { timeoutMs: 300 });
    const started = Date.now();
    await expect(renderer.render('P', 'x')).rejects.toMatchObject({
      status: 500,
      code: 'statement_pdf_failed',
    });
    // The point of the bound: the caller is answered in ~300 ms, not in 30 s.
    expect(Date.now() - started).toBeLessThan(10_000);
    const second = new TypstStatementRenderer(bin, { timeoutMs: 300 });
    await expect(second.render('P', 'x')).rejects.toThrow(/timed out/i);
  });

  it('kills the whole process GROUP, not just the child it spawned', async () => {
    // `typst` is one shell away from being a process tree, and `child.kill()`
    // reaps only the pid we hold — leaving a grandchild running against a
    // request that has already been answered.
    const marker = join(dir, 'grandchild-survived');
    const bin = await fakeBin('tree.sh', `sh -c 'sleep 2; : > ${marker}' & sleep 30`);
    const renderer = new TypstStatementRenderer(bin, { timeoutMs: 300 });
    await expect(renderer.render('P', 'x')).rejects.toMatchObject({ code: 'statement_pdf_failed' });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a render whose output outgrows the cap', async () => {
    // 8 MiB of zeroes against a 64 KiB cap: refused while it is still being
    // written, so nothing ever buffers the whole thing.
    const bin = await fakeBin('big.sh', 'head -c 8388608 /dev/zero; sleep 5');
    const renderer = new TypstStatementRenderer(bin, {
      maxOutputBytes: 64 * 1024,
      timeoutMs: 30_000,
    });
    const started = Date.now();
    await expect(renderer.render('P', 'x')).rejects.toMatchObject({
      status: 500,
      code: 'statement_pdf_failed',
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const second = new TypstStatementRenderer(bin, { maxOutputBytes: 64 * 1024, timeoutMs: 30_000 });
    await expect(second.render('P', 'x')).rejects.toThrow(/output/i);
  });

  it('still returns the document a bounded render produces', async () => {
    const bin = await fakeBin('ok.sh', 'cat > /dev/null; printf "%%PDF-1.7 ok"');
    const renderer = new TypstStatementRenderer(bin, { timeoutMs: 10_000, maxOutputBytes: 1024 });
    await expect(renderer.render('P', 'x')).resolves.toEqual(Buffer.from('%PDF-1.7 ok'));
  });

  it.skipIf(TYPST_BIN === null)('bounds a pathological document against the real binary', async () => {
    const renderer = new TypstStatementRenderer(TYPST_BIN!, { timeoutMs: 2_000 });
    // Author-controlled, and typst's language is expressive enough to make a
    // three-line statement cost minutes. Not `#while true { }`: typst refuses
    // that one statically ("loop seems to be infinite") and refuses a
    // long-running `while` too, so the reachable shape is content generation
    // — this one runs for well over six seconds before it is killed, measured
    // against the real binary.
    const document = '#set page(width: 10cm)\n= P\n#for i in range(3000000) [#i ]\n';
    const started = Date.now();
    await expect(renderer.renderDocument(document)).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});
