/**
 * D113 — the team-participation seam cannot silently reopen.
 *
 * The same bug was found three times (B-18, B-19, B-21): a read keys a
 * `contest_participations` row on `user_id = you` to answer "is this person IN
 * this contest / what may they see / count them", which in a TEAM contest
 * (D99) is only the captain — the member who pressed Join. Every other member
 * competes on that same row, so keyed on `user_id` the read wrongly excludes
 * two thirds of every team (404 on private problems, a monitor that named the
 * captain, a spoiler thread that reached only captains).
 *
 * B-21 introduced `actingParticipationWhere` as the correct predicate. This is
 * a SOURCE-SCAN guard, in the shape of `route-marker-coverage.spec.ts`: it
 * fails if a NEW `contest_participations … user_id` lookup appears outside the
 * sanctioned predicate module and the audited allowlist below. A developer who
 * adds one has exactly two legal moves, both named in the failure message:
 * route the read through `actingParticipationWhere` (the one source of truth),
 * or add an allowlist entry here with the reason it is team-correct or
 * genuinely individual-only — a decision a reviewer has to make on purpose.
 *
 * The allowlist doubles as the ledger of every site that touches the seam.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const scanRoots = [join(testDir, '..', 'src'), join(repoRoot, 'packages')];

/**
 * The modules that DEFINE the seam's predicates. Any `user_id` clause here IS
 * the source of truth (or the exact-user resolver the truth is built from),
 * so it is exempt by definition rather than by allowlist entry.
 */
const SANCTIONED_MODULES = new Set([
  'apps/api/src/authz/problem.visibility.ts', // actingParticipationWhere — the shared read predicate
  'apps/api/src/authz/participation.ts', // actingParticipations (current membership) + listParticipations (exact user, by design)
]);

/**
 * Every OTHER site that keys a participation on `user_id`, keyed by
 * `relativePath::enclosingFunction`, each carrying why it is not the bug.
 * A NEW site (a new function) trips the test; so does removing an audited one
 * (a stale entry), which keeps this list an honest census of the seam.
 */
const ALLOWLIST: Record<string, string> = {
  // --- team-aware: the read already accounts for every member ---
  'apps/api/src/authz/contest.access.ts::computeScoreboard':
    'Full-board build (all participations of the contest, not actor-keyed); the user join is the row-holder label, replaced by the team name via the D99 sidecar.',
  'apps/api/src/authz/contest.access.ts::assertMembersFree':
    'The one-entry-per-contest invariant, team-aware: matches the members OR any team they are on (D99/D101).',
  'apps/api/src/authz/team.access.ts::assertAddedMembersFree':
    'The same invariant on the roster PATCH path, team-aware (mine OR their teams) — D101.',
  'apps/api/src/authz/team.access.ts::eligibilityFor':
    'Reads the whole contest board (all participations) to compute join eligibility; the userId marks who is spoken for, resolved against team membership.',
  'apps/api/src/authz/contest.clarifications.ts::broadcastRecipientsQuery':
    'Announcement/answer recipients: unions in team_members so every member is told, not the captain alone (B-21).',
  'apps/api/src/authz/contest.monitor.ts::participantsOnline':
    'Raw-SQL union of the row-holder and team_members (D101): counts PEOPLE online, all members, not one per squad.',
  'apps/api/src/authz/contest.similarity.ts::loadCandidates':
    'Left-joins teams and labels by team name (D99): three members\u2019 attempts are one team\u2019s, not three suspicious competitors.',
  // --- keyed by team_id or one participation row, not by actor membership ---
  'apps/api/src/authz/contest.access.ts::joinAsTeam':
    'Team join path: reads/writes the ONE team row by team_id; userId is the row-holder it stamps.',
  'apps/api/src/authz/contest.access.ts::enterTeam':
    'Team entry: seats every member and reads the team row by team_id; userId is who pressed Join.',
  'apps/api/src/authz/contest.access.ts::teamParticipation':
    'Reads a single team\u2019s participation by team_id; userId is the holder, not a membership filter.',
  // --- genuinely individual-only: correct as-is ---
  'apps/api/src/authz/contest.access.ts::setDisqualified':
    'DQ of a SPECIFIC person, keyed by the captain\u2019s username (D37/D99 residual): moves that one row on purpose.',
  'apps/api/src/authz/contest.similarity.ts::countParticipants':
    'count(distinct user_id) is one per participation row = one per TEAM: the count of competitors, which is correct.',
  'apps/api/src/authz/participant-orgs.ts::loadParticipantOrgs':
    'Captain-keyed school column for INDIVIDUAL contests; results.service skips it entirely for team contests (the team\u2019s org is used).',
  'apps/api/src/authz/rating.service.ts::rankedFieldFor':
    'Individual Glicko-2 rating field; a team has no per-user rating (D99: no team virtual replay), so the individual key is intended.',
  'apps/api/src/authz/team.access.ts::contestsOf':
    'Contests a team is in, scoped by team_id; the user join is the row-holder\u2019s name for display.',
  'packages/db/src/contest-stats.ts::noteContestVerdict':
    'Solver attribution via participation_id \u2192 the row\u2019s user_id: one solver per participation (= per team), which is the unit the stat counts.',
  'packages/db/src/contest-stats.ts::recomputeContestProblemStats':
    'Rebuilds solver set/count via participation_id: count(distinct part.user_id) is one per participation (= per team), correct.',
};

