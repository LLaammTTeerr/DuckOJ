/**
 * D143 — a container-backed spec may never run on vitest's default budget.
 *
 * The single most-reported failure of this campaign is one sentence, in
 * twenty hunt reports: "X.spec.ts failed under the full parallel run, passes
 * in isolation — container contention". B-34 opened one instance and found it
 * was not contention at all: `problem-comments.spec.ts` ran thirteen cases
 * that start a Postgres container and run the whole migration chain on
 * vitest's DEFAULT `testTimeout` of 5 s, while every sibling passed
 * `120_000` by hand. A plain defect wearing a flake's clothes — and this
 * audit found the same hole in thirty-eight more spec files, `app.smoke`,
 * `route-marker-coverage` and `org-member-import`'s twenty-one cases among
 * them.
 *
 * The fix is ONE mechanism, not a magic number per file: each package whose
 * tests start containers declares `testTimeout` and `hookTimeout` in its own
 * `vitest.config.ts`, and every spec inherits the floor by existing. This is
 * the guard that keeps that true — a SOURCE-SCAN in the shape of
 * `route-marker-coverage.spec.ts` and `team-participation-invariant.spec.ts`,
 * covering the whole workspace rather than this package alone, because the
 * next package to grow a container spec is the one nobody will think about.
 *
 * It fails on the two ways the policy can rot:
 *
 *   1. a package's tests touch a container harness and its vitest config
 *      does not declare both floors (or declares them below the floor) — the
 *      "new package, nobody remembered" case;
 *   2. a DB-touching spec passes an explicit timeout argument BELOW the floor
 *      to `it` / `test` / `beforeAll` / `beforeEach` — silently opting back
 *      out of the config for that one case, which is how the defect
 *      originally spread.
 *
 * What it deliberately does NOT police:
 *
 *   - `afterAll` / `afterEach`. Both harnesses stop their container under an
 *     explicit 30 s with a bounded retry ("warn and move on rather than fail
 *     this spec file over a stopped container"), which is a deliberate
 *     teardown policy; flooring it to two minutes would make a wedged `stop`
 *     hold every file hostage.
 *   - arguments at or ABOVE the floor. `180_000` and `300_000` appear on the
 *     genuinely slow files and are a considered choice, not a leak.
 *   - the ~800 redundant `120_000` arguments already written. They are all at
 *     the floor, so they change nothing; rewriting them would be churn.
 *     Nothing NEW needs one.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');

/**
 * The LEAST any timeout declaration in this policy may be, in milliseconds.
 *
 * A floor, not a recommendation: the three package configs declare `180_000`
 * (see `apps/api/vitest.config.ts` for the run that bought the extra minute),
 * and the ~800 hand-written `120_000` arguments sit exactly on this line.
 * What the guard forbids is going BELOW it.
 */
const FLOOR_MS = 120_000;

/**
 * A spec "touches a container" if it reaches one of the harnesses that start
 * one, or names a Testcontainers class directly. Kept as one regex so the
 * guard and the policy cannot drift apart.
 */
const CONTAINER_SPEC =
  /db\.harness|redis\.harness|app\.harness|cache\.harness|testDbUrl|withTestDb|PostgreSqlContainer|RedisContainer|GenericContainer|ensureRedisUrl/;

/** The hooks and cases a timeout argument may be attached to. */
const TIMED_CALL =
  /(^|[^.\w])(it|test|beforeAll|beforeEach)(\.(?:concurrent|sequential|skip|only|todo|fails|each|skipIf|runIf))*\s*\(/gm;

/**
 * Comments out. Every config here explains WHY the floors are what they are,
 * and that prose names the defaults it replaces — `apps/api/vitest.config.ts`
 * says "5_000" and "10_000" in the sentence describing the bug. Read
 * literally, the file would then declare a below-floor timeout and fail its
 * own guard for documenting itself.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** `testTimeout: 120_000` / `hookTimeout: 120000` in a config's source. */
function declaredTimeout(source: string, key: string): number | null {
  const match = new RegExp(`${key}\\s*:\\s*([0-9][0-9_]*)`).exec(stripComments(source));
  return match ? Number(match[1]!.replaceAll('_', '')) : null;
}

/** This file quotes every pattern it scans for; scanning itself is circular. */
const SELF = relative(repoRoot, fileURLToPath(import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

/** Every workspace package that has a `test/` (or `src/`) tree of specs. */
function workspacePackages(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, group, entry.name)),
  );
}

