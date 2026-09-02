/**
 * Remove the litter this instance accumulated while it was the loop's
 * rehearsal ground — and NOTHING else.
 *
 *   corepack pnpm tsx scripts/cleanup-test-data.ts               # dry run, live
 *   corepack pnpm tsx scripts/cleanup-test-data.ts --url postgres://...
 *   corepack pnpm tsx scripts/cleanup-test-data.ts --print-plan  # the SQL, no connection
 *   CONFIRM=yes corepack pnpm tsx scripts/cleanup-test-data.ts --apply
 *   corepack pnpm tsx scripts/cleanup-test-data.ts --only f56probe1,b35-probe-…
 *                                                   # narrow to named rows
 *
 * ## Why this script is shaped the way it is
 *
 * D11 keeps submissions and grading history FOREVER, and migration 0040 made
 * `contest_participations.contest_id` RESTRICT so a contest with entrants
 * cannot be dropped by accident. Both say the same thing: a judge must never
 * silently lose a record. So this script inverts the usual cleanup posture.
 *
 * 1. **A row is test litter only because its NAME says so.** The allow-list
 *    below is a fixed set of prefixes, each with the loop that minted it.
 *    There is no "looks unused", no "created before date X", no orphan
 *    heuristic — those are the rules that eventually eat a real school.
 * 2. **The demo set is pinned as an explicit DENY**, checked BEFORE the
 *    patterns and again as an assertion after classification. `duckadmin`,
 *    `hocsinh1`, `system`, the five Vietnamese content problems and
 *    `thu-nghiem-1` can never enter the delete set, whatever a pattern says.
 * 3. **A test row that a KEPT row depends on is refused, with the reason
 *    printed.** A test contest a real pupil entered, a test user who created
 *    a kept problem, a test org on a kept contest's allow-list: refused. The
 *    operator resolves those by hand or not at all.
 * 4. **Refusals propagate to a fixpoint.** Refusing a contest can make a user
 *    undeletable (they entered a now-kept contest), which can make an org
 *    undeletable, and so on. The blocker pass repeats until the delete set
 *    stops shrinking, so the last pass sees the same world the deletes will.
 * 5. **Dry run is the default and is enforced by Postgres**, not by a branch
 *    in this file: the planning transaction runs under
 *    `SET TRANSACTION READ ONLY`, so a DELETE that leaked into the plan would
 *    error rather than run. Deleting needs `--apply` AND `CONFIRM=yes`, and
 *    then classification, blockers and deletes all happen inside ONE
 *    read-write transaction — the plan is never carried over from the
 *    previous process, because the API is still up and still writing.
 *
 * ## What it deliberately does NOT refuse
 *
 * A test account's submissions to a KEPT problem are deleted. On this
 * instance that is ~730 rows against `tong-hai-so`, `aplusb` and `hello`:
 * the rehearsal loops submitted to the demo problems on purpose. Nothing
 * real depends on them — a submission points AT a problem, the problem does
 * not point back — but the problem's solved/attempted counters DO change, so
 * the inventory prints that as a warning rather than burying it. Refusing on
 * it instead would refuse every test user on the instance and leave the
 * script useless, which is the outcome that guarantees the litter stays.
 *
 * ## Afterwards
 *
 * Run `scripts/integrity-check.ts --live` and expect it clean. That is the
 * post-condition: this script removes the notifications whose jsonb payload
 * would otherwise name a deleted row, and integrity-check is what proves it.
 * Content-addressed `packages` / `package_files` rows are left alone; an
 * unreferenced package is inert and shared by hash.
 *
 * Exit codes: 0 plan printed / deletions applied, 1 nothing to do, 2 refused
 * to run.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Prefix on every line this script asks the database to say back to it. */
const MARK = 'duckoj-cleanup';

export type Kind = 'user' | 'contest' | 'problem' | 'org' | 'team' | 'set';

export interface Pattern {
  readonly kind: Kind;
  /** A POSIX regex matched against the row's own natural key. */
  readonly regex: string;
  /** WHICH loop minted rows with this shape — the audit trail for the rule. */
  readonly why: string;
}

/**
 * The allow-list. A row is a candidate for deletion if and ONLY if its
 * natural key (`users.username`, `contests.key`, `problems.code`,
 * `organizations.slug`) matches one of these. Adding a pattern here is the
 * only way to widen what this script can touch.
 *
 * `teams` and `problem_sets` carry no distinguishing name of their own — the
 * live instance holds 44 teams called "Team Alpha"/"Team Bravo" and 20 sets
 * all slugged `tuan-1` — so they are classified by their OWNING ORGANIZATION
 * instead. That is derived, but it is not a heuristic: the org matched a
 * pattern explicitly, and a team whose org is later refused is refused too.
 *
 * ## What the slot patterns claim, and what they deliberately do not (D153)
 *
 * The loop renamed its bug-hunt slots from `bh<n>` to `b<n>` partway through,
 * and nothing here noticed: B-35 minted `b35-probe-1788313721` on the live
 * judge and it matched NO pattern in this file, because `^bh[0-9]+` wants the
 * `h`. So there is now a `^b[0-9]+-` pattern for each of the four kinds,
 * beside the `^bh[0-9]+` ones rather than replacing them — `bh…` rows are
 * still on the instance.
 *
 * **`^b[0-9]+-` claims exactly this**: a name that begins with `b`, then one
 * or more digits, then a HYPHEN — `b35-probe-…`, `b36-anything`. The hyphen
 * is load-bearing and is the difference between this pattern and its `bh`
 * neighbour: `^b[0-9]+` with no separator would also claim `b1nh`, an
 * ordinary Vietnamese-looking username a province could plausibly hold, and
 * D153's whole posture is that a rule which can eat a real school is worse
 * than litter left behind. `^bh[0-9]+` is dashless only because the live rows
 * `bh10probe1`, `bh30probe` and `bh34admin` prove that loop wrote names that
 * way; no such evidence exists for the `b<n>` slots, so this one is tighter.
 *
 * **It does NOT claim**, and these are recorded so nobody hunts them again:
 *
 * - `b<digits>` with no hyphen (`b1nh`, `b12x`) — see above.
 * - `b-` or `bXX-` with no digits: the slot number is what makes the name a
 *   slot's, and a bare `b-` prefix is a word.
 * - `f<n>-` with a hyphen (`f50-`, `f55-`). F-55 recorded that no F slot had
 *   ever minted a live row under its own name and that the moment one did,
 *   the pattern should be added with the row in its `why`. **F-56 is that
 *   moment, and the shape is not the one F-55 guessed**: the row is
 *   `f56probe1`, with no separator, because the controller wrote it the way
 *   `probe1` was written rather than the way `b35-probe-…` was. So the new
 *   entry is `^f[0-9]+probe` — `f`, digits, then the literal word `probe` —
 *   and NOT `^f[0-9]+-`, which would still match nothing, and not
 *   `^f[0-9]+`, which claims every future name beginning with a letter and a
 *   number. Nothing a province could plausibly hold begins `f<digits>probe`.
 *   Pattern what was minted, not what a slot might mint: a rule guarding rows
 *   nobody has ever written is a deletion rule with no audit trail behind it,
 *   which is what the `why` field on every entry above exists to prevent.
 * - Team and problem-set slugs of the form `fe42-b33a-…` (B-33's). They are
 *   NOT reached by any `^b` pattern and do not need to be: teams and sets are
 *   classified by their owning organization, and that org (`fe42-truong`)
 *   matches `^fe[0-9]+-` already.
 *
 * Live survey behind this, read-only on the production database on
 * 2026-09-02: every `users.username`, `organizations.slug`, `contests.key`
 * and `problems.code` that matches none of the patterns below is now exactly
 * the DENY set — `system`, `duckadmin`, `hocsinh1`, `thu-nghiem-1`, the five
 * Vietnamese problems, `aplusb`, `hello` — and nothing else. Before
 * `^b[0-9]+-`, `b35-probe-1788313721` was the one row in that gap.
 *
 * That account also left 22 `rate_events` rows keyed `user:487`. F-55 left
 * that table unmodelled on the reasoning that the classification "cannot
 * actually prove" such rows belong to the account being deleted. **F-56
 * measured them, and that turned out to be true of exactly one purpose**, so
 * the table is now modelled with that purpose excluded — see the
 * `rate_events` step in `DELETE_STEPS` for the argument. The rest of F-55's
 * sentence stands and is why this is a tidy-up rather than a fix:
 * `rate_events` has no foreign key to `users`, a leftover row blocks nothing
 * and discloses nothing, and `expired-rows.sweeper.ts` removes the table by
 * `created_at` at a 24-hour retention regardless.
 */