const DRIZZLE = /contestParticipations\.userId/;
const RAWSQL = /part\.user_id/; // raw-SQL alias convention for a joined participation
const DECL =
  /^\s*(?:export\s+)?(?:private\s+|public\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/;
const NOT_A_DECL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'and', 'or', 'eq', 'ne', 'sql', 'select',
  'from', 'where', 'inArray', 'isNull', 'not', 'count', 'values', 'set', 'map', 'filter', 'get',
  'some', 'find', 'insert', 'update', 'delete', 'join', 'innerJoin', 'leftJoin', 'forEach', 'new',
  // `notInArray` for `inArray`'s reason: a drizzle operator, never a declaration.
  // Without it a `notInArray(contestParticipations.userId, …)` reads as its own
  // "function", and the hit is attributed to the operator rather than to the
  // audited function that contains it — a census entry that names nothing.
  'notInArray',
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
}

function scan(): Hit[] {
  const files = scanRoots.flatMap((r) => walk(r));
  const hits: Hit[] = [];
  for (const file of files) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || isComment(line)) continue;
      if (!DRIZZLE.test(line) && !RAWSQL.test(line)) continue;
      const fn = enclosingFunction(lines, i);
      hits.push({ key: `${rel}::${fn}`, file: rel, fn, line: line.trim() });
    }
  }
  return hits;
}

describe('team-participation invariant (D113)', () => {
  const hits = scan();

  it('finds the seam at all (the scan is not silently matching nothing)', () => {
    // A refactor that renamed the column would make this test pass vacuously;
    // pin a floor so a broken scanner is a red test, not a green one.
    expect(hits.length).toBeGreaterThanOrEqual(15);
  });

  it('every participation-by-user_id read is sanctioned or audited', () => {
    const offenders = hits.filter(
      (h) => !SANCTIONED_MODULES.has(h.file) && !(h.key in ALLOWLIST),
    );
    const message =
      offenders.length === 0
        ? ''
        : [
            'A `contest_participations … user_id` read appeared outside the sanctioned',
            'predicate module and the audited allowlist. In a TEAM contest (D99) this',
            'names only the captain and excludes every other member — the bug B-18,',
            'B-19 and B-21 each found. Two legal moves:',
            '  1. Route the read through `actingParticipationWhere` (problem.visibility.ts).',
            '  2. If it is genuinely team-correct or individual-only, add an entry to',
            '     ALLOWLIST in this file with the reason (it becomes the audit record).',
            '',
            ...offenders.map((o) => `  - ${o.key}\n      ${o.line}`),
          ].join('\n');
    expect(offenders, message).toEqual([]);
  });

  it('the allowlist has no stale entries (it stays an honest census)', () => {
    const present = new Set(hits.map((h) => h.key));
    const stale = Object.keys(ALLOWLIST).filter((k) => !present.has(k));
    expect(
      stale,
      `Allowlisted sites that no longer exist — delete these entries:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('the sanctioned predicate is still team-aware (the source of truth holds)', () => {
    const src = readFileSync(join(testDir, '..', 'src', 'authz', 'problem.visibility.ts'), 'utf8');
    expect(src).toMatch(/export function actingParticipationWhere/);
    // It must reach team membership, or it is `user_id = you` under a new name.
    const body = src.slice(src.indexOf('export function actingParticipationWhere'));
    const fn = body.slice(0, body.indexOf('\n}'));
    expect(fn).toMatch(/teamMembers/);
    expect(fn).toMatch(/contestParticipations\.teamId/);
  });
});
