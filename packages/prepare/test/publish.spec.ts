/**
 * `publishProblem` against a doubled `fetch`, which is where the requests
 * themselves are the claim.
 *
 * The one this file exists for: **publishing the editorial is a separate
 * decision from publishing the revision, and `--publish` is the flag that
 * makes both.** `prepare publish <dir>` without `--publish` is the documented
 * way to stage next year's package on a live problem — the revision lands as
 * a `draft` "and a person publishes it" (D87/D90). The editorial went out on
 * every run regardless, with `editorialPublished: true`, and D43 serves a
 * published editorial to *any* viewer who may see the problem. So restaging a
 * public problem handed the whole room the solution write-up, from a command
 * whose entire point was that it published nothing.
 *
 * `PATCH { editorial }` on its own leaves `editorial_published_at` exactly as
 * it was (`problem.access.ts`: only an explicit `editorialPublished` moves
 * it), so "store it, do not publish it" is expressible and is what a run
 * without `--publish` now does.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadProblem, packageProblem, publishProblem } from '../src/index.js';
import { cleanupFixtures, cloneFixture } from './helpers.js';

afterAll(cleanupFixtures);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

/**
 * A DuckOJ that says yes to everything, remembering what it was asked. The
 * revision list is empty, so every run attaches a new revision — the case a
 * setter is in the first time they stage a package.
 */
function stubFetch(): void {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : null;
    calls.push({ method, path: url.pathname + url.search, body });

    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname.endsWith('/revisions') && method === 'GET') return json([]);
    if (url.pathname.endsWith('/revisions') && method === 'POST') return json({ version: 2 });
    if (url.pathname.startsWith('/packages')) return json({ hash: 'x' });
    return json({ code: 'p', name: 'p' });
  }) as typeof globalThis.fetch;
}

beforeEach(stubFetch);
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SLOW = 60_000;

/** A prepared directory that carries an `editorial.md`. */
async function withEditorial(): Promise<{ problem: Awaited<ReturnType<typeof loadProblem>>; archive: Buffer; hash: string }> {
  const dir = await cloneFixture('polygon-good');
  await writeFile(join(dir, 'editorial.md'), '# Lời giải\n\nCộng hai số lại.\n');
  const problem = await loadProblem(dir, { code: 'tong-hai-so' });
  const built = await packageProblem(problem, join(dir, 'out'));
  return { problem, archive: built.archive, hash: built.hash };
}

function editorialPatches(): Call[] {
  return calls.filter(
    (call) =>
      call.method === 'PATCH' &&
      typeof call.body === 'object' &&
      call.body !== null &&
      'editorial' in call.body,
  );
}

describe('publishing the editorial', () => {
  it(
    'stores it without publishing it when the revision is not published',
    async () => {
      const { problem, archive, hash } = await withEditorial();
      await publishProblem(problem, archive, hash, {
        baseUrl: 'https://oj.test/api/v1',
        token: 't',
      });
      const patches = editorialPatches();
      expect(patches).toHaveLength(1);
      const body = patches[0]!.body as Record<string, unknown>;
      expect(body['editorial']).toContain('Cộng hai số lại.');
      // The whole finding: no run that publishes nothing may publish this.
      expect(body['editorialPublished']).not.toBe(true);
    },
    SLOW,
  );

  it(
    'publishes it alongside a published revision',
    async () => {
      const { problem, archive, hash } = await withEditorial();
      await publishProblem(problem, archive, hash, {
        baseUrl: 'https://oj.test/api/v1',
        token: 't',
        publish: true,
      });
      const body = editorialPatches()[0]!.body as Record<string, unknown>;
      expect(body['editorialPublished']).toBe(true);
    },
    SLOW,
  );

  it(
    'sends nothing at all under --no-editorial',
    async () => {
      const { problem, archive, hash } = await withEditorial();
      await publishProblem(problem, archive, hash, {
        baseUrl: 'https://oj.test/api/v1',
        token: 't',
        publish: true,
        editorial: false,
      });
      expect(editorialPatches()).toHaveLength(0);
    },
    SLOW,
  );
});