export const PATTERNS: readonly Pattern[] = [
  {
    kind: 'user',
    regex: '^e2e',
    why: 'scripts/e2e-*.ts mint e2e<role><epoch-ms> accounts per run',
  },
  { kind: 'user', regex: '^probe', why: 'one-off reachability probes (probe1, probe17880011731)' },
  {
    kind: 'user',
    regex: '^routercheck$',
    why: 'the single account the router smoke test registered',
  },
  { kind: 'user', regex: '^bh[0-9]+', why: 'B-loop rehearsals: bh1-…, bh14-s1-…, bh28-k…' },
  {
    kind: 'user',
    regex: '^b[0-9]+-',
    why: 'B-loop slots after the bh→b rename: b35-probe-<epoch> (B-35)',
  },
  {
    kind: 'user',
    regex: '^f[0-9]+probe',
    why: 'F-slot reachability probes: f56probe1 (F-56, the controller\u2019s proof that registration was open)',
  },
  { kind: 'user', regex: '^fe[0-9]+', why: 'FE-loop front-end rehearsals' },
  { kind: 'user', regex: '^c1-', why: 'C1 soak accounts (c1-soak-<key>-<n>)' },
  { kind: 'user', regex: '^rehearse-', why: 'scripts/rehearsal.ts contest-day rehearsals' },
  { kind: 'user', regex: '^cd-', why: 'contest-day drill accounts' },
  { kind: 'user', regex: '^mcp-', why: 'MCP server end-to-end and smoke runs' },
  { kind: 'user', regex: '^prep-', why: 'problem-preparation drills' },

  { kind: 'contest', regex: '^e2e', why: 'e2e-contest / e2e-p5 / e2e-p9-freeze rounds' },
  { kind: 'contest', regex: '^probe-', why: 'probe-cup' },
  {
    kind: 'contest',
    regex: '^bh[0-9]+-',
    why: 'B-loop rounds: bh2-dq-…, bh14-qa-…, bh14-ket-qua-…',
  },
  { kind: 'contest', regex: '^b[0-9]+-', why: 'B-loop rounds after the bh→b rename' },
  { kind: 'contest', regex: '^fe[0-9]+-', why: 'FE-loop rounds: fe1-freeze-…, fe6-phone-…' },
  { kind: 'contest', regex: '^cd-', why: 'contest-day drill rounds (cd-icpc-…, cd-open-…)' },
  { kind: 'contest', regex: '^rehearse-', why: 'scripts/rehearsal.ts rounds' },
  { kind: 'contest', regex: '^c1-', why: 'C1 soak rounds' },
  { kind: 'contest', regex: '^mcp-', why: 'MCP end-to-end rounds' },
  { kind: 'contest', regex: '^prep-', why: 'preparation drills' },

  { kind: 'problem', regex: '^e2e', why: 'e2e-sum-…, e2e-cst-…, e2erevtest… fixtures' },
  { kind: 'problem', regex: '^probe-', why: 'probe-math' },
  { kind: 'problem', regex: '^bh[0-9]+-', why: 'B-loop fixtures (bh16-ab-…)' },
  { kind: 'problem', regex: '^b[0-9]+-', why: 'B-loop fixtures after the bh→b rename' },
  { kind: 'problem', regex: '^fe[0-9]+-', why: 'FE-loop fixtures' },
  {
    kind: 'problem',
    regex: '^rehearse-',
    why: 'rehearsal.ts fixtures (rehearse-p1-…, rehearse-p2-…)',
  },
  { kind: 'problem', regex: '^contest-day-', why: 'contest-day drill fixtures (contest-day-ab-…)' },
  { kind: 'problem', regex: '^cd-', why: 'contest-day drill fixtures, short form' },
  { kind: 'problem', regex: '^c1-', why: 'C1 soak fixtures' },
  { kind: 'problem', regex: '^mcp-', why: 'MCP end-to-end fixtures' },
  { kind: 'problem', regex: '^prep-', why: 'prepare-flow drills (prep-<yyyymmdd>-<hhmmss>)' },

  { kind: 'org', regex: '^probe-', why: 'probe-org' },
  { kind: 'org', regex: '^bh[0-9]+-', why: 'B-loop schools (bh14-truong-…, bh19-school-1)' },
  { kind: 'org', regex: '^b[0-9]+-', why: 'B-loop schools after the bh→b rename' },
  { kind: 'org', regex: '^fe[0-9]+-', why: 'FE-loop schools' },
  { kind: 'org', regex: '^rehearse-', why: 'rehearse-school' },
  { kind: 'org', regex: '^cd-', why: 'contest-day drill schools' },
  { kind: 'org', regex: '^c1-', why: 'C1 soak schools' },
  { kind: 'org', regex: '^mcp-', why: 'MCP end-to-end schools' },
  { kind: 'org', regex: '^prep-', why: 'preparation drills' },
];

/**
 * The deny-list — the demo content a province is shown on day one, plus the
 * `system` account migrations write as. Checked BEFORE the patterns and
 * asserted again after the fixpoint. Deny always wins.
 */
export const DENY = {
  user: ['system', 'duckadmin', 'hocsinh1'],
  contest: ['thu-nghiem-1'],
  problem: [
    // The five Vietnamese content problems.
    'tong-hai-so',
    'so-nguyen-to',
    'day-con-tang',
    'duong-di-ngan-nhat',
    'cay-khung-nho-nhat',
    // Seeded by `system`, not by any loop: the smoke problems every fresh
    // database gets and `scripts/e2e-submit.ts` submits to.
    'aplusb',
    'hello',
  ],
  org: [] as string[],
} as const;

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function patternPredicate(kind: Kind, column: string): string {
  const matching = PATTERNS.filter((pattern) => pattern.kind === kind);
  if (matching.length === 0) return 'false';
  return `(${matching.map((pattern) => `${column} ~ ${quote(pattern.regex)}`).join(' or ')})`;
}

