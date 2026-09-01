/**
 * The concurrency token an edit form carries — D161, extended to every form
 * with the shape by D176.
 *
 * **The problem it exists for.** `ProblemEditPage` and `ContestEditPage` are
 * whole-object forms: they seed every field from one read and PATCH every
 * field back on save. So a teacher who opens a problem, waits while a
 * colleague saves a rewritten statement, and then fixes a typo in the *name*
 * sends the colleague's statement back over the top of it. No request fails,
 * nothing appears on screen, and the site held both versions and threw one
 * away. B-31 closed the case where the stale copy was the teacher's own; this
 * closes the case where it was somebody else's.
 *
 * **Five forms have that shape, and four of them are here.** D161 was applied
 * where the defect was found; D176 asks the question of every form that seeds
 * once from a cached query and saves by replacement, and admits the ones two
 * people can plausibly hold open at the same time: the two above, a problem's
 * per-language limits, a problem set, and a team's roster. `/account/settings`
 * has the shape and is **deliberately not here** — the only writer of a
 * person's display name and preferences is that person, so there is no second
 * holder for the token to protect them from. D176 records what would make that
 * stop being true.
 *
 * **What the token is.** A SHA-256 over the row's editable state, read in one
 * query — exactly the columns `UpdateProblemRequest` / `UpdateContestRequest`
 * can write, and nothing else. A client sends back the value it was given,
 * the service recomputes it under the row's lock, and a mismatch is 409 with
 * nothing written.
 *
 * **Why a content hash and not a `version` column.** Two reasons, both in
 * D161. A column needs a migration on a production stack this defect does not
 * justify touching; and its correctness would be a *discipline* rather than a
 * constraint — right only for as long as every future writer of `problems`
 * remembers whether to bump it. The revision-publish path writes
 * `problems.current_revision_id`, the admin rate toggle writes `contests`, and
 * neither is an edit-form save. A hash over the editable columns is right by
 * construction: it moves when, and only when, something a PATCH could have
 * written has moved. That also makes an idempotent re-save a no-op rather than
 * a conflict.
 *
 * **Why not a hash of the detail response.** Because that response is
 * *viewer-dependent*, which would make the token differ between two people who
 * may both edit the same thing. D35 blanks `tags` and `difficulty` for a viewer
 * sitting a running contest; `loadMembersAndOrgs` withholds `orgSlugs` from a
 * non-editor; and `ContestDetail.problems` is empty before the start for
 * everyone who does not run the contest, so it would populate *at the start
 * instant with no edit at all* and refuse saves nobody could explain. Every
 * query here reads the stored row directly and takes no actor.
 *
 * **Determinism is load-bearing**, because the value computed on a read in one
 * worker is compared against the value computed on a write in another. So:
 * no wall clock; every aggregate carries an explicit `ORDER BY`; every
 * timestamp is reduced to epoch milliseconds rather than cast to `text`, whose
 * rendering follows the session's `TimeZone`; and `jsonb::text` is Postgres's
 * own normalised form, which is stable across writers that spelled the same
 * object differently.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@duckoj/db';
import { AppError } from '../common/app.error.js';

/**
 * The separator between fields, and between an aggregate's entries. ASCII 31
 * (unit separator) rather than a comma: a slug cannot contain it, a username
 * cannot contain it, and neither can a statement that a setter pasted out of a
 * PDF — which a comma very much can. Injectivity is the whole property a
 * concatenation-then-hash depends on.
 *
 * Its partner inside an aggregate's own entries is ASCII 30, spelled `chr(30)`
 * in the SQL below — the separator has to be produced by Postgres there, so it
 * cannot be this constant, and the two are documented together for that
 * reason.
 */
const US = '\u001f';

/**
 * `null` is NOT the empty string here, and the distinction is deliberate:
 * `editorial: null` ("there is none") and `editorial: ''` are different states
 * of the row, so folding both to `''` would let a change between them slip
 * past the check. ASCII 0 is the marker, which no column here can contain.
 */
const NUL = '\u0000';

