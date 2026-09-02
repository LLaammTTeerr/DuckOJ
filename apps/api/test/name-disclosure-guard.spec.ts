/**
 * D198 — the name-disclosure policy cannot be honoured by six surfaces and
 * forgotten by the seventh.
 *
 * That failure is not hypothetical here; it is the shape of the finding that
 * created this slot. D188 gated `GET /users`, D191 gated the org roster, and
 * B-35 then measured a THIRD bulk list of people that neither ruling had
 * looked at — `GET /contests/{key}/scoreboard`, 142 usernames in 159
 * anonymous requests — and the chain that dereferenced them into 264 real
 * names. A rule spread across surfaces drifts the first time a surface is
 * added; a rule with a source-scan guard does not.
 *
 * So this is a SOURCE-SCAN guard in the shape of D113's
 * `team-participation-invariant.spec.ts` and
 * `route-marker-coverage.spec.ts`, over three separate claims D197 makes:
 *
 *   1. **The projection.** Every read of `users.display_name` or `users.about`
 *      outside the sanctioned module must route through `presentName` /
 *      `presentAbout`, or be an audited allowlist entry saying why it is a
 *      write, an echo of what the caller just uploaded, or the reader's own
 *      row.
 *   2. **The haystack.** `users.search_fold` carries the display name, so a
 *      reference to it outside the sanctioned module is a search that can
 *      confirm a withheld name one prefix at a time — the oracle that would
 *      make the whole policy theatre.
 *   3. **One switch, read in one place.** `config.nameDisclosure` may be
 *      branched on in exactly one module. A second reader is a second policy.
 *
 * A developer who trips this has exactly two legal moves, both named in the
 * failure message: route the read through the predicate, or add an entry here
 * with the reason — a decision a reviewer has to make on purpose. A REMOVED
 * site fails as a stale entry, so the allowlist stays an honest census of
 * every place in this product that can print a child's name.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const scanRoots = [join(testDir, '..', 'src'), join(repoRoot, 'packages')];

/**
 * The module that DEFINES the policy. Every reference to the columns, to the
 * search column and to the config switch here IS the source of truth, so it is
 * exempt by definition rather than by allowlist entry.
 *
 * `config.schema.ts` is the parser: it names the variable and the type, and
 * decides nothing.
 */
const SANCTIONED = new Set([
  'apps/api/src/authz/name-disclosure.ts',
  'apps/api/src/config/config.schema.ts',
  // The schema DECLARES the columns. `users.search_fold` is defined here as
  // `username || ' ' || display_name`, folded (migration 0047), and that
  // definition is the fact the policy is written against rather than a read of
  // anybody's name.
  'packages/db/src/schema/identity.ts',
]);

/**
 * Every OTHER site that touches a person's identity columns, keyed by
 * `relativePath::enclosingFunction`.
 *
 * A site that calls `presentName` or `presentAbout` in the same function is
 * not listed — it is routed, which is the point — so what remains here is the
 * census of everything the projection deliberately does NOT cover, each with
 * the reason.
 */
const ALLOWLIST: Record<string, string> = {
  'apps/api/src/authz/user.access.ts::(top-level)':
    'PUBLIC_COLUMNS — the shared select list, a top-level const rather than a read. Its two consumers, `list` and `getByUsername`, both project through `toSummary(row, audience)`, and `getByUsername` also projects `about`; the projection is asserted end to end in `name-disclosure.spec.ts`.',
};

/**
 * What is NOT in the allowlist, and why it never appears:
 *
 * - **Writes.** Registration, the admin/bootstrap create and D61's bulk import
 *   all SET a display name — the account's own, or the staff member's own
 *   uploaded file. The scan matches drizzle COLUMN references
 *   (`schema.users.displayName`), so an insert's `{ displayName: value }` is
 *   not a hit and does not need excusing.
 * - **The renderers.** `statements/results.ts`, `statements/seats.ts`,
 *   `contests/results-csv.ts` and `progressCsv` print `row.displayName` off a
 *   DTO their caller already projected. They never touch the column, which is
 *   the property that makes them safe: an export cannot disagree with the
 *   policy because it has nothing of its own to disagree with.
 * - **`GET /auth/me`.** `toMe` maps `typeof schema.users.$inferSelect` — the
 *   reader's own row, by construction. You always see yourself.
 */

/** The identity columns, as drizzle spells them. */
const IDENTITY = /(?:schema\.)?users\.(?:displayName|about)\b/;
/** The generated column that carries the display name into the search index. */
const HAYSTACK = /(?:schema\.)?users\.searchFold\b/;
/** The switch itself. */
const SWITCH = /\bnameDisclosure\b/;
/** Routed through the predicate. */
const ROUTED = /\bpresent(?:Name|About)\s*\(|\bseesIdentity\s*\(|\bnameSearchColumn\s*\(/;

const DECL =
  /^\s*(?:export\s+)?(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/;
const NOT_A_DECL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'and', 'or', 'eq', 'ne', 'sql', 'select',
  'from', 'where', 'inArray', 'isNull', 'not', 'count', 'values', 'set', 'map', 'filter', 'get',
  'some', 'find', 'insert', 'update', 'delete', 'join', 'innerJoin', 'leftJoin', 'forEach', 'new',
  'notInArray', 'expect', 'push', 'slice',
]);

function walk(dir: string, out: string[] = []): string[] {
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

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('--') || t.startsWith('/*');
}

function enclosingFunction(lines: string[], index: number): string {
  for (let j = index; j >= 0; j--) {
    const decl = lines[j];
    if (decl === undefined) continue;
    const m = decl.match(DECL);
    if (m && m[1] !== undefined && !NOT_A_DECL.has(m[1])) return m[1];
  }
  return '(top-level)';
}

interface Hit {
  key: string;
  file: string;
  fn: string;
  line: string;
  routed: boolean;
}

/**
 * `routed` is decided over the enclosing function's whole body, not over the
 * matched line: a `.select({ displayName: schema.users.displayName })` and the
 * `presentName(...)` that projects it are necessarily different lines.
 */
function scan(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of scanRoots.flatMap((r) => walk(r))) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || isComment(line) || !pattern.test(line)) continue;
      const fn = enclosingFunction(lines, i);
      const body = bodyOf(lines, i, fn);
      hits.push({ key: `${rel}::${fn}`, file: rel, fn, line: line.trim(), routed: ROUTED.test(body) });
    }
  }
  return hits;
}

