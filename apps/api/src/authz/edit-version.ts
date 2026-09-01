/**
 * The concurrency token two edit forms carry — D161.
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
export function versionConflict(kind: 'problem' | 'contest'): AppError {
  return new AppError(
    409,
    `${kind}_version_conflict`,
    kind === 'problem'
      ? 'Somebody else saved this problem after you opened it. Nothing was written. ' +
        'Load the newer version and apply your change to it.'
      : 'Somebody else saved this contest after you opened it. Nothing was written. ' +
        'Load the newer version and apply your change to it.',
  );
}
