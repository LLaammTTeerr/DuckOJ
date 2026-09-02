/**
 * `scripts/cleanup-test-data.ts` — the only thing in this codebase that
 * deletes rows an operator did not name one at a time (D153).
 *
 * Driven as a SUBPROCESS through `--print-plan`, like
 * `integrity-check-script.spec.ts` drives its neighbour, and with NO database:
 * every property worth pinning here is a property of the SQL the script emits,
 * and a spec that needed a Postgres container to check "the dry run cannot
 * write" would be checking the container instead of the script. It asserts on
 * the emitted text rather than on the script's exported tables for the same
 * reason — the text is what the database is handed.
 *
 * A wrong check in `integrity-check.ts` reports a clean database forever. A
 * wrong rule here deletes a province's contest, so these are stricter.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(repoRoot, 'scripts', 'cleanup-test-data.ts');

async function printPlan(...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('npx', ['tsx', script, '--print-plan', ...args], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** The `-- <name>` markers the generator emits ahead of each delete step. */
function deleteOrder(plan: string): string[] {
  return [...plan.matchAll(/^ {2}-- ([a-z_.]+)\n {2}if v_apply then$/gm)].map(
    (match) => match[1] ?? '',
  );
}

let plan = '';
let apply = '';
let narrowed = '';

beforeAll(async () => {
  plan = await printPlan();
  apply = await printPlan('--apply');
  narrowed = await printPlan('--only', "f56probe1,b35-probe-1788313721");
}, 120_000);