function digest(parts: readonly (string | number | boolean | null)[]): string {
  const canonical = parts.map((part) => (part === null ? NUL : String(part))).join(US);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The token for a problem, over exactly what `UpdateProblemRequest` writes:
 * the six scalar columns, whether the editorial is published (a boolean on the
 * wire, a timestamp in the table — the *date* is the server's and moving it is
 * not an edit), and the tag, org and member sets.
 *
 * The three sets are sub-selects rather than joins so the row cannot be
 * multiplied, and each is sorted by the value the API writes it by — a slug, a
 * username — rather than by an id, because ids are what a re-import changes
 * and the set is what a teacher sees.
 *
 * `db` is `Db`, which a transaction also satisfies: the read path calls this
 * on the connection and the write path calls it on `tx` inside the lock, and
 * they must be the same function or the two answers can drift apart in a way
 * no test would show.
 */
export async function problemEditVersion(db: Db, problemId: number): Promise<string> {
  const rows = await db.execute<{
    name: string;
    statement: string;
    visibility: string;
    source_access: string;
    difficulty: number | null;
    editorial: string | null;
    editorial_published: boolean;
    tags: string;
    orgs: string;
    members: string;
  }>(sql`
    select p.name,
           p.statement,
           p.visibility::text        as visibility,
           p.source_access::text     as source_access,
           p.difficulty,
           p.editorial,
           (p.editorial_published_at is not null) as editorial_published,
           coalesce((
             select string_agg(t.slug, chr(31) order by t.slug)
               from problem_tags pt join tags t on t.id = pt.tag_id
              where pt.problem_id = p.id
           ), '') as tags,
           coalesce((
             select string_agg(o.slug, chr(31) order by o.slug)
               from problem_orgs po join organizations o on o.id = po.org_id
              where po.problem_id = p.id
           ), '') as orgs,
           coalesce((
             select string_agg(u.username || chr(30) || pm.role, chr(31) order by u.username)
               from problem_members pm join users u on u.id = pm.user_id
              where pm.problem_id = p.id
           ), '') as members
      from problems p
     where p.id = ${problemId}
  `);
  const row = rows[0];
  // A problem that vanished between the caller's own read and this one. The
  // caller has already established it exists, so the honest answer is a token
  // nothing can match rather than a crash on a path whose whole job is to
  // refuse safely.
  if (!row) return digest(['problem', 'gone', problemId]);
  return digest([
    'problem',
    row.name,
    row.statement,
    row.visibility,
    row.source_access,
    row.difficulty,
    row.editorial,
    row.editorial_published,
    row.tags,
    row.orgs,
    row.members,
  ]);
}

/**
 * The token for a contest, over exactly what `UpdateContestRequest` writes.
 *
 * The problem list carries its `label`, `points`, `partial` and `order`
 * because all four are in the request and all four are what an organiser sees;
 * ordered by `(order, id)`, which is the order every read of this list uses.
 * `is_rated` is **not** here: an admin sets it through its own route and it is
 * not a field this form can write, so a contest being rated between a read and
 * a save must not refuse the save.
 */
export async function contestEditVersion(db: Db, contestId: number): Promise<string> {
  const rows = await db.execute<{
    name: string;
    start_ms: string;
    end_ms: string;
    format: string;
    format_config: string | null;
    points_precision: number;
    frozen_last_minutes: number;
    time_limit_seconds: number | null;
    visibility: string;
    participation_mode: string;
    max_team_size: number;
    orgs: string;
    problems: string;
  }>(sql`
    select c.name,
           (extract(epoch from c.start_time) * 1000)::bigint::text as start_ms,
           (extract(epoch from c.end_time) * 1000)::bigint::text   as end_ms,
           c.format,
           c.format_config::text as format_config,
           c.points_precision,
           c.frozen_last_minutes,
           c.time_limit_seconds,
           c.visibility::text         as visibility,
           c.participation_mode::text as participation_mode,
           c.max_team_size,
           coalesce((
             select string_agg(o.slug, chr(31) order by o.slug)
               from contest_orgs co join organizations o on o.id = co.org_id
              where co.contest_id = c.id
           ), '') as orgs,
           coalesce((
             select string_agg(
                      p.code || chr(30) || cp.label || chr(30) || cp.points::text
                             || chr(30) || cp.partial::text || chr(30) || cp."order"::text,
                      chr(31) order by cp."order", cp.id
                    )
               from contest_problems cp join problems p on p.id = cp.problem_id
              where cp.contest_id = c.id
           ), '') as problems
      from contests c
     where c.id = ${contestId}
  `);
  const row = rows[0];
  if (!row) return digest(['contest', 'gone', contestId]);
  return digest([
    'contest',
    row.name,
    row.start_ms,
    row.end_ms,
    row.format,
    row.format_config,
    row.points_precision,
    row.frozen_last_minutes,
    row.time_limit_seconds,
    row.visibility,
    row.participation_mode,
    row.max_team_size,
    row.orgs,
    row.problems,
  ]);
}

/**
 * The token for a problem's per-language limit overrides — D176.
 *
 * Over exactly what `UpdateProblemLanguageLimitsRequest` writes: one entry per
 * STORED override row, keyed by the language's `key` rather than its id
 * (a re-seeded deployment is what changes an id; the key is what the form
 * sends and what a setter reads).
 *
 * **What is deliberately not in it**, and this is the interesting half. The
 * response this token rides carries `base` — the published revision's authored
 * limits — and each language's deployment-wide default multiplier and memory
 * floor. Neither is a field this PUT can write. A setter who publishes a
 * corrected revision, or an administrator who retunes Python across the whole
 * judge (D169 did exactly that), changes what this screen *previews* without
 * changing anything this screen can *save*; a token over them would lock a
 * co-author out of the overrides over a write they do not own, which is the
 * failure mode D161 rejected a `version` column to avoid.
 *
 * A row that inherits both columns and allows the language is stored as NO ROW
 * (`replaceLanguageLimits`'s own rule), so it contributes nothing here either
 * — which is right, and is why the token is over the stored rows rather than
 * over the request that produced them: two requests that store the same set
 * are the same state, and neither refuses the other.
 */
export async function problemLanguageLimitsVersion(db: Db, problemId: number): Promise<string> {
  const rows = await db.execute<{ limits: string }>(sql`
    select coalesce((
             select string_agg(
                      l.key || chr(30) || coalesce(pll.time_multiplier_pct::text, '')
                            || chr(30) || coalesce(pll.memory_extra_kb::text, '')
                            || chr(30) || pll.allowed::text,
                      chr(31) order by l.key
                    )
               from problem_language_limits pll join languages l on l.id = pll.language_id
              where pll.problem_id = ${problemId}
           ), '') as limits
  `);
  return digest(['language-limits', problemId, rows[0]?.limits ?? '']);
}

/**
 * The token for a problem set — D176.
 *
 * Over exactly what `UpdateProblemSetRequest` writes: the four scalars and the
 * item list with its points and its order. `deadline` is reduced to epoch
 * milliseconds rather than cast to `text`, for the reason `contestEditVersion`
 * states — a `timestamptz` renders through the session's `TimeZone`, and this
 * value is computed on a read in one worker and compared on a write in
 * another.
 *
 * Ordered by `("order", problem_id)`, which is the order every read of this
 * list uses (`problem_set_items_order_idx`). The item's PROBLEM CODE, not its
 * id, on `problemEditVersion`'s rule.
 *
 * `solvedCount`, `visible` and the `me` cells on `ProblemSetDetail` are not
 * here and must not be: they move when a pupil submits, and they differ
 * between two teachers who may both edit this set.
 */
export async function problemSetEditVersion(db: Db, setId: number): Promise<string> {
  const rows = await db.execute<{
    slug: string;
    name: string;
    description: string | null;
    deadline_ms: string | null;
    items: string;
  }>(sql`
    select ps.slug,
           ps.name,
           ps.description,
           (extract(epoch from ps.deadline) * 1000)::bigint::text as deadline_ms,
           coalesce((
             select string_agg(
                      p.code || chr(30) || psi."order"::text || chr(30) || psi.points::text,
                      chr(31) order by psi."order", psi.problem_id
                    )
               from problem_set_items psi join problems p on p.id = psi.problem_id
              where psi.set_id = ps.id
           ), '') as items
      from problem_sets ps
     where ps.id = ${setId}
  `);
  const row = rows[0];
  if (!row) return digest(['problem-set', 'gone', setId]);
  return digest([
    'problem-set',
    row.slug,
    row.name,
    row.description,
    row.deadline_ms,
    row.items,
  ]);
}

/**
 * The token for a team — D176.
 *
 * Over exactly what `UpdateTeamRequest` writes: the slug, the name and the
 * roster, by username and sorted by it.
 *
 * `TeamDetail.contests` is deliberately absent. A team entering a round is not
 * an edit to the team, and a token that moved on it would refuse a rename made
 * in the same minute as a join — on contest morning, which is precisely when
 * both happen.
 */
export async function teamEditVersion(db: Db, teamId: number): Promise<string> {
  const rows = await db.execute<{ slug: string; name: string; members: string }>(sql`
    select t.slug,
           t.name,
           coalesce((
             select string_agg(u.username, chr(31) order by u.username)
               from team_members tm join users u on u.id = tm.user_id
              where tm.team_id = t.id
           ), '') as members
      from teams t
     where t.id = ${teamId}
  `);
  const row = rows[0];
  if (!row) return digest(['team', 'gone', teamId]);
  return digest(['team', row.slug, row.name, row.members]);
}

/**
 * The refusal — D161.
 *
 * **409, not 422.** Nothing about the request is malformed; the world moved
 * under it. `PATCH /contests/{key}` already answers 409 `contest_started` for
 * the other refusal of that shape, and a 422 would put this in front of
 * `ZodValidationPipe`'s field attribution (D146), which has no field to
 * attribute it to.
 *
 * The message is what the form shows when it has no translation of its own,
 * so it says what happened and what to do, and it does not say *what* changed:
 * the token is a hash, and the pre-image these two tables would need to answer
 * that is history they do not keep.
 */
export type VersionedRecord = 'problem' | 'contest' | 'language_limits' | 'problem_set' | 'team';

/**
 * What each record is CALLED in the refusal. One table rather than five
 * sentences: the message differs by one noun, and five copies of one sentence
 * is five chances for one of them to stop saying "nothing was written".
 */
const NOUN: Record<VersionedRecord, string> = {
  problem: 'this problem',
  contest: 'this contest',
  language_limits: "this problem's language limits",
  problem_set: 'this problem set',
  team: 'this team',
};

export function versionConflict(kind: VersionedRecord): AppError {
  return new AppError(
    409,
    `${kind}_version_conflict`,
    `Somebody else saved ${NOUN[kind]} after you opened it. Nothing was written. ` +
      'Load the newer version and apply your change to it.',
  );
}
