// Every Dockerfile in this repo lists its deps-stage `COPY <pkg>/package.json`
// lines by hand (see judge/Dockerfile, apps/api/Dockerfile,
// apps/judged/Dockerfile) rather than copying whole directories, because a
// hand-picked list preserves Docker layer caching: the deps layer only
// invalidates when a package.json actually changes, not on every source
// edit. That tradeoff is deliberate and this test does not second-guess it.
//
// Its failure mode is real, though: add a workspace package (or a new
// `workspace:` dependency edge) and forget the matching `COPY` line, and a
// real image build fails while every unit test — including this repo's own
// 264 — stays green, because nothing in the suite builds an image. This has
// already happened twice for `@duckoj/package-format`.
//
// This test closes that gap without touching Docker: for each Dockerfile,
// it discovers which workspace app the image builds (the `pnpm --filter
// "@duckoj/X..."` line already in the file), computes X's full transitive
// `workspace:` dependency closure from the real package.json graph, and
// asserts every package in that closure has a `COPY .../package.json` line
// — and, for Dockerfiles that never `COPY . .` (so a missing *source* copy
// is just as real a build break as a missing manifest copy), a matching
// source-directory `COPY` line too. Nothing here is a hardcoded package
// list — that would just be the same failure mode one level up — it is all
// derived from pnpm-workspace.yaml and the package.json files themselves.
//
// Lives in apps/api/test not because this is an api-specific concern, but
// because every workspace package's `test` script runs under `pnpm -r
// test`, and api's suite is already the broadest home for repo-wide checks
// like this one. It needs no containers and reads only the working tree.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface WorkspacePackage {
  /** Repo-root-relative dir, e.g. "packages/api-prefix" or "apps/judged". */
  dir: string;
  deps: Record<string, string>;
}

/** Reads pnpm-workspace.yaml's quoted globs (e.g. 'apps/*') and expands each
 * into the workspace package directories actually present on disk — no
 * hardcoded "apps"/"packages" list, so a future third workspace root is
 * picked up automatically. */
function discoverWorkspaceDirs(): string[] {
  const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...yaml.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]!);
  const dirs: string[] = [];
  for (const glob of globs) {
    if (!glob.endsWith('/*')) {
      throw new Error(`dockerfile-manifest: unsupported pnpm-workspace.yaml glob "${glob}"`);
    }
    const parent = glob.slice(0, -2);
    const parentAbs = join(repoRoot, parent);
    for (const entry of readdirSync(parentAbs, { withFileTypes: true })) {
      if (entry.isDirectory() && statSync(join(parentAbs, entry.name, 'package.json')).isFile()) {
        dirs.push(`${parent}/${entry.name}`);
      }
    }
  }
  return dirs;
}

/** Maps every workspace package's name to its dir + raw dependency maps, by
 * reading each package.json discovered above — the single source of truth
 * for "what does X need", per the brief. */
function loadWorkspaceRegistry(): Map<string, WorkspacePackage> {
  const registry = new Map<string, WorkspacePackage>();
  for (const dir of discoverWorkspaceDirs()) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    registry.set(pkg.name, {
      dir,
      deps: { ...pkg.dependencies, ...pkg.devDependencies },
    });
  }
  return registry;
}

/** BFS over `workspace:` dependency edges (both dependencies and
 * devDependencies — `pnpm install --frozen-lockfile` resolves the whole
 * importer, not just its runtime deps), starting at `rootName` itself. */
function transitiveClosure(registry: Map<string, WorkspacePackage>, rootName: string): Set<string> {
  const root = registry.get(rootName);
  if (!root) {
    throw new Error(`dockerfile-manifest: "${rootName}" is not a known workspace package`);
  }
  const visited = new Set<string>([rootName]);
  const queue = [rootName];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const pkg = registry.get(name)!;
    for (const [depName, spec] of Object.entries(pkg.deps)) {
      if (!spec.startsWith('workspace:')) continue;
      if (!registry.has(depName)) {
        throw new Error(
          `dockerfile-manifest: "${name}" declares a workspace: dependency on unknown package "${depName}"`,
        );
      }
      if (!visited.has(depName)) {
        visited.add(depName);
        queue.push(depName);
      }
    }
  }
  return visited;
}

function findDockerfiles(): string[] {
  // `.claude` holds the campaign's git WORKTREES (gitignored, see
  // `.gitignore`), each a checkout of another branch at another commit.
  // Their Dockerfiles were being asserted against THIS tree's dependency
  // graph, so the moment a package was added on main every stale worktree
  // failed — 26 red tests about files that are not part of this repo's
  // source and do not exist on CI. A worktree is somebody else's working
  // copy; this check is about ours.
  const skip = new Set(['node_modules', '.git', '.claude', 'dist']);
  const results: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        walk(join(abs, entry.name));
      } else if (entry.name === 'Dockerfile') {
        results.push(relative(repoRoot, join(abs, entry.name)));
      }
    }
  };
  walk(repoRoot);
  return results.sort();
}

describe('Dockerfile deps-stage manifests', () => {
  const registry = loadWorkspaceRegistry();
  const dockerfiles = findDockerfiles();

  // Guard against the discovery mechanism itself silently finding nothing —
  // an empty `dockerfiles` array would make every `test.each` below vacuous.
  it('finds at least one Dockerfile to check', () => {
    expect(dockerfiles.length).toBeGreaterThan(0);
  });

  it.each(dockerfiles)('%s COPYs every package.json its build actually needs', (dockerfilePath) => {
    const content = readFileSync(join(repoRoot, dockerfilePath), 'utf8');

    const filterMatch = content.match(/RUN\s+pnpm\s+--filter\s+"@duckoj\/([\w.-]+)\.\.\."/);
    if (!filterMatch) {
      throw new Error(
        `${dockerfilePath}: no \`RUN pnpm --filter "@duckoj/<name>..."\` line found — cannot ` +
          'determine which workspace app this image builds. Update this test if the ' +
          'Dockerfile\'s build command shape changed.',
      );
    }
    const targetName = `@duckoj/${filterMatch[1]}`;
    const needed = [...transitiveClosure(registry, targetName)].map((name) => registry.get(name)!.dir);

    const copiedPackageJson = new Set(
      [...content.matchAll(/^COPY\s+((?:apps|packages)\/[^\s/]+)\/package\.json\b/gm)].map((m) => m[1]!),
    );
    const missingPackageJson = needed.filter((dir) => !copiedPackageJson.has(dir));
    expect(missingPackageJson, `${dockerfilePath} is missing COPY <dir>/package.json for`).toEqual([]);

    // A Dockerfile that `COPY . .`s the whole tree can't have a missing
    // *source* copy — everything is already there. One that hand-lists
    // directories (like judge/Dockerfile's agent-build stage) can, and that
    // failure is just as real a build break as a missing manifest copy.
    const copiesEverything = /^COPY\s+\.\s+\.\s*$/m.test(content);
    if (!copiesEverything) {
      const copiedSource = new Set(
        [
          ...content.matchAll(
            /^COPY\s+((?:apps|packages)\/[^\s/]+)\s+(?:apps|packages)\/[^\s/]+\/?\s*$/gm,
          ),
        ].map((m) => m[1]!),
      );
      const missingSource = needed.filter((dir) => !copiedSource.has(dir));
      expect(missingSource, `${dockerfilePath} is missing COPY <dir> <dir>/ (source) for`).toEqual([]);
    }
  });
});