describe('--print-plan', () => {
  it('opens no connection and needs no database', () => {
    expect(plan.startsWith('begin;')).toBe(true);
  });

  it('plans read-only and rolls back; only --apply commits', () => {
    expect(plan).toContain('set transaction read only;');
    expect(plan.trimEnd().endsWith('rollback;')).toBe(true);
    expect(plan).not.toContain('commit;');

    expect(apply).not.toContain('set transaction read only;');
    expect(apply.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('is the same script either way — the plan is not a second implementation', () => {
    expect(plan.replace('v_apply    boolean := false;', 'v_apply    boolean := true;')).toBe(
      apply
        .replace('begin;\n', 'begin;\nset transaction read only;\n')
        .replace(/commit;$/m, 'rollback;'),
    );
  });

  it('refuses to --apply without CONFIRM=yes', async () => {
    await expect(
      execFileAsync('npx', ['tsx', script, '--apply'], {
        cwd: repoRoot,
        env: { ...process.env, CONFIRM: '' },
      }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe('the allow-list is the only way in', () => {
  it('excludes the demo set at classification AND asserts it again', () => {
    // Once as a filter, once as a tripwire — a widened pattern must abort
    // rather than reach the content a province is shown on day one.
    expect(plan).toContain("username not in ('system', 'duckadmin', 'hocsinh1')");
    expect(plan).toContain("key not in ('thu-nghiem-1')");
    for (const code of [
      'tong-hai-so',
      'so-nguyen-to',
      'day-con-tang',
      'duong-di-ngan-nhat',
      'cay-khung-nho-nhat',
    ]) {
      expect(plan).toContain(`'${code}'`);
    }
    expect(plan).toContain('a denied account entered the delete set');
    expect(plan).toContain('a denied contest entered the delete set');
    expect(plan).toContain('a denied problem entered the delete set');
  });

  it('classifies by name only, anchored at the start of the name', () => {
    const matches = [...plan.matchAll(/(?:username|key|code|slug) ~ '([^']+)'/g)].map(
      (match) => match[1] ?? '',
    );
    expect(matches.length).toBeGreaterThan(20);
    for (const regex of matches) expect(regex.startsWith('^')).toBe(true);
  });

  it('keys every delete on a classified array, so nothing else is reachable', () => {
    const arrays = /arr_(user|contest|problem|org|team|set|sub)\b/;
    const statements = [...plan.matchAll(/^ {4}(delete from [\s\S]*?|update [\s\S]*?);$/gm)].map(
      (m) => m[1] ?? '',
    );
    expect(statements.length).toBeGreaterThan(25);
    for (const statement of statements) expect(statement).toMatch(arrays);
  });

  it('claims the one F-slot name that was actually minted, and nothing wider', () => {
    // F-55 said to add a pattern the day an F slot wrote to the live judge
    // under its own name. F-56 is that day, and the row is `f56probe1` — no
    // hyphen, so `^f[0-9]+-` would still match nothing. `^f[0-9]+probe`
    // claims the shape that exists and refuses the shape that would claim
    // every future name beginning with a letter and a digit.
    expect(plan).toContain("username ~ '^f[0-9]+probe'");
    expect(plan).not.toContain("username ~ '^f[0-9]+'");
    expect(plan).not.toContain("username ~ '^f[0-9]+-'");
  });

  it('removes a deleted account’s meter rows, and never a login window', () => {
    // `rate_events` has no foreign key to `users`; `key` is free text. Every
    // purpose that writes a `user:` key builds it from `users.id` EXCEPT
    // `login`, which keys on the submitted identifier so that an unknown
    // username still has a window (D16) — and a username may be three digits.
    // Excluding `login` is therefore the whole correctness argument, and this
    // is the assertion that keeps it in the file.
    expect(plan).toContain("delete from rate_events r");
    expect(plan).toContain("r.purpose <> 'login'");
    expect(plan).toContain("'user:' || u::text from unnest(arr_user) as u");
  });

  it('narrows to the rows an operator named, and never widens (D202)', () => {
    // The case D153 had no shape for: an operator authorised to remove TWO
    // named rows from a live judge whose patterns legitimately claim four
    // hundred more. Without this flag, "run the cleaner for these two" and
    // "run the cleaner" are the same command.
    for (const column of ['username', 'key', 'code', 'slug']) {
      expect(narrowed).toContain(`${column} in ('f56probe1', 'b35-probe-1788313721')`);
    }
    // Intersected with the allow-list and AFTER the deny-list, so a named row
    // that matches no pattern is still invisible and a denied one is still
    // denied: `--only duckadmin` deletes nothing.
    expect(narrowed).toContain("username not in ('system', 'duckadmin', 'hocsinh1')");
    expect(narrowed).toContain("username ~ '^b[0-9]+-'");
    // And an unnarrowed run is unchanged — the clause is absent, not `in ()`.
    expect(plan).not.toContain(' in (\'f56probe1');
    expect(plan.match(/and true\)/g) ?? []).toHaveLength(4);
  });

  it('leaves the content-addressed package tables alone', () => {
    expect(plan).not.toContain('delete from packages');
    expect(plan).not.toContain('delete from package_files');
  });
});

describe('the plan predicts the apply', () => {
  it('counts every step from the step’s own predicate', () => {
    const blocks = [
      ...plan.matchAll(
        /if v_apply then\n {4}([\s\S]*?);\n {4}get diagnostics[\s\S]*?else\n {4}([\s\S]*?);\n {2}end if;/g,
      ),
    ];
    expect(blocks.length).toBeGreaterThan(25);
    for (const [, mutation = '', count = ''] of blocks) {
      // The predicate is shared, not restated: a plan that can disagree with
      // the delete it describes is worse than no plan. The one UPDATE is
      // exempt, because `set … = null` has no counterpart in a count.
      if (mutation.startsWith('update ')) continue;
      const where = mutation.slice(mutation.indexOf(' where '));
      expect(count.endsWith(where)).toBe(true);
      expect(count.startsWith('select count(*) into v_n from ')).toBe(true);
    }
  });

  it('emits the deletes in the order the live foreign keys demand', () => {
    const order = deleteOrder(plan);
    const before = (a: string, b: string): boolean => order.indexOf(a) < order.indexOf(b);
    expect(order.length).toBeGreaterThan(25);
    // Migration 0040 made contest_submissions.contest_problem_id RESTRICT.
    expect(before('contest_submissions', 'submissions')).toBe(true);
    expect(before('submissions', 'contest_problems')).toBe(true);
    // contests and teams are RESTRICT-referenced by participations.
    expect(before('contest_participations', 'contests')).toBe(true);
    expect(before('contest_participations', 'teams')).toBe(true);
    // submissions.revision_id and grading_jobs.revision_id are NO ACTION.
    expect(before('grading_jobs', 'problem_revisions')).toBe(true);
    expect(before('submissions', 'problem_revisions')).toBe(true);
    // Problem and revision point at each other; the pointer is nulled first.
    expect(before('problems.current_revision_id', 'problem_revisions')).toBe(true);
    expect(before('problem_revisions', 'problems')).toBe(true);
    // Everything an account owns goes before the account.
    expect(order.at(-1)).toBe('users');
  });
});

describe('blockers', () => {
  it('refuses competitive history in BOTH directions', () => {
    // The brief's two worked examples — a test account inside a real round, a
    // real pupil inside a test round — and D104's seat on either side.
    for (const rule of [
      'user-entered-kept-contest',
      'contest-entered-by-kept-user',
      'user-seated-on-kept-contest',
      'contest-seated-a-kept-user',
      'problem-solved-by-kept-user',
      'user-rated-on-kept-contest',
      'contest-rated-a-kept-user',
      // Reach, not just rows: deleting a test org must not quietly open a
      // kept contest up by emptying its organization allow-list.
      'org-restricting-kept-contest',
      'org-granted-kept-problem',
    ]) {
      expect(plan).toContain(`    -- ${rule}\n    for rec in`);
    }
  });

  it('runs the refusals to a fixpoint, with a bound', () => {
    expect(plan).toContain('exit when v_moved = 0;');
    expect(plan).toContain('blocker fixpoint did not settle in 20 passes');
  });

  it('stops rather than delete a submission a kept account wrote', () => {
    expect(plan).toContain('the delete set reaches a submission a kept account wrote');
  });

  it('discloses what kept containers lose, before the plan and outside the fixpoint', () => {
    for (const rule of [
      'org-with-kept-member',
      'contest-questioned-by-kept-user',
      'problem-edited-by-kept-user',
    ]) {
      expect(plan).toContain(`  -- ${rule}\n  select count(*), min(`);
      expect(plan).toContain(`disclosed~|~`);
    }
    expect(plan.indexOf('disclosed~|~')).toBeLessThan(plan.indexOf('if v_apply then'));
  });
});