/**
 * `--only`'s clause: `true` when the operator named nothing, otherwise
 * membership of the list they named.
 *
 * Emitted for every kind, so the same list restricts users, contests,
 * problems and organizations at once — naming two accounts therefore empties
 * the contest, problem and org sets, which is exactly what "only these two
 * accounts" means.
 */
function onlyPredicate(column: string, only: readonly string[] | undefined): string {
  if (only === undefined) return 'true';
  if (only.length === 0) return 'false';
  return `${column} in (${only.map(quote).join(', ')})`;
}

function denyPredicate(kind: 'user' | 'contest' | 'problem' | 'org', column: string): string {
  const denied = DENY[kind];
  if (denied.length === 0) return 'true';
  return `${column} not in (${denied.map(quote).join(', ')})`;
}

export type BlockerMode =
  /** The row leaves the delete set, with the reason printed. */
  | 'refuse'
  /** The row still goes; what a kept container loses is printed first. */
  | 'disclose';

export interface Blocker {
  readonly id: string;
  /** Which array a hit is removed from (`refuse`) or is reported for. */
  readonly kind: Kind;
  readonly mode: BlockerMode;
  /**
   * A select of `(id, label, reason)` over rows STILL in the candidate set
   * whose deletion would reach a kept row. The arrays in scope are
   * `arr_user`, `arr_contest`, `arr_problem`, `arr_org`, `arr_team`,
   * `arr_set`; "kept" is written `<> all(arr_x)`.
   */
  readonly sql: string;
}

/**
 * Every edge in the live foreign-key graph that runs FROM a kept row INTO the
 * delete set. Two tiers, and the line between them is the whole judgement
 * this script makes (D153):
 *
 * `refuse` — the row leaves the delete set. Three cases, and only three:
 *   1. **Competitive history, in either direction.** A participation, a seat,
 *      a submission, a rating event, a solver row that belongs to a KEPT
 *      person or a KEPT contest. This is what D11 means by "kept forever" and
 *      what migration 0040 made RESTRICT. The brief's two worked examples —
 *      a test account that submitted inside a real round, a real pupil who
 *      entered a test round — are both here.
 *   2. **NO ACTION edges**, which would abort the transaction anyway. Caught
 *      so the operator reads a sentence instead of a Postgres error.
 *   3. **Anything that changes a KEPT row in place or changes its reach** —
 *      deleting a test org would empty a kept contest's organization
 *      allow-list and quietly make it public.
 *
 * `disclose` — the row still goes, and what a kept container loses is printed
 * before the operator can type CONFIRM. These are association rows that
 * depend on BOTH endpoints and die with their container: a membership in a
 * rehearsal school, a question asked inside a drill round, an authoring role
 * on a drill problem. No kept row survives and loses by their deletion.
 *
 * That line was drawn from a measurement, not from taste. Under a single
 * refuse-everything tier this instance produced 258 refusals which reduced to
 * one sentence — "duckadmin touched it" — because the operator account owns
 * every rehearsal school, created every drill problem and asked every drill
 * clarification. 24 orgs, 45 teams, 20 problem sets and 19 contests were
 * permanently undeletable, which ships the litter to the province: the exact
 * outcome this script exists to prevent.
 */
