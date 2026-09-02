/**
 * The machinery a D113-shaped source-scan guard is made of.
 *
 * Three of these guards now exist — `team-participation-invariant.spec.ts`
 * (D113, "is this person in this contest?"), `name-disclosure-guard.spec.ts`
 * (D198, "may this reader see a child's name?") and
 * `registration-guard.spec.ts` (D201, "who may mint an account?") — and every
 * one of them asks the same structural question: *which functions in this
 * product touch this seam, and does each of them either route through the one
 * sanctioned predicate or hold an audited entry saying why not?*
 *
 * The second guard copied the first's scan by hand. This module is what stops
 * the third from being a third copy: a bug in `enclosingFunction` fixed in one
 * copy and not the others is a guard that silently stops seeing a file, which
 * is the failure mode a census guard exists to prevent in the first place.
 *
 * `team-participation-invariant.spec.ts` is deliberately NOT migrated here in
 * this slot. Its scan has no notion of a routed body (a participation read is
 * sanctioned by WHERE it lives, not by what its function also calls), so
 * moving it would mean widening this module for one caller and re-proving a
 * guard that is not otherwise being touched. Recorded rather than left to be
 * wondered about.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));

/** The repository root, from this file. */
export const repoRoot = join(testDir, '..', '..', '..');

/**
 * Everything a guard scans: the API's own source and every workspace package.
 *
 * `packages/` is in the list because a rule the API honours and a package
 * quietly breaks is the same failure one directory over — `@duckoj/db` holds
 * the schema, and a helper there that reads a column is as much a surface as
 * a controller is.
 */
export const scanRoots = [join(testDir, '..', 'src'), join(repoRoot, 'packages')];

/**
 * A declaration header: `function foo(`, `async bar(`, `private baz(`,
 * `export const qux = (` is deliberately NOT matched — an arrow assigned to a
 * const is attributed to whatever named declaration encloses it, which for a
 * top-level const is `(top-level)`.
 */
const DECL =
  /^\s*(?:export\s+)?(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/;

/**
 * Words that match `DECL` and are not declarations.
 *
 * Every one of these is a call or a keyword that happens to be followed by an
 * open bracket at the start of a line — `and(`, `eq(`, `sql(` on a wrapped
 * drizzle expression, `if (`, `return (`. Left unfiltered they would make
 * `enclosingFunction` report the last SQL operator above the hit instead of
 * the function it is in, and every allowlist key would be junk.
 */
const NOT_A_DECL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'and', 'or', 'eq', 'ne', 'sql', 'select',
  'from', 'where', 'inArray', 'isNull', 'not', 'count', 'values', 'set', 'map', 'filter', 'get',
  'some', 'find', 'insert', 'update', 'delete', 'join', 'innerJoin', 'leftJoin', 'forEach', 'new',
  'notInArray', 'expect', 'push', 'slice',
]);

/** Every non-spec TypeScript file under `dir`. */
export function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Whether a line is prose rather than code.
 *
 * Every one of these guards is enforced by a file that describes the rule it
 * enforces, and a doc comment naming the forbidden symbol must not red the
 * test that forbids it.
 */
export function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('--') || t.startsWith('/*');
}

/**
 * The name this line declares, or `undefined`.
 *
 * **A statement is not a declaration, and telling them apart is what the
 * trailing `;` is for.** `DECL` matches any identifier followed by an open
 * bracket at the start of a line, so a one-line call statement —
 * `assertRegistrationOpen(policy, actor);`, `presentName(audience, row);` —
 * looks exactly like a function header to it. Without this rule the very call
 * a guard scans FOR becomes the "enclosing function" of every hit below it,
 * and the allowlist fills up with keys like `auth.service.ts::assertRegistrationOpen`
 * — measured, in this slot, on the first run of D201's guard.
 *
 * A declaration header ends with `{`, or with `(`/`,` where the parameter list
 * wraps, or with a return-type colon. It never ends with a semicolon.
 */
function declaredName(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  if (line.trimEnd().endsWith(';')) return undefined;
  const m = line.match(DECL);
  if (!m || m[1] === undefined || NOT_A_DECL.has(m[1])) return undefined;
  return m[1];
}

/**
 * The nearest declaration at or above `index`, or `(top-level)`.
 *
 * **A closing brace in column 1 ends the search.** A one-file CLI is mostly
 * module-level statements — `scripts/seed-problem.ts` does its whole job
 * inside a top-level `try {` — and without this rule the scan walks straight
 * past the end of the last function it saw and attributes that work to it. The
 * census then names `seed-problem.ts::readProblemMeta` as the thing that mints
 * the `system` account, which is not where the code is and sends the next
 * reader to the wrong function. Measured, in this slot, on D201's first run.
 */
export function enclosingFunction(lines: string[], index: number): string {
  for (let j = index; j >= 0; j--) {
    const name = declaredName(lines[j]);
    if (name !== undefined) return name;
    if (lines[j]?.startsWith('}') === true) return '(top-level)';
  }
  return '(top-level)';
}

/** The lines from the enclosing declaration to the next one at the same depth. */
export function bodyOf(lines: string[], index: number, fn: string): string {
  let start = 0;
  for (let j = index; j >= 0; j--) {
    if (declaredName(lines[j]) === fn) {
      start = j;
      break;
    }
  }
  let end = lines.length;
  for (let j = index + 1; j < lines.length; j++) {
    if (declaredName(lines[j]) !== undefined) {
      end = j;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export interface Hit {
  /** `relative/path.ts::enclosingFunction` — the key an allowlist is written in. */
  key: string;
  file: string;
  fn: string;
  line: string;
  /** Whether the enclosing function consults the sanctioned predicate. */
  routed: boolean;
}

/**
 * Every non-comment line matching `pattern`, attributed to its function.
 *
 * `routed` is decided over the enclosing function's whole BODY, not over the
 * matched line, and that is not a convenience: the read and the predicate that
 * governs it are necessarily different lines — a
 * `.select({ displayName: schema.users.displayName })` and the
 * `presentName(...)` that projects it can be twenty lines apart.
 *
 * `roots` defaults to {@link scanRoots}. D201 passes `scripts/` in as well,
 * because two of the three things in this product that can mint an account
 * live there (D19's `bootstrap:admin`, and the seeder's `system` row) and a
 * census that could not see them would be a census of two thirds of the seam.
 */
export function scanSources(
  pattern: RegExp,
  routed: RegExp,
  roots: readonly string[] = scanRoots,
): Hit[] {
  const hits: Hit[] = [];
  for (const file of roots.flatMap((r) => walk(r))) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || isComment(line) || !pattern.test(line)) continue;
      const fn = enclosingFunction(lines, i);
      const body = bodyOf(lines, i, fn);
      hits.push({ key: `${rel}::${fn}`, file: rel, fn, line: line.trim(), routed: routed.test(body) });
    }
  }
  return hits;
}
