import { mkdtemp, readFile, mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { packDirectory, packageHash } from '@duckoj/package-format';
import { Materializer } from '../src/materializer.js';

/** The `RequestInit` a call must have carried, or a failure that says so. */
function requireInit(init: RequestInit | undefined): RequestInit {
  if (!init) throw new Error('fetch was called without a RequestInit');
  return init;
}

/** A minimal, manifest-valid package: `manifest.json` plus one test under `tests/`. */
async function buildFixturePackage(): Promise<{ archive: Buffer; hash: string }> {
  const srcDir = await mkdtemp(join(tmpdir(), 'pkgsrc-'));
  await mkdir(join(srcDir, 'tests'), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    name: 'aplusb',
    checker: { kind: 'standard' },
    limits: { timeMs: 1000, memoryKb: 262144 },
    tests: [{ input: 'tests/01.in', answer: 'tests/01.out', points: 100, group: 0 }],
  };
  await writeFile(join(srcDir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(srcDir, 'tests', '01.in'), '1 2\n');
  await writeFile(join(srcDir, 'tests', '01.out'), '3\n');
  const { archive, files } = await packDirectory(srcDir);
  return { archive, hash: packageHash(files) };
}

async function tempProblemsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'problems-'));
}

function materializerFor(problemsDir: string, fetchImpl: ReturnType<typeof vi.fn>): Materializer {
  return new Materializer({
    apiOrigin: 'http://api.invalid',
    judgeName: 'judge-1',
    judgeToken: 'super-secret-token',
    problemsDir,
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
  });
}

/** No entry anywhere under `dir` (recursively) is named `init.yml`. */
async function hasNoInitYmlAnywhere(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const initYml = join(dir, entry.name, 'init.yml');
    if (await stat(initYml).catch(() => undefined)) return false;
  }
  return true;
}