/**
 * The index just past the `)` matching the `(` at `open`. A regex cannot find
 * the last argument of an `it(...)` whose callback contains parentheses,
 * strings and comments, and a wrong answer here would make the guard either
 * blind or unfixable.
 */
function matchParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === quote) break;
        else i++;
      }
    } else if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (char === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
    }
  }
  return -1;
}

interface ContainerSpec {
  path: string;
  relativePath: string;
  packageDir: string;
  source: string;
}

function containerSpecs(): ContainerSpec[] {
  return workspacePackages().flatMap((packageDir) =>
    walk(packageDir)
      .map((path) => ({
        path,
        relativePath: relative(repoRoot, path),
        packageDir,
        source: readFileSync(path, 'utf8'),
      }))
      .filter((spec) => spec.relativePath !== SELF && CONTAINER_SPEC.test(spec.source)),
  );
}

describe('D143 — container-backed specs never run on vitest defaults', () => {
  // A floor, so a broken discovery regex cannot make the assertions below
  // pass by finding nothing. There were 139 such specs when this was written.
  it('discovers the container-backed specs it is meant to police', () => {
    expect(containerSpecs().length).toBeGreaterThanOrEqual(100);
  });

  it('gives every package with container specs a config declaring both floors', () => {
    const packages = [...new Set(containerSpecs().map((spec) => spec.packageDir))];
    expect(packages.length).toBeGreaterThanOrEqual(3);

    const offenders = packages.flatMap((packageDir) => {
      // vitest reads `vitest.config.ts` in preference to `vite.config.ts`,
      // and `apps/web` declares its test block in the latter — so either is
      // a legal home for the floors.
      const config = ['vitest.config.ts', 'vite.config.ts']
        .map((name) => join(packageDir, name))
        .find((path) => existsSync(path));
      const name = relative(repoRoot, packageDir);
      if (!config) return [`${name}: no vitest.config.ts`];
      const source = readFileSync(config, 'utf8');
      return (['testTimeout', 'hookTimeout'] as const).flatMap((key) => {
        const value = declaredTimeout(source, key);
        if (value === null) return [`${name}: config declares no ${key}`];
        return value < FLOOR_MS ? [`${name}: ${key} is ${String(value)}, below ${String(FLOOR_MS)}`] : [];
      });
    });

    expect(
      offenders,
      `A package whose tests start containers must declare testTimeout and hookTimeout of at least ${String(FLOOR_MS)} in its own vitest config — copy apps/api/vitest.config.ts.`,
    ).toEqual([]);
  });

  it('has no spec opting back out with a below-floor timeout argument', () => {
    const offenders = containerSpecs().flatMap(({ relativePath, source }) => {
      const found: string[] = [];
      TIMED_CALL.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TIMED_CALL.exec(source)) !== null) {
        const open = source.indexOf('(', match.index + match[0].length - 1);
        const close = matchParen(source, open);
        if (close < 0) continue;
        const args = source.slice(open + 1, close);
        // The timeout, if any, is what follows the callback's closing brace.
        const tail = args.slice(args.lastIndexOf('}') + 1);
        const timeout = /^\s*,\s*([0-9][0-9_]*)\s*,?\s*$/.exec(tail);
        if (!timeout) continue;
        const value = Number(timeout[1]!.replaceAll('_', ''));
        if (value >= FLOOR_MS) continue;
        const line = source.slice(0, match.index).split('\n').length;
        found.push(`${relativePath}:${String(line)} ${match[2]} ${String(value)}`);
      }
      return found;
    });

    expect(
      offenders,
      `A container-backed case may not be given LESS than the package floor of ${String(FLOOR_MS)} ms: delete the argument and let the vitest config apply, or raise it above the floor if this case genuinely needs longer.`,
    ).toEqual([]);
  });
});