export const BLOCKERS: readonly Blocker[] = [
  {
    id: 'user-entered-kept-contest',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'entered kept contest ' || c.key || ' — deleting the account would erase that entry (CASCADE)' as reason
            from users u
            join contest_participations p on p.user_id = u.id
            join contests c on c.id = p.contest_id
           where u.id = any(arr_user) and c.id <> all(arr_contest)`,
  },
  {
    id: 'user-rated-on-kept-contest',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'carries a rating_event for kept contest ' || c.key || ' — the rating fold replays these' as reason
            from users u
            join rating_event re on re.user_id = u.id
            join contests c on c.id = re.contest_id
           where u.id = any(arr_user) and c.id <> all(arr_contest)`,
  },
  {
    id: 'user-created-kept-contest',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'created kept contest ' || c.key || ' (contests.created_by is NO ACTION)' as reason
            from users u join contests c on c.created_by = u.id
           where u.id = any(arr_user) and c.id <> all(arr_contest)`,
  },
  {
    id: 'user-created-kept-problem',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'created kept problem ' || p.code || ' (problems.created_by is NO ACTION)' as reason
            from users u join problems p on p.created_by = u.id
           where u.id = any(arr_user) and p.id <> all(arr_problem)`,
  },
  {
    id: 'user-created-kept-revision',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'authored a revision of kept problem ' || p.code || ' (problem_revisions.created_by is NO ACTION)' as reason
            from users u
            join problem_revisions pr on pr.created_by = u.id
            join problems p on p.id = pr.problem_id
           where u.id = any(arr_user) and p.id <> all(arr_problem)`,
  },
  {
    id: 'user-created-kept-team',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'created kept team #' || t.id || ' (teams.created_by is NO ACTION)' as reason
            from users u join teams t on t.created_by = u.id
           where u.id = any(arr_user) and t.id <> all(arr_team)`,
  },
  {
    id: 'user-created-kept-problem-set',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'created kept problem set #' || ps.id || ' (problem_sets.created_by is NO ACTION)' as reason
            from users u join problem_sets ps on ps.created_by = u.id
           where u.id = any(arr_user) and ps.id <> all(arr_set)`,
  },
  {
    id: 'user-answered-kept-clarification',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'answered a clarification on kept contest ' || c.key || ' (answered_by is NO ACTION)' as reason
            from users u
            join contest_clarifications cl on cl.answered_by = u.id
            join contests c on c.id = cl.contest_id
           where u.id = any(arr_user) and c.id <> all(arr_contest)`,
  },
  {
    id: 'user-asked-on-kept-contest',
    kind: 'user',
    mode: 'disclose',
    sql: `select u.id, u.username as label,
                 'asked a clarification on kept contest ' || c.key || ' — the question would vanish from it (CASCADE)' as reason
            from users u
            join contest_clarifications cl on cl.asked_by = u.id
            join contests c on c.id = cl.contest_id
           where u.id = any(arr_user) and c.id <> all(arr_contest)`,
  },
  {
    id: 'user-decided-kept-join-request',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'decided a join request for kept org ' || o.slug || ' (decided_by is NO ACTION)' as reason
            from users u
            join org_join_requests jr on jr.decided_by = u.id
            join organizations o on o.id = jr.org_id
           where u.id = any(arr_user) and o.id <> all(arr_org)`,
  },
  {
    id: 'user-on-kept-org-roster',
    kind: 'user',
    mode: 'disclose',
    sql: `select u.id, u.username as label,
                 'is on the roster of kept org ' || o.slug || ' (CASCADE would shrink it)' as reason
            from users u
            join org_members m on m.user_id = u.id
            join organizations o on o.id = m.org_id
           where u.id = any(arr_user) and o.id <> all(arr_org)`,
  },
  {
    id: 'user-on-kept-team-roster',
    kind: 'user',
    mode: 'disclose',
    sql: `select u.id, u.username as label,
                 'is on the roster of kept team #' || t.id || ' (CASCADE would shrink it)' as reason
            from users u
            join team_members tm on tm.user_id = u.id
            join teams t on t.id = tm.team_id
           where u.id = any(arr_user) and t.id <> all(arr_team)`,
  },
  {
    id: 'user-commented-on-kept-problem',
    kind: 'user',
    mode: 'disclose',
    sql: `select u.id, u.username as label,
                 'left a comment on kept problem ' || p.code || ' — the thread would lose it (CASCADE)' as reason
            from users u
            join problem_comments pc on pc.author_id = u.id
            join problems p on p.id = pc.problem_id
           where u.id = any(arr_user) and p.id <> all(arr_problem)`,
  },
  {
    id: 'user-requested-kept-similarity-run',
    kind: 'user',
    mode: 'disclose',
    sql: `select u.id, u.username as label,
                 'requested a similarity run on kept contest ' || c.key || ' — requested_by is nulled; the schema declares SET NULL, so losing the attribution was ruled acceptable when the column was designed' as reason
            from users u
            join similarity_runs sr on sr.requested_by = u.id
            join contests c on c.id = sr.contest_id
           where u.id = any(arr_user) and c.id <> all(arr_contest)`,
  },

  {
    id: 'contest-seated-a-kept-user',
    kind: 'contest',
    mode: 'refuse',
    sql: `select c.id, c.key as label,
                 'kept account ' || u.username || ' holds a seat on it (D104: the seat is the row that says who competed)' as reason
            from contests c
            join contest_seats cs on cs.contest_id = c.id
            join users u on u.id = cs.user_id
           where c.id = any(arr_contest) and u.id <> all(arr_user)`,
  },
  {
    id: 'user-seated-on-kept-contest',
    kind: 'user',
    mode: 'refuse',
    sql: `select u.id, u.username as label,
                 'holds a seat on kept contest ' || c.key || ' — a team member is seated without owning the participation' as reason
            from users u
            join contest_seats cs on cs.user_id = u.id
            join contests c on c.id = cs.contest_id
           where u.id = any(arr_user) and c.id <> all(arr_contest)`,
  },
  {
    id: 'contest-entered-by-kept-user',
    kind: 'contest',
    mode: 'refuse',
    sql: `select c.id, c.key as label,
                 'kept account ' || u.username || ' competed in it — deleting it erases a real record (0040 makes this RESTRICT anyway)' as reason
            from contests c
            join contest_participations p on p.contest_id = c.id
            join users u on u.id = p.user_id
           where c.id = any(arr_contest) and u.id <> all(arr_user)`,
  },
  {
    id: 'contest-rated-a-kept-user',
    kind: 'contest',
    mode: 'refuse',
    sql: `select c.id, c.key as label,
                 'holds a rating_event for kept account ' || u.username as reason
            from contests c
            join rating_event re on re.contest_id = c.id
            join users u on u.id = re.user_id
           where c.id = any(arr_contest) and u.id <> all(arr_user)`,
  },
  {
    id: 'contest-questioned-by-kept-user',
    kind: 'contest',
    mode: 'disclose',
    sql: `select c.id, c.key as label,
                 'kept account ' || u.username || ' asked a clarification in it' as reason
            from contests c
            join contest_clarifications cl on cl.contest_id = c.id
            join users u on u.id = cl.asked_by
           where c.id = any(arr_contest) and u.id <> all(arr_user)`,
  },
  {
    id: 'contest-run-by-kept-team',
    kind: 'contest',
    mode: 'refuse',
    sql: `select c.id, c.key as label,
                 'kept team #' || t.id || ' competed in it' as reason
            from contests c
            join contest_participations p on p.contest_id = c.id
            join teams t on t.id = p.team_id
           where c.id = any(arr_contest) and t.id <> all(arr_team)`,
  },

  {
    id: 'problem-solved-by-kept-user',
    kind: 'problem',
    mode: 'refuse',
    sql: `select p.id, p.code as label,
                 'kept account ' || u.username || ' submitted to it — that submission is real history (D11)' as reason
            from problems p
            join submissions s on s.problem_id = p.id
            join users u on u.id = s.user_id
           where p.id = any(arr_problem) and u.id <> all(arr_user)`,
  },
  {
    id: 'problem-used-by-kept-contest',
    kind: 'problem',
    mode: 'refuse',
    sql: `select p.id, p.code as label,
                 'kept contest ' || c.key || ' sets it (contest_problems.problem_id is NO ACTION)' as reason
            from problems p
            join contest_problems cp on cp.problem_id = p.id
            join contests c on c.id = cp.contest_id
           where p.id = any(arr_problem) and c.id <> all(arr_contest)`,
  },
  {
    id: 'problem-in-kept-problem-set',
    kind: 'problem',
    mode: 'refuse',
    sql: `select p.id, p.code as label,
                 'kept problem set #' || psi.set_id || ' lists it (problem_set_items.problem_id is NO ACTION)' as reason
            from problems p
            join problem_set_items psi on psi.problem_id = p.id
           where p.id = any(arr_problem) and psi.set_id <> all(arr_set)`,
  },
  {
    id: 'problem-named-by-kept-clarification',
    kind: 'problem',
    mode: 'refuse',
    sql: `select p.id, p.code as label,
                 'a clarification on kept contest ' || c.key || ' names it (contest_clarifications.problem_id is NO ACTION)' as reason
            from problems p
            join contest_clarifications cl on cl.problem_id = p.id
            join contests c on c.id = cl.contest_id
           where p.id = any(arr_problem) and c.id <> all(arr_contest)`,
  },
  {
    id: 'problem-edited-by-kept-user',
    kind: 'problem',
    mode: 'disclose',
    sql: `select p.id, p.code as label,
                 'kept account ' || u.username || ' holds an authoring role on it (CASCADE would remove the role)' as reason
            from problems p
            join problem_members pm on pm.problem_id = p.id
            join users u on u.id = pm.user_id
           where p.id = any(arr_problem) and u.id <> all(arr_user)`,
  },
  {
    id: 'problem-shared-with-kept-org',
    kind: 'problem',
    mode: 'refuse',
    sql: `select p.id, p.code as label,
                 'shared with kept org ' || o.slug || ' (CASCADE would remove that grant)' as reason
            from problems p
            join problem_orgs po on po.problem_id = p.id
            join organizations o on o.id = po.org_id
           where p.id = any(arr_problem) and o.id <> all(arr_org)`,
  },
  {
    id: 'problem-commented-by-kept-user',
    kind: 'problem',
    mode: 'disclose',
    sql: `select p.id, p.code as label,
                 'kept account ' || u.username || ' left a comment on it' as reason
            from problems p
            join problem_comments pc on pc.problem_id = p.id
            join users u on u.id = pc.author_id
           where p.id = any(arr_problem) and u.id <> all(arr_user)`,
  },

  {
    id: 'org-with-kept-member',
    kind: 'org',
    mode: 'disclose',
    sql: `select o.id, o.slug as label,
                 'kept account ' || u.username || ' is on its roster' as reason
            from organizations o
            join org_members m on m.org_id = o.id
            join users u on u.id = m.user_id
           where o.id = any(arr_org) and u.id <> all(arr_user)`,
  },
  {
    id: 'org-with-kept-join-request',
    kind: 'org',
    mode: 'disclose',
    sql: `select o.id, o.slug as label,
                 'kept account ' || u.username || ' has a join request on it' as reason
            from organizations o
            join org_join_requests jr on jr.org_id = o.id
            join users u on u.id = jr.user_id
           where o.id = any(arr_org) and u.id <> all(arr_user)`,
  },
  {
    id: 'org-restricting-kept-contest',
    kind: 'org',
    mode: 'refuse',
    sql: `select o.id, o.slug as label,
                 'kept contest ' || c.key || ' is restricted to it — deleting the org would open that contest up (CASCADE)' as reason
            from organizations o
            join contest_orgs co on co.org_id = o.id
            join contests c on c.id = co.contest_id
           where o.id = any(arr_org) and c.id <> all(arr_contest)`,
  },
  {
    id: 'org-granted-kept-problem',
    kind: 'org',
    mode: 'refuse',
    sql: `select o.id, o.slug as label,
                 'kept problem ' || p.code || ' is shared with it' as reason
            from organizations o
            join problem_orgs po on po.org_id = o.id
            join problems p on p.id = po.problem_id
           where o.id = any(arr_org) and p.id <> all(arr_problem)`,
  },
  {
    id: 'org-owning-kept-team',
    kind: 'org',
    mode: 'refuse',
    sql: `select o.id, o.slug as label,
                 'kept team #' || t.id || ' belongs to it — deleting the org would take the team with it (CASCADE)' as reason
            from organizations o join teams t on t.org_id = o.id
           where o.id = any(arr_org) and t.id <> all(arr_team)`,
  },
  {
    id: 'org-owning-kept-problem-set',
    kind: 'org',
    mode: 'refuse',
    sql: `select o.id, o.slug as label,
                 'kept problem set #' || ps.id || ' belongs to it (CASCADE)' as reason
            from organizations o join problem_sets ps on ps.org_id = o.id
           where o.id = any(arr_org) and ps.id <> all(arr_set)`,
  },

  {
    id: 'team-with-kept-member',
    kind: 'team',
    mode: 'refuse',
    sql: `select t.id, t.name as label,
                 'kept account ' || u.username || ' is on its roster' as reason
            from teams t
            join team_members tm on tm.team_id = t.id
            join users u on u.id = tm.user_id
           where t.id = any(arr_team) and u.id <> all(arr_user)`,
  },
  {
    id: 'team-entered-kept-contest',
    kind: 'team',
    mode: 'refuse',
    sql: `select t.id, t.name as label,
                 'competed in kept contest ' || c.key || ' (teams are RESTRICT-referenced by participations)' as reason
            from teams t
            join contest_participations p on p.team_id = t.id
            join contests c on c.id = p.contest_id
           where t.id = any(arr_team) and c.id <> all(arr_contest)`,
  },
  {
    id: 'team-of-kept-org',
    kind: 'team',
    mode: 'refuse',
    sql: `select t.id, t.name as label,
                 'its organization ' || o.slug || ' is kept, and the org is the only thing that classified this team' as reason
            from teams t join organizations o on o.id = t.org_id
           where t.id = any(arr_team) and o.id <> all(arr_org)`,
  },

  {
    id: 'set-of-kept-org',
    kind: 'set',
    mode: 'refuse',
    sql: `select ps.id, ps.slug as label,
                 'its organization ' || o.slug || ' is kept, and the org is the only thing that classified this set' as reason
            from problem_sets ps join organizations o on o.id = ps.org_id
           where ps.id = any(arr_set) and o.id <> all(arr_org)`,
  },
];

const ARRAY_OF: Record<Kind, string> = {
  user: 'arr_user',
  contest: 'arr_contest',
  problem: 'arr_problem',
  org: 'arr_org',
  team: 'arr_team',
  set: 'arr_set',
};

/**
 * Rows that go, in the order the live foreign keys demand. Each entry deletes
 * and reports its own count, so the inventory is the delete plan rather than a
 * separate description of it that can drift from it.
 *
 * The order matters in four places, each measured off the FK dump:
 *   - `submissions` before `contest_problems`, because 0040 made
 *     `contest_submissions.contest_problem_id` RESTRICT;
 *   - `contest_participations` before both `contests` and `teams`, which
 *     RESTRICT-reference it;
 *   - `grading_jobs` and `submissions` before `problem_revisions`, whose
 *     `revision_id` is NO ACTION from both;
 *   - `problems.current_revision_id` nulled before the revisions go, because
 *     problem and revision point at each other.
 */
export interface DeleteStep {
  readonly table: string;
  readonly sql: string;
  /** Printed beside the count when it is not simply "rows of the test set". */
  readonly note?: string;
  /**
   * How the dry run counts this step. Derived from `sql` for the DELETEs —
   * one predicate, never two that can disagree — and given explicitly for the
   * single UPDATE, whose shape the derivation cannot rewrite.
   */
  readonly countSql?: string;
}

export const DELETE_STEPS: readonly DeleteStep[] = [
  {
    table: 'notifications',
    note: 'includes kept accounts’ notifications whose jsonb payload names a deleted row — jsonb holds no foreign keys, so nothing else would clear them and integrity-check would flag them',
    sql: `delete from notifications n
           where n.user_id = any(arr_user)
              or (n.payload ? 'contestId' and (n.payload->>'contestId')::bigint = any(arr_contest))
              or (n.payload ? 'problemId' and (n.payload->>'problemId')::bigint = any(arr_problem))
              or (n.payload ? 'submissionId' and (n.payload->>'submissionId')::bigint = any(arr_sub))`,
  },
  {
    table: 'grading_jobs',
    sql: `delete from grading_jobs j
           where j.submission_id = any(arr_sub)
              or j.revision_id in (select pr.id from problem_revisions pr where pr.problem_id = any(arr_problem))`,
  },
  {
    table: 'submission_cases',
    sql: `delete from submission_cases sc where sc.submission_id = any(arr_sub)`,
  },
  {
    table: 'contest_submissions',
    sql: `delete from contest_submissions cs
           where cs.submission_id = any(arr_sub)
              or cs.participation_id in (select p.id from contest_participations p where p.contest_id = any(arr_contest))`,
  },
  { table: 'submissions', sql: `delete from submissions s where s.id = any(arr_sub)` },
  {
    table: 'contest_problem_solvers',
    sql: `delete from contest_problem_solvers sv
           where sv.user_id = any(arr_user)
              or sv.contest_problem_id in (select cp.id from contest_problems cp
                                            where cp.contest_id = any(arr_contest) or cp.problem_id = any(arr_problem))`,
  },
  {
    table: 'contest_problem_stats',
    sql: `delete from contest_problem_stats st
           where st.contest_problem_id in (select cp.id from contest_problems cp
                                            where cp.contest_id = any(arr_contest) or cp.problem_id = any(arr_problem))`,
  },
  {
    table: 'contest_seats',
    sql: `delete from contest_seats cs where cs.contest_id = any(arr_contest) or cs.user_id = any(arr_user)`,
  },
  {
    table: 'contest_participations',
    sql: `delete from contest_participations p
           where p.contest_id = any(arr_contest) or p.user_id = any(arr_user) or p.team_id = any(arr_team)`,
  },
  {
    table: 'rating_event',
    sql: `delete from rating_event re where re.contest_id = any(arr_contest) or re.user_id = any(arr_user)`,
  },
  {
    table: 'similarity_runs',
    sql: `delete from similarity_runs sr where sr.contest_id = any(arr_contest)`,
  },
  {
    table: 'contest_clarifications',
    sql: `delete from contest_clarifications cl
           where cl.contest_id = any(arr_contest) or cl.asked_by = any(arr_user) or cl.problem_id = any(arr_problem)`,
  },
  {
    table: 'contest_orgs',
    sql: `delete from contest_orgs co where co.contest_id = any(arr_contest) or co.org_id = any(arr_org)`,
  },
  {
    table: 'contest_problems',
    sql: `delete from contest_problems cp where cp.contest_id = any(arr_contest) or cp.problem_id = any(arr_problem)`,
  },
  { table: 'contests', sql: `delete from contests c where c.id = any(arr_contest)` },
  {
    table: 'team_members',
    sql: `delete from team_members tm where tm.team_id = any(arr_team) or tm.user_id = any(arr_user)`,
  },
  { table: 'teams', sql: `delete from teams t where t.id = any(arr_team)` },
  {
    table: 'problem_set_items',
    sql: `delete from problem_set_items psi where psi.set_id = any(arr_set) or psi.problem_id = any(arr_problem)`,
  },
  { table: 'problem_sets', sql: `delete from problem_sets ps where ps.id = any(arr_set)` },
  {
    table: 'problem_comments',
    sql: `delete from problem_comments pc where pc.problem_id = any(arr_problem) or pc.author_id = any(arr_user)`,
  },
  {
    table: 'problem_members',
    sql: `delete from problem_members pm where pm.problem_id = any(arr_problem) or pm.user_id = any(arr_user)`,
  },
  {
    table: 'problem_orgs',
    sql: `delete from problem_orgs po where po.problem_id = any(arr_problem) or po.org_id = any(arr_org)`,
  },
  {
    table: 'problem_tags',
    sql: `delete from problem_tags pt where pt.problem_id = any(arr_problem)`,
  },
  {
    table: 'problems.current_revision_id',
    note: 'nulled, not deleted — problem and revision reference each other',
    sql: `update problems p set current_revision_id = null where p.id = any(arr_problem)`,
    countSql: `select count(*) from problems p where p.id = any(arr_problem)`,
  },
  {
    table: 'problem_revisions',
    sql: `delete from problem_revisions pr where pr.problem_id = any(arr_problem)`,
  },
  { table: 'problems', sql: `delete from problems p where p.id = any(arr_problem)` },
  {
    table: 'org_members',
    sql: `delete from org_members m where m.org_id = any(arr_org) or m.user_id = any(arr_user)`,
  },
  {
    table: 'org_join_requests',
    sql: `delete from org_join_requests jr where jr.org_id = any(arr_org) or jr.user_id = any(arr_user)`,
  },
  { table: 'organizations', sql: `delete from organizations o where o.id = any(arr_org)` },
  {
    table: 'rate_events',
    note: 'meter rows keyed on a deleted account’s id; the sweeper would remove them at 24h anyway (D78), so this is tidiness rather than a fix',
    /**
     * **`purpose <> 'login'` is the whole of the correctness argument, and it
     * is a closed one over today's source.**
     *
     * `RateLimiter` keys are namespaced by purpose, and every purpose in this
     * codebase that writes a `user:` key builds it from `users.id` —
     * `walk.meter.ts`'s `walkKey`, `problem.comments.ts`'s and
     * `submission.access.ts`'s `meterKey`. **`login` is the one exception**:
     * `auth.controller.ts` keys it on the SUBMITTED identifier, lowercased,
     * precisely so that an unknown username still has a window (D16). A
     * username may be three digits, so `user:487` could in principle be a
     * failed sign-in by somebody who typed `487` — which is the row this step
     * must not touch, and the only one.
     *
     * Measured on the live instance for the account this pattern was widened
     * for: `b35-probe-1788313721` (id 487) holds 20 `user_walk` and 2
     * `refused:user_walk` rows and no `login` row at all.
     */
    sql: `delete from rate_events r
           where r.purpose <> 'login'
             and r.key = any (select 'user:' || u::text from unnest(arr_user) as u)`,
  },
  { table: 'sessions', sql: `delete from sessions se where se.user_id = any(arr_user)` },
  {
    table: 'access_tokens',
    sql: `delete from access_tokens at2 where at2.user_id = any(arr_user)`,
  },
  {
    table: 'totp_recovery_codes',
    sql: `delete from totp_recovery_codes tr where tr.user_id = any(arr_user)`,
  },
  {
    table: 'totp_credentials',
    sql: `delete from totp_credentials tc where tc.user_id = any(arr_user)`,
  },
  {
    table: 'one_time_tokens',
    sql: `delete from one_time_tokens ot where ot.user_id = any(arr_user)`,
  },
  { table: 'users', sql: `delete from users u where u.id = any(arr_user)` },
];

/** The dry run counts what the apply deletes, from the SAME predicate. */
export function countQuery(step: DeleteStep): string {
  if (step.countSql !== undefined) return step.countSql;
  const prefix = 'delete from ';
  if (!step.sql.startsWith(prefix)) {
    throw new Error(`delete step ${step.table} is not a DELETE and gives no countSql`);
  }
  return `select count(*) from ${step.sql.slice(prefix.length)}`;
}

/** psql prints RAISE NOTICE to stderr; a rare separator keeps parsing honest. */
const SEP = '~|~';

function notice(section: string, args: readonly string[]): string {
  const placeholders = args.map(() => '%').join(SEP);
  const format = `${MARK}${SEP}${section}${placeholders === '' ? '' : SEP + placeholders}`;
  return `raise notice '${format}'${args.length === 0 ? '' : ', ' + args.join(', ')};`;
}

export interface ScriptOptions {
  /** false: plan only, under SET TRANSACTION READ ONLY, ending in ROLLBACK. */
  readonly apply: boolean;
  /**
   * `--only` — an explicit list of natural keys the run may touch, or
   * `undefined` for "everything the patterns claim".
   *
   * **It NARROWS, it never widens**, and the direction is the whole point. It
   * is intersected with the allow-list, after the deny-list, so a name that
   * matches no pattern is still invisible and a denied name is still denied:
   * `--only duckadmin` deletes nothing. What it buys is the case D153 did not
   * have a shape for — an operator authorised to remove **two named rows**
   * from a live judge, on an instance whose patterns legitimately claim four
   * hundred more. Before it, "run the cleaner for these two accounts" and
   * "run the cleaner" were the same command, and the honest way to obey the
   * first was to not run it at all.
   *
   * The blockers still run, unchanged, over the narrowed set: a named row
   * something real depends on is still refused with the reason printed.
   */
  readonly only?: readonly string[] | undefined;
}

/**
 * The whole thing is one plpgsql block so that classification, the blocker
 * fixpoint and the deletes cannot be separated by a process boundary. A plan
 * computed by a previous invocation is worthless here: the API is up, the
 * loops that made this litter can still write, and the row a plan called safe
 * five seconds ago may now be a real pupil's only submission.
 */
export function buildScript(options: ScriptOptions): string {
  const passes: string[] = [];
  for (const blocker of BLOCKERS.filter((b) => b.mode === 'refuse')) {
    passes.push(
      `    -- ${blocker.id}
    for rec in select distinct on (v.id) v.id, v.label, v.reason
               from (${blocker.sql}) v
              order by v.id, v.reason loop
      ${notice(`refused${SEP}${blocker.kind}`, ['rec.id::text', 'rec.label', 'rec.reason'])}
      ${ARRAY_OF[blocker.kind]} := array_remove(${ARRAY_OF[blocker.kind]}, rec.id);
      v_moved := v_moved + 1;
    end loop;`,
    );
  }

  const disclosures = BLOCKERS.filter((blocker) => blocker.mode === 'disclose').map(
    (blocker) => `  -- ${blocker.id}
  select count(*), min(v.label || ' — ' || v.reason) into v_n, v_text from (${blocker.sql}) v;
  if v_n > 0 then
    ${notice(`disclosed${SEP}${blocker.kind}`, [quote(blocker.id), 'v_n::text', 'v_text'])}
  end if;`,
  );

  const steps = DELETE_STEPS.map(
    (step) => `  -- ${step.table}
  if v_apply then
    ${step.sql};
    get diagnostics v_n = row_count;
  else
    ${countQuery(step).replace('select count(*)', 'select count(*) into v_n')};
  end if;
  ${notice('row', [quote(step.table), 'v_n::text', quote(step.note ?? '')])}`,
  );

  const body = `do $cleanup$
declare
  v_apply    boolean := ${options.apply ? 'true' : 'false'};
  arr_user    bigint[];
  arr_contest bigint[];
  arr_problem bigint[];
  arr_org     bigint[];
  arr_team    bigint[];
  arr_set     bigint[];
  arr_sub     bigint[];
  v_moved  int;
  v_pass   int := 0;
  v_n      bigint;
  v_text   text;
  rec      record;
begin
  -- 1. Classification. Deny first, then the allow-list patterns; a row that
  --    matches nothing here is invisible to every statement below.
  arr_user := array(select id from users
                     where ${denyPredicate('user', 'username')}
                       and ${patternPredicate('user', 'username')}
                       and ${onlyPredicate('username', options.only)});
  arr_contest := array(select id from contests
                        where ${denyPredicate('contest', 'key')}
                          and ${patternPredicate('contest', 'key')}
                          and ${onlyPredicate('key', options.only)});
  arr_problem := array(select id from problems
                        where ${denyPredicate('problem', 'code')}
                          and ${patternPredicate('problem', 'code')}
                          and ${onlyPredicate('code', options.only)});
  arr_org := array(select id from organizations
                    where ${denyPredicate('org', 'slug')}
                      and ${patternPredicate('org', 'slug')}
                      and ${onlyPredicate('slug', options.only)});
  -- Teams and problem sets have no name of their own to match; their org is
  -- what classifies them, and a team whose org is refused is refused with it.
  arr_team := array(select id from teams where org_id = any(arr_org));
  arr_set  := array(select id from problem_sets where org_id = any(arr_org));

  -- 2. The deny-list asserted, not assumed. If a pattern above is ever
  --    widened carelessly this aborts instead of deleting the demo content.
  if exists (select 1 from users where id = any(arr_user)
              and username in (${DENY.user.map(quote).join(', ')})) then
    raise exception 'cleanup-test-data: a denied account entered the delete set';
  end if;
  if exists (select 1 from contests where id = any(arr_contest)
              and key in (${DENY.contest.map(quote).join(', ')})) then
    raise exception 'cleanup-test-data: a denied contest entered the delete set';
  end if;
  if exists (select 1 from problems where id = any(arr_problem)
              and code in (${DENY.problem.map(quote).join(', ')})) then
    raise exception 'cleanup-test-data: a denied problem entered the delete set';
  end if;

  ${notice('classified', [
    'array_length(arr_user, 1)',
    'array_length(arr_contest, 1)',
    'array_length(arr_problem, 1)',
    'array_length(arr_org, 1)',
    'array_length(arr_team, 1)',
    'array_length(arr_set, 1)',
  ])}

  -- 3. The blocker fixpoint. Refusing one row can make another undeletable,
  --    so this repeats until a whole pass moves nothing.
  loop
    v_pass := v_pass + 1;
    v_moved := 0;
${passes.join('\n')}
    exit when v_moved = 0;
    if v_pass > 20 then
      raise exception 'cleanup-test-data: blocker fixpoint did not settle in 20 passes';
    end if;
  end loop;
  ${notice('passes', ['v_pass::text'])}

  -- 4. The submissions that go with what survived classification.
  arr_sub := array(
    select s.id from submissions s
     where s.user_id = any(arr_user)
        or s.problem_id = any(arr_problem)
        or exists (select 1 from contest_submissions cs
                     join contest_participations p on p.id = cs.participation_id
                    where cs.submission_id = s.id and p.contest_id = any(arr_contest)));

  -- The invariant that makes step 4 safe: a kept account's submission can
  -- only reach this set through a kept-authored problem or contest, and both
  -- of those are blockers. If one is ever missed, stop here.
  if exists (select 1 from submissions s where s.id = any(arr_sub) and s.user_id <> all(arr_user)) then
    raise exception 'cleanup-test-data: the delete set reaches a submission a kept account wrote';
  end if;

  -- 5. What KEPT rows lose anyway. These are the disclose-tier blockers: rows
  --    that die with their container and take a kept account's bookkeeping
  --    line with them. Printed BEFORE the plan so nobody types CONFIRM
  --    without having read them.
${disclosures.join('\n')}

  -- 6. What KEPT problems lose. Nothing depends on these rows — a submission
  --    points at a problem, never the reverse — but the problem's counters
  --    change, so it is said out loud rather than discovered afterwards.
  for rec in select p.code as label, count(*) as n
               from submissions s join problems p on p.id = s.problem_id
              where s.id = any(arr_sub) and p.id <> all(arr_problem)
              group by p.code order by count(*) desc loop
    ${notice('stats-change', ['rec.label', 'rec.n::text'])}
  end loop;

  -- 7. The plan, table by table, in foreign-key order.
${steps.join('\n')}

  ${notice('done', ["case when v_apply then 'applied' else 'planned' end"])}
end
$cleanup$;`;

  const lines = [
    'begin;',
    // Not a comment promising read-only: Postgres refuses the write. In a dry
    // run the DELETE branches are never reached, so plpgsql never even plans
    // them, and anything that did reach one would abort the transaction.
    ...(options.apply ? [] : ['set transaction read only;']),
    body,
    options.apply ? 'commit;' : 'rollback;',
    '',
  ];
  return lines.join('\n');
}

interface Notice {
  readonly section: string;
  readonly fields: readonly string[];
}

/** psql folds long NOTICEs onto continuation lines; rejoin before splitting. */
export function parseNotices(stderr: string): Notice[] {
  const out: Notice[] = [];
  for (const raw of stderr.split('\n')) {
    const at = raw.indexOf(`${MARK}${SEP}`);
    if (at === -1) continue;
    const [section, ...fields] = raw.slice(at + MARK.length + SEP.length).split(SEP);
    out.push({ section: section ?? '', fields });
  }
  return out;
}

interface Options {
  readonly apply: boolean;
  /** Write the SQL to stdout and touch no database at all. */
  readonly printPlan: boolean;
  readonly live: boolean;
  readonly url: string | undefined;
  readonly container: string;
  readonly database: string;
  readonly user: string;
  /** `--only` — the natural keys this run may touch. See `ScriptOptions`. */
  readonly only: readonly string[] | undefined;
}

function parseArgs(argv: readonly string[]): Options {
  let apply = false;
  let printPlan = false;
  let live = false;
  let url: string | undefined;
  let only: string[] | undefined;
  let container = 'duckoj_postgres_1';
  let database = 'duckoj';
  let dbUser = 'duckoj';
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--print-plan') printPlan = true;
    else if (arg === '--live') live = true;
    else if (arg === '--only') only = (argv[++index] ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '');
    else if (arg === '--url') url = argv[++index];
    else if (arg === '--container') container = argv[++index] ?? container;
    else if (arg === '--database') database = argv[++index] ?? database;
    else if (arg === '--user') dbUser = argv[++index] ?? dbUser;
  }
  if (
    url === undefined &&
    process.env.DATABASE_URL !== undefined &&
    process.env.DATABASE_URL !== ''
  ) {
    url = process.env.DATABASE_URL;
  }
  // The deployed Postgres publishes no host port (`docker-compose.yml` gives
  // the `postgres` service no `ports:`), so the container is the default and
  // `--url` is for a database something on this host can actually dial.
  if (!live && url === undefined) live = true;
  return { apply, printPlan, live, url, container, database, user: dbUser, only };
}

async function execute(options: Options, script: string): Promise<string> {
  const psqlArgs = ['-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-f', '-'];
  const child = options.live
    ? run(
        'podman',
        [
          'exec',
          '-i',
          options.container,
          'psql',
          '-U',
          options.user,
          '-d',
          options.database,
          ...psqlArgs,
        ],
        {
          maxBuffer: 64 * 1024 * 1024,
        },
      )
    : run('psql', [options.url ?? '', ...psqlArgs], { maxBuffer: 64 * 1024 * 1024 });
  child.child.stdin?.end(script);
  const { stderr } = await child;
  return stderr;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  // `--print-plan` is the operator's read-before-you-run, and the only mode
  // that opens no connection — so it is answered before CONFIRM is consulted.
  if (options.printPlan) {
    process.stdout.write(buildScript({ apply: options.apply, only: options.only }));
    return 0;
  }
  if (options.apply && process.env.CONFIRM !== 'yes') {
    console.error('cleanup-test-data: --apply needs CONFIRM=yes as well. Nothing was touched.');
    return 2;
  }

  const script = buildScript({ apply: options.apply, only: options.only });
  if (
    !options.apply &&
    /\n\s*(delete|update|insert)\s/i.test(script.replace(/\$cleanup\$[\s\S]*\$cleanup\$/, ''))
  ) {
    console.error('cleanup-test-data: the dry-run wrapper contains a write. Refusing.');
    return 2;
  }

  const notices = parseNotices(await execute(options, script));
  const header = options.apply
    ? 'APPLIED — one transaction, committed.'
    : 'DRY RUN — read-only transaction, rolled back. Nothing was changed.';
  console.log(header);
  console.log('');

  const classified = notices.find((n) => n.section === 'classified');
  if (classified !== undefined) {
    const [users, contests, problems, orgs, teams, sets] = classified.fields.map((f) =>
      f === '' ? '0' : f,
    );
    console.log(
      `Matched the allow-list: ${users ?? '0'} users, ${contests ?? '0'} contests, ` +
        `${problems ?? '0'} problems, ${orgs ?? '0'} orgs, ${teams ?? '0'} teams, ${sets ?? '0'} problem sets.`,
    );
  }

  const refused = notices.filter((n) => n.section === 'refused');
  console.log(`\nREFUSED — a kept row depends on these (${String(refused.length)}):`);
  if (refused.length === 0) console.log('  (none)');
  for (const row of refused) {
    const [kind, id, label, reason] = row.fields;
    console.log(`  ${pad(kind ?? '', 8)} ${pad(label ?? '', 34)} #${id ?? ''}`);
    console.log(`           ${reason ?? ''}`);
  }

  const disclosed = notices.filter((n) => n.section === 'disclosed');
  console.log(
    `\nDISCLOSED — kept accounts lose these bookkeeping rows anyway (${String(disclosed.length)}):`,
  );
  if (disclosed.length === 0) console.log('  (none)');
  for (const row of disclosed) {
    const [kind, rule, count] = row.fields;
    console.log(`  ${pad(kind ?? '', 8)} ${pad(rule ?? '', 34)} ${count ?? ''} rows`);
    console.log(`           e.g. ${row.fields[3] ?? ''}`);
  }

  const stats = notices.filter((n) => n.section === 'stats-change');
  if (stats.length > 0) {
    console.log('\nKEPT problems whose counters change (their test submissions go):');
    for (const row of stats)
      console.log(`  ${pad(row.fields[0] ?? '', 34)} ${row.fields[1] ?? ''} submissions`);
  }

  const rows = notices.filter((n) => n.section === 'row');
  const total = rows.reduce((sum, row) => sum + Number(row.fields[1] ?? '0'), 0);
  console.log(`\n${options.apply ? 'Deleted' : 'Would delete'}, in foreign-key order:`);
  for (const row of rows) {
    const count = Number(row.fields[1] ?? '0');
    if (count === 0) continue;
    console.log(`  ${pad(row.fields[0] ?? '', 30)} ${String(count)}`);
    if ((row.fields[2] ?? '') !== '') console.log(`      ${row.fields[2] ?? ''}`);
  }
  console.log(
    `\n${String(total)} rows in ${String(rows.filter((r) => Number(r.fields[1] ?? '0') > 0).length)} tables.`,
  );

  if (!options.apply) {
    // The hint repeats `--only`, because an operator who narrowed the plan and
    // then pasted an unnarrowed apply would delete four hundred rows they had
    // just been shown a plan for twenty-five of. A suggested command that is
    // not the command whose plan is on screen is a trap, not a convenience.
    const narrowed = options.only === undefined ? '' : ` --only ${options.only.join(',')}`;
    console.log(
      `\nTo carry it out:  CONFIRM=yes corepack pnpm tsx scripts/cleanup-test-data.ts${narrowed} --apply`,
    );
    console.log(
      'Afterwards:       corepack pnpm tsx scripts/integrity-check.ts --live   (expect it clean)',
    );
  }
  return total === 0 ? 1 : 0;
}

// `import.meta.main` is not on Node 22, and this module is imported by its own
// spec — so run only when this file IS the entry point.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