/** The lines from the enclosing declaration to the next one at the same depth. */
function bodyOf(lines: string[], index: number, fn: string): string {
  let start = 0;
  for (let j = index; j >= 0; j--) {
    const m = lines[j]?.match(DECL);
    if (m && m[1] === fn && !NOT_A_DECL.has(m[1])) {
      start = j;
      break;
    }
  }
  let end = lines.length;
  for (let j = index + 1; j < lines.length; j++) {
    const m = lines[j]?.match(DECL);
    if (m && m[1] !== undefined && !NOT_A_DECL.has(m[1])) {
      end = j;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('the disclosure policy has ONE implementation (D197/D198)', () => {
  const identity = scan(IDENTITY);

  it('finds the identity columns at all (the scan is not vacuously green)', () => {
    // A rename that made this scan match nothing would turn every assertion
    // below into a tautology. Pin a floor instead: six surfaces read this
    // column today — the directory, the profile, the org roster, team rosters
    // (twice), the progress grid and the results export.
    expect(identity.length).toBeGreaterThanOrEqual(6);
    // And at least one of them is actually routed, so `routed` is not a
    // predicate that quietly matches nothing.
    expect(identity.filter((h) => h.routed).length).toBeGreaterThanOrEqual(4);
  });

  it('every read of a person\u2019s name or free text is projected or audited', () => {
    const offenders = identity.filter(
      (h) => !SANCTIONED.has(h.file) && !h.routed && !(h.key in ALLOWLIST),
    );
    const message =
      offenders.length === 0
        ? ''
        : [
            'A read of `users.display_name` or `users.about` appeared outside the',
            'sanctioned module, without routing through the D197 predicate and',
            'without an audited allowlist entry.',
            '',
            'On a provincial host that column is a twelve-year-old\u2019s real name, and',
            'B-35 measured 264 of 481 accounts named to an anonymous stranger through',
            'exactly this kind of surface. Two legal moves:',
            '',
            '  1. project it — `presentName(audience, row)` / `presentAbout(audience, row)`,',
            '     with the audience from `nameAudience(db, policy, actor)`; or',
            '  2. add an entry to ALLOWLIST in this file saying why it is a write, an',
            '     echo of the caller\u2019s own upload, the reader\u2019s own row, or a pure',
            '     renderer over an already-projected DTO.',
            '',
            ...offenders.map((o) => `  ${o.key}\n      ${o.line}`),
          ].join('\n');
    expect(message).toBe('');
  });

  it('keeps the allowlist an honest census — no stale entries', () => {
    const seen = new Set(identity.map((h) => h.key));
    const stale = Object.keys(ALLOWLIST).filter((key) => !seen.has(key));
    expect(
      stale.length === 0
        ? ''
        : `Allowlist entries that no longer match any source line (remove them):\n  ${stale.join('\n  ')}`,
    ).toBe('');
  });

  it('lets nobody but the policy module reach the search column', () => {
    // `users.search_fold` is `username || ' ' || display_name`, folded (0047).
    // A `q` matched against it for a reader who is being shown handles is a
    // name-recovery oracle: `q=ng`, `q=ngu`, `q=nguye`, each answer confirming
    // another letter of the name the projection just took away. The one legal
    // haystack is `nameSearchColumn(audience)`.
    const offenders = scan(HAYSTACK).filter((h) => !SANCTIONED.has(h.file));
    expect(
      offenders.length === 0
        ? ''
        : [
            '`users.searchFold` was referenced outside `name-disclosure.ts`. Search the',
            'haystack the audience is entitled to instead:',
            '',
            '  nameSearchWhere(nameSearchColumn(audience), q)',
            '',
            ...offenders.map((o) => `  ${o.key}\n      ${o.line}`),
          ].join('\n'),
    ).toBe('');
  });

  it('is read in exactly one place, which is what makes it one policy', () => {
    // The dashboard REPORTS the rung (F-40: an operator must be able to see
    // that the variable reached the process) and does it through `policyOf`,
    // the same fail-closed reader every access service uses — so it cannot
    // report a rung the services are not on. That is the only site outside the
    // policy module allowed to name the switch at all.
    const REPORTERS = new Set(['apps/api/src/authz/dashboard.access.ts::snapshot']);
    const offenders = scan(SWITCH).filter(
      (h) =>
        h.file.startsWith('apps/api/src/') && !SANCTIONED.has(h.file) && !REPORTERS.has(h.key),
    );
    expect(
      offenders.length === 0
        ? ''
        : [
            '`nameDisclosure` was read outside `name-disclosure.ts`. A second reader is a',
            'second policy: pass the config to `policyOf(config)` and let',
            '`nameAudience(db, policy, actor, { authority })` decide.',
            '',
            ...offenders.map((o) => `  ${o.key}\n      ${o.line}`),
          ].join('\n'),
    ).toBe('');
  });
});
