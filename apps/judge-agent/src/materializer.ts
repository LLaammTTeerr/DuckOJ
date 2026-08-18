import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { API_PREFIX } from '@qhhoj/api-prefix';
import { unpackArchive, parseManifest, renderInitYml } from '@qhhoj/package-format';

/**
 * The hash becomes two path components under `PROBLEMS_DIR` — the final
 * `<hash>` directory and its `.tmp-<hash>` staging sibling — so an
 * unvalidated value is an arbitrary-write primitive. Same reasoning, same
 * pattern, as `FilesystemPackageStore.pathFor` in apps/api.
 */
export const PACKAGE_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface MaterializerOptions {
  apiOrigin: string;
  judgeName: string;
  judgeToken: string;
  problemsDir: string;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof globalThis.fetch;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches a package by hash from the API and materialises it under
 * `PROBLEMS_DIR` so judge-server (which only reads its local filesystem)
 * can grade against it.
 *
 * judge-server watches `PROBLEMS_DIR` with `watchdog` and rescans on any
 * change. Unpacking directly into `<PROBLEMS_DIR>/<hash>` would let it
 * observe a half-written package mid-write and announce a problem it cannot
 * actually grade — a grading failure whose cause is far away from its
 * symptom. So every attempt unpacks into a hidden staging directory
 * (`.tmp-<hash>`, inside `PROBLEMS_DIR` so the final `rename` cannot cross a
 * filesystem boundary, and leading-dot so the judge's glob for `init.yml`
 * one directory down never matches it while incomplete) and either renames
 * it whole into place or removes it whole on any failure. A half-written
 * package is worse than a missing one, so nothing is ever left
 * half-written — not even on a fetch failure or a corrupt archive.
 */
export class Materializer {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: MaterializerOptions) {}

  /**
   * Ensures `<PROBLEMS_DIR>/<hash>` exists and is fully materialised.
   * Concurrent calls for the same hash share one in-flight attempt, so two
   * jobs arriving together fetch once rather than racing on the same
   * rename.
   */
  async ensure(hash: string): Promise<void> {
    if (!PACKAGE_HASH_PATTERN.test(hash)) {
      throw new Error(`refusing to materialise an invalid package hash: '${hash}'`);
    }

    const running = this.inFlight.get(hash);
    if (running) return running;

    const task = this.materialize(hash).finally(() => {
      this.inFlight.delete(hash);
    });
    this.inFlight.set(hash, task);
    return task;
  }

  private async materialize(hash: string): Promise<void> {
    const finalDir = join(this.options.problemsDir, hash);
    // A package is immutable once fetched, so a previously completed
    // materialisation never needs refreshing.
    if (await exists(join(finalDir, 'init.yml'))) return;

    const tempDir = join(this.options.problemsDir, `.tmp-${hash}`);
    // Clear any debris a previous crashed attempt left behind — reusing it
    // could let stale files from a different attempt survive the rename.
    await rm(tempDir, { recursive: true, force: true });

    try {
      const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
      // `apiOrigin` is a bare origin (e.g. `http://api:3000`), not
      // API-prefixed — every route in apps/api sits behind NestJS's global
      // `API_PREFIX` (`apps/api/src/app.setup.ts`'s `setGlobalPrefix`,
      // which excludes only `healthz`/`readyz`), including this judge-only
      // archive route. `@qhhoj/api-prefix` is the single shared source for
      // that literal — `apps/web/src/api.ts` builds its base URL from the
      // same constant. Discovered missing here (a bare `/internal/packages/
      // ...` with no prefix at all) at Task 13's integration bring-up: every
      // unit test in this file mocks `fetch` and never asserted the exact
      // path against a real Nest app, so a 404 here was silent until an
      // actual `podman-compose` stack proved it. `apps/api/test/
      // app.smoke.spec.ts` now asserts the real route answers at this real
      // prefix, so a divergence here or in `app.setup.ts` fails a test
      // instead of only a live judge.
      const url = `${this.options.apiOrigin}/${API_PREFIX}/internal/packages/${hash}/archive`;
      const res = await fetchImpl(url, {
        headers: { authorization: `Judge ${this.options.judgeName}:${this.options.judgeToken}` },
      });
      if (!res.ok) {
        throw new Error(`fetching package ${hash} failed: HTTP ${res.status}`);
      }
      const archive = Buffer.from(await res.arrayBuffer());

      await unpackArchive(archive, tempDir);

      const manifestJson = JSON.parse(
        await readFile(join(tempDir, 'manifest.json'), 'utf8'),
      ) as unknown;
      const manifest = parseManifest(manifestJson);
      // Test paths in the manifest are written exactly as they sit inside
      // the package (e.g. `tests/01.in`), which is also exactly how
      // `renderInitYml` writes them into `init.yml` — dmoj/problem.py joins
      // them against the problem root as-is.
      await writeFile(join(tempDir, 'init.yml'), renderInitYml(manifest));

      // The load-bearing step: same filesystem as `tempDir`, so this is
      // atomic. The judge observes the directory either not at all or
      // fully written — never in between.
      await rename(tempDir, finalDir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }
}