describe('Materializer', () => {
  it('unpacks a package and renders init.yml beside its tests', async () => {
    // Build a real package with packDirectory (manifest.json + tests/),
    // stub fetch to return its bytes, ensure(hash), then assert both
    // <problems>/<hash>/init.yml and <problems>/<hash>/tests/01.in exist,
    // and that init.yml's test paths are `tests/01.in` — not `01.in`.
    const { archive, hash } = await buildFixturePackage();
    const problemsDir = await tempProblemsDir();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(archive));
    const materializer = materializerFor(problemsDir, fetchImpl);

    await materializer.ensure(hash);

    const initYml = await readFile(join(problemsDir, hash, 'init.yml'), 'utf8');
    expect(initYml).toContain('tests/01.in');
    expect(initYml).not.toMatch(/in:\s*01\.in/);
    await expect(readFile(join(problemsDir, hash, 'tests', '01.in'), 'utf8')).resolves.toBe(
      '1 2\n',
    );

    // The Authorization header carries the credential; it must never be
    // placed in the URL.
    const [calledUrl, rawInit] = fetchImpl.mock.calls[0]!;
    const calledInit = requireInit(rawInit);
    expect(calledUrl).not.toContain('super-secret-token');
    expect((calledInit.headers as Record<string, string>).authorization).toBe(
      'Judge judge-1:super-secret-token',
    );
    // Every apps/api route (other than healthz/readyz) sits behind Nest's
    // global `api/v1` prefix (apps/api/src/app.setup.ts) — including this
    // judge-only archive route. A bare `${apiOrigin}/internal/packages/...`
    // 404s against a real API; a mocked fetch never caught that until Task
    // 13's actual podman-compose bring-up did.
    expect(calledUrl).toBe(`http://api.invalid/api/v1/internal/packages/${hash}/archive`);
  }, 30_000);

  it('is a no-op when the package is already materialised', async () => {
    // Call ensure twice with a fetch spy; assert fetch ran once.
    const { archive, hash } = await buildFixturePackage();
    const problemsDir = await tempProblemsDir();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(archive));
    const materializer = materializerFor(problemsDir, fetchImpl);

    await materializer.ensure(hash);
    await materializer.ensure(hash);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('coalesces concurrent ensure() calls for the same hash into exactly one fetch', async () => {
    // Three concurrent ensure(sameHash) calls, started before the fetch
    // resolves, must share one in-flight materialisation rather than each
    // starting their own fetch.
    const { archive, hash } = await buildFixturePackage();
    const problemsDir = await tempProblemsDir();
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      await gate;
      return new Response(archive);
    });
    const materializer = materializerFor(problemsDir, fetchImpl);

    const p1 = materializer.ensure(hash);
    const p2 = materializer.ensure(hash);
    const p3 = materializer.ensure(hash);

    // Wait until the (single) fetch has actually started before releasing
    // it, so the three calls are genuinely racing against an in-flight
    // request rather than each starting their own after the gate is freed.
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    releaseFetch!();

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([undefined, undefined, undefined]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('does not coalesce concurrent ensure() calls for different hashes', async () => {
    // Without keying the in-flight map by hash, an implementation that
    // coalesces everything would also pass the same-hash test above while
    // being badly wrong. Two distinct hashes started concurrently must each
    // trigger their own fetch.
    const { archive } = await buildFixturePackage();
    const problemsDir = await tempProblemsDir();
    const hashA = 'c'.repeat(64);
    const hashB = 'd'.repeat(64);
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      await gate;
      return new Response(archive);
    });
    const materializer = materializerFor(problemsDir, fetchImpl);

    const pA = materializer.ensure(hashA);
    const pB = materializer.ensure(hashB);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    releaseFetch!();

    await Promise.all([pA, pB]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('does not poison the in-flight map after a failed materialisation, so a later call retries', async () => {
    // The in-flight entry is deleted in a `.finally()` specifically so a
    // rejected attempt does not get cached forever. Nothing currently
    // proves that: assert the second ensure() after a failure fetches again
    // and succeeds.
    const { archive, hash } = await buildFixturePackage();
    const problemsDir = await tempProblemsDir();
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('network unreachable');
      })
      .mockImplementation(async () => new Response(archive));
    const materializer = materializerFor(problemsDir, fetchImpl);

    await expect(materializer.ensure(hash)).rejects.toThrow('network unreachable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await materializer.ensure(hash);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(readFile(join(problemsDir, hash, 'init.yml'), 'utf8')).resolves.toContain(
      'tests/01.in',
    );
  }, 30_000);

  it('leaves no partial directory when the fetch fails', async () => {
    // Stub fetch to reject; assert <problems>/<hash> does not exist and no
    // stray directory matching */init.yml was created. A half-written package
    // is worse than a missing one, because the judge will announce it.
    const hash = 'a'.repeat(64);
    const problemsDir = await tempProblemsDir();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error('network unreachable');
    });
    const materializer = materializerFor(problemsDir, fetchImpl);

    await expect(materializer.ensure(hash)).rejects.toThrow();

    await expect(stat(join(problemsDir, hash))).rejects.toThrow();
    expect(await hasNoInitYmlAnywhere(problemsDir)).toBe(true);
    expect(await readdir(problemsDir)).toEqual([]);
  }, 30_000);

  it('leaves no partial directory when the archive is corrupt', async () => {
    // Stub fetch to return random bytes; same assertion.
    const hash = 'b'.repeat(64);
    const problemsDir = await tempProblemsDir();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(Buffer.from('not a valid zstd+tar archive')));
    const materializer = materializerFor(problemsDir, fetchImpl);

    await expect(materializer.ensure(hash)).rejects.toThrow();

    await expect(stat(join(problemsDir, hash))).rejects.toThrow();
    expect(await hasNoInitYmlAnywhere(problemsDir)).toBe(true);
    expect(await readdir(problemsDir)).toEqual([]);
  }, 30_000);

  it('refuses a hash that is not 64 hex characters', async () => {
    // The hash becomes a directory name under PROBLEMS_DIR.
    const problemsDir = await tempProblemsDir();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(Buffer.from('unused')));
    const materializer = materializerFor(problemsDir, fetchImpl);

    await expect(materializer.ensure('not-a-valid-hash')).rejects.toThrow(/hash/i);
    await expect(materializer.ensure('a'.repeat(63))).rejects.toThrow(/hash/i);
    await expect(materializer.ensure('g'.repeat(64))).rejects.toThrow(/hash/i);
    await expect(materializer.ensure('../../../../etc/passwd')).rejects.toThrow(/hash/i);

    // Rejected before any network call or filesystem write was attempted.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(problemsDir)).toEqual([]);
  }, 30_000);
});
