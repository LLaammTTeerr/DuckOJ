/**
 * Publishing a prepared problem to a running DuckOJ.
 *
 * **D90: through `POST /packages` + `POST /problems/{code}/revisions`, not
 * through the D87 draft routes.** The drafts path needs one scope where this
 * needs two, and that is the only respect in which it is cheaper. A draft's
 * file names are flat by contract (`DraftFileName`: `^[A-Za-z0-9._-]+$`, no
 * separator), so `tests/01.in` and `checker/check.cpp` — the paths every
 * Polygon import plans — cannot be expressed in one at all; publishing through
 * it would mean flattening the package, which changes its hash, which means
 * one directory registering a different hash here than `polygon:import` +
 * `package:build` print for it. That is precisely the two-hashes-for-one
 * -directory drift D87 exists to prevent, and it would also break the
 * idempotency below, which is a hash comparison.
 *
 * Deliberately plain `fetch` against the documented routes rather than the
 * generated SDK: this package is imported by a CLI and (soon) by `apps/mcp`,
 * and neither should have to carry the browser client's dependencies to
 * upload a tarball.
 */
import { readFile } from 'node:fs/promises';

import { PrepareError } from './errors.js';
import type { PreparedProblem } from './model.js';

export interface PublishOptions {
  /** API root, e.g. `http://localhost:8080/api/v1`. */
  baseUrl: string;
  /** A personal access token with `problems:write`, `problems:publish`, `packages:write`. */
  token: string;
  /** Publish the revision this run attaches. Never a default (see D87). */
  publish?: boolean;
  /** Set the problem's visibility. Omitted leaves whatever it has. */
  visibility?: 'private' | 'org' | 'public';
  notes?: string;
  /**
   * Send `editorial.md`, when the directory carries one. Default true.
   * SENDING it stores it; it is PUBLISHED only alongside `publish` (D97).
   */
  editorial?: boolean;
}

export interface PublishResult {
  code: string;
  created: boolean;
  packageHash: string;
  version: number;
  /** False when an existing revision already carried this exact package. */
  revisionCreated: boolean;
  published: boolean;
  steps: string[];
}

interface RevisionSummary {
  version: number;
  state: 'draft' | 'published' | 'archived';
  packageHash: string;
}

class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    return await fetch(this.url(path), { ...init, method, headers });
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, {
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    return await expect<T>(response, `${method} ${path}`);
  }
}

async function expect<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new PrepareError(`${what} answered ${String(response.status)}: ${text.slice(0, 800)}`);
  }
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PrepareError(`${what} answered ${String(response.status)} with a body that is not JSON`);
  }
}

export async function publishProblem(
  problem: PreparedProblem,
  archive: Buffer,
  packageHash: string,
  options: PublishOptions,
): Promise<PublishResult> {
  if (problem.statement === null) {
    throw new PrepareError('refusing to publish a problem with no statement — run the gate first');
  }
  const api = new ApiClient(options.baseUrl, options.token);
  const steps: string[] = [];
  const code = problem.code;

  // 1. The problem row. `GET` first so a re-run patches instead of colliding.
  const existing = await api.request('GET', `/problems/${code}`);
  let created = false;
  if (existing.status === 404) {
    await api.json('POST', '/problems', {
      code,
      name: problem.name,
      statement: problem.statement.text,
      visibility: 'private',
    });
    created = true;
    steps.push(`created problem ${code}`);
  } else if (!existing.ok) {
    throw new PrepareError(
      `GET /problems/${code} answered ${String(existing.status)}: ${(await existing.text()).slice(0, 800)}`,
    );
  } else {
    steps.push(`problem ${code} already exists`);
  }

  // 2. Statement, name, classification — one PATCH, whether created or not,
  //    so a re-run after an edit to statement.md actually updates the page.
  const patch: Record<string, unknown> = {
    name: problem.name,
    statement: problem.statement.text,
  };
  if (problem.tags.length > 0) patch.tags = problem.tags;
  if (problem.difficulty !== null) patch.difficulty = problem.difficulty;
  if (options.visibility !== undefined) patch.visibility = options.visibility;
  await api.json('PATCH', `/problems/${code}`, patch);
  steps.push(`patched statement${problem.tags.length > 0 ? `, tags ${problem.tags.join(', ')}` : ''}`);

  // 3. The package. An existing revision carrying this exact hash is the
  //    idempotency rule: identical content attaches nothing new.
  const revisions = await api.json<RevisionSummary[]>('GET', `/problems/${code}/revisions`);
  const already = revisions.find((r) => r.packageHash === packageHash);
  let version: number;
  let revisionCreated = false;
  if (already !== undefined) {
    version = already.version;
    steps.push(`revision ${String(version)} already carries package ${packageHash.slice(0, 12)}`);
  } else {
    const upload = await api.request('POST', `/packages?hash=${packageHash}`, {
      body: new Uint8Array(archive),
      headers: { 'content-type': 'application/octet-stream' },
    });
    await expect<unknown>(upload, `POST /packages?hash=${packageHash}`);
    steps.push(`uploaded package ${packageHash.slice(0, 12)} (${String(archive.length)} bytes)`);
    const attached = await api.json<{ version: number }>('POST', `/problems/${code}/revisions`, {
      packageHash,
      notes: options.notes ?? `prepared by @duckoj/prepare from ${problem.dir}`,
    });
    version = attached.version;
    revisionCreated = true;
    steps.push(`attached revision ${String(version)}`);
  }

  // 4. Publish, only when asked.
  let published = already?.state === 'published';
  if (options.publish === true && !published) {
    await api.json('POST', `/problems/${code}/revisions/${String(version)}/publish`);
    published = true;
    steps.push(`published revision ${String(version)}`);
  }

  // 5. The editorial. STORED on every run, PUBLISHED only when this run
  //    published the revision.
  //
  //    Publishing it unconditionally was the bug: `prepare publish <dir>`
  //    without `--publish` is the documented way to stage a package on a live
  //    problem — the revision lands as a `draft` for a person to publish
  //    (D87, and D90's "never a default") — and D43 serves a published
  //    editorial to *any* viewer who may see the problem. So the command
  //    whose whole point was that it published nothing handed the room the
  //    solution write-up. Publishing an editorial is a decision, exactly as
  //    D88 rules for the clone that carries one "but never carried as
  //    PUBLISHED"; `--publish` is where that decision is made.
  //
  //    A PATCH carrying only `editorial` leaves `editorial_published_at`
  //    alone (`problem.access.ts` moves it only for an explicit
  //    `editorialPublished`), so an editorial that is ALREADY published stays
  //    published and simply gets the new text — which is what re-running on a
  //    live problem must do.
  if (options.editorial !== false && problem.editorialPath !== null) {
    const text = await readFile(problem.editorialPath, 'utf8');
    await api.json('PATCH', `/problems/${code}`, {
      editorial: text,
      ...(published ? { editorialPublished: true } : {}),
    });
    steps.push(
      published
        ? 'published editorial.md'
        : 'stored editorial.md (not published — pass --publish, or publish the revision)',
    );
  }

  return { code, created, packageHash, version, revisionCreated, published, steps };
}
