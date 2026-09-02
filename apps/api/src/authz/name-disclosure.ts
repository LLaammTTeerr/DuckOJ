import { eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { orgMembers } from '@duckoj/db/guarded';
import { schema, searchFold, type Db } from '@duckoj/db';
import type { NameDisclosure } from '../config/config.schema.js';
import type { Actor } from './actor.js';

/**
 * "How much of this person may this reader see?", written ONCE (D197).
 *
 * ## Why this exists at all
 *
 * B-35 measured the chain and the number is the whole argument: a stranger
 * walks `GET /contests`, asks each round for its scoreboard, and collects
 * **142 usernames in 159 anonymous requests**; `GET /users/{username}` — still
 * `@Public()`, and correctly so — then dereferences each one into a
 * `displayName`. Adding the public roster page D191 kept, the problem
 * statistics' `firstSolver`/`fastest` and the clarification feed's askers,
 * that is **264 of 481 accounts, 54.9%, with real names, no account
 * required.**
 *
 * Neither end of that chain is wrong. A scoreboard that names its competitors
 * is what a scoreboard is FOR (D46, D192, D195), and a profile linked from one
 * has to open for a stranger. What is wrong is that the software has never
 * asked whether the name on the row is an adult's handle or a twelve-year-old's
 * full legal name — and on a provincial host, bulk-imported from a school's
 * spreadsheet (D61), it is overwhelmingly the second.
 *
 * So the disclosure level is a **deployment policy** (`NAME_DISCLOSURE`), and
 * this module is the one place that reads it.
 *
 * ## What is a person, and what is a number
 *
 * The policy bites on **identity**, not on identifiers and not on results.
 * The distinction is the reason a scoreboard needs no code at all here:
 *
 * - A **username** is an identifier a pupil chose or was issued, and it is on
 *   every scoreboard by design (D46, D192). It is never withheld.
 * - A **display name** and a profile's free-text **`about`** are identity: on
 *   a provincial host the first is a child's real full name (D61's spreadsheet
 *   import put it there) and the second is whatever they typed about
 *   themselves. Both move with this policy.
 * - `country`, `rating`, `globalRole`, `createdAt` and the solve counts are
 *   the numbers and badges a judge exists to publish, and D188 already argued
 *   them one at a time. None of them moves.
 *
 * So the scoreboard leaks identifiers and the profile leaks identity, and they
 * get different treatment on purpose: the board is left exactly as it is, and
 * the dereference at the end of it is where the switch lives.
 *
 * ## The shape of the answer: substitute, never omit
 *
 * A redacted row carries `displayName: <the username>` — it does not lose the
 * field, and the field is never null or empty. Three reasons, and all three
 * are load-bearing:
 *
 * - **No contract fork.** `UserSummary`, `OrgMember`, `TeamMember` and
 *   `ProblemSetProgressRow` keep the exact shape every client already parses;
 *   an optional `displayName` would make every renderer in `apps/web` grow a
 *   branch, and D188 already refused to fork `UserSummary` from `UserProfile`
 *   for the same reason.
 * - **D122's initial avatars are computed from the display name**, so they
 *   leak one too. Substitution degrades them to the handle's initials in the
 *   same step; blanking the field would have produced an avatar computed from
 *   an empty string on every redacted surface.
 * - **A scoreboard of handles is still a scoreboard.** That is the claim this
 *   ruling rests on, and the substitution is what makes it literally true:
 *   every column still holds a thing you can read, sort and click.
 *
 * ## One predicate, two forms
 *
 * The project's visibility rules are written once and used in two shapes — a
 * TypeScript predicate and a SQL clause — and this one is no different:
 *
 * - `presentName` and `presentAbout` are the **projection**: what a row's
 *   `displayName` says, and whether its free text is served at all.
 * - `nameSearchColumn` is the **haystack**: what `q` is allowed to match.
 *
 * The second is not decoration. D185's search matches a word prefix of the
 * folded `username || ' ' || display_name`, so a reader who is shown handles
 * but may still search the real names has a **name-recovery oracle**: `q=ng`,
 * `q=ngu`, `q=nguye` … each answer confirming another letter of a name the
 * projection just took away. A policy that redacts the column and leaves the
 * index open is theatre, and `name-disclosure.spec.ts` reds exactly that.
 *
 * `apps/api/test/name-disclosure-guard.spec.ts` (D198) is the D113-shaped
 * source scan that keeps every surface honest: a read of `users.display_name`
 * outside this module must either route through `presentName` or be an audited
 * allow-list entry saying why it is a write, an echo, or the reader's own name.
 */

/**
 * A reader, resolved once per read.
 *
 * Deliberately NOT per-subject. "May this reader see THIS pupil's name?" would
 * need the viewer's organizations intersected with the subject's on every row
 * of every scoreboard, results sheet and roster — an extra join on eight
 * surfaces, which is precisely the shape in which a seventh surface gets
 * forgotten (B-35's finding, one level up). It would also break the reader the
 * province actually has: a provincial round's organiser belongs to none of the
 * thirty schools whose pupils are in it, and their results CSV would print
 * thirty columns of handles.
 */
export interface NameAudience {
  /** Whether real display names may be rendered to this reader. */
  readonly full: boolean;
  /**
   * The reader's own account id, or `null`.
   *
   * You always see your own name, at every rung. Without this, a pupil under
   * `affiliated` whose school has not been created yet would open their own
   * settings page and be told their display name is their username — and then
   * save it.
   */
  readonly selfId: number | null;
}

/**
 * Resolve the reader.
 *
 * `authority` is passed by a surface that has **already** authorized this
 * caller over exactly these people — `canRunContest` on a results sheet, a
 * certificate, a seat slip; owner-or-admin-of-this-organization on a progress
 * grid. It is not an exemption bolted on beside the predicate; it is an input
 * TO the predicate, so the export paths reach "full names" by consulting the
 * rule rather than by skipping it. That distinction is the whole reason the
 * export paths are wired at all: D62's booklet leaked a private statement
 * because an export path had its own idea of what it might print, and a CSV or
 * a PDF is the artefact that leaves the building.
 *
 * The `affiliated` rung costs **one** `LIMIT 1` index probe, and only on that
 * rung, and only for a plain signed-in caller who is not already authority —
 * everything else short-circuits before touching the database.
 */
export async function nameAudience(
  db: Db,
  policy: NameDisclosure,
  actor: Actor | null,
  options: { authority?: boolean } = {},
): Promise<NameAudience> {
  const selfId = actor?.userId ?? null;

  // The rung an open public judge sets. Everything below is skipped, so
  // `NAME_DISCLOSURE=public` is byte-for-byte the behaviour before D197.
  if (policy === 'public') return { full: true, selfId };

  // An anonymous caller never has standing and never has a self row. This is
  // the case B-35 measured, and it is the one every rung above `public`
  // closes.
  if (actor === null) return { full: false, selfId: null };

  // Staff of the judge itself, and a caller a surface has already authorized
  // over these people. A setter is included because a fresh province has no
  // organizations yet, and a judge whose own staff cannot read a name until
  // somebody creates a school is a judge that cannot be set up.
  if (options.authority === true || actor.globalRole !== 'user') {
    return { full: true, selfId };
  }

  if (policy === 'authenticated') return { full: true, selfId };

  // `affiliated`: standing is a role in ANY organization. Not "an org shared
  // with the subject" — see `NameAudience` — and not "any account at all",
  // which is what `authenticated` already is and what D26's open registration
  // makes obtainable in thirty seconds.
  const [row] = await db
    .select({ present: sql<number>`1` })
    .from(orgMembers)
    .where(eq(orgMembers.userId, actor.userId))
    .limit(1);
  return { full: row !== undefined, selfId };
}

/**
 * Whether this reader is being shown this person's identity at all.
 *
 * The one place the two projections below agree, so a profile cannot withhold
 * a name and keep the free text, or say `identityRedacted: false` while
 * serving a handle.
 */
export function seesIdentity(audience: NameAudience, row: { userId?: number | null }): boolean {
  return audience.full || (audience.selfId !== null && row.userId === audience.selfId);
}

/**
 * What this row's `displayName` says to this reader.
 *
 * Pass `userId` wherever the query has it; a row without one simply never
 * matches the self case, which is correct for the surfaces that lack it (a
 * scoreboard export's team rows have no single account behind them).
 */
export function presentName(
  audience: NameAudience,
  row: { userId?: number | null; username: string; displayName: string },
): string {
  return seesIdentity(audience, row) ? row.displayName : row.username;
}

/**
 * What this row's `about` says to this reader: the text, or nothing.
 *
 * **Withheld rather than substituted, and that is the difference between the
 * two fields.** A display name has an obvious stand-in that keeps every screen
 * working — the handle, which a scoreboard already published. Free text a
 * pupil typed about themselves has none: it is the one field on a profile that
 * can say anything at all, including the things a display-name policy is meant
 * to protect (a class, a school, a birthday, a phone number, another handle),
 * and there is no shorter true version of it. `about` is already
 * `z.string().nullable()`, so `null` is a value every client already renders —
 * as the empty About section most profiles have.
 *
 * `country` is deliberately NOT here. It is one of two hundred coarse
 * self-declared values, it identifies nobody on a host where every account is
 * in one province, and D46's rank ramp and every judge's profile print it.
 * Withholding it would cost a real thing for no disclosure closed. Named here
 * rather than left to be wondered about.
 */
export function presentAbout(
  audience: NameAudience,
  row: { userId?: number | null; about: string | null },
): string | null {
  return seesIdentity(audience, row) ? row.about : null;
}

/**
 * The haystack `q` may search, which is the second form of the same rule.
 *
 * A `full` reader searches `users.search_fold`, the stored generated column
 * migration 0047 exists for — `username || ' ' || display_name`, folded, and
 * the reason a teacher can type either the account name or the child's name
 * into one box (D185).
 *
 * A redacted reader searches the **username alone**, folded per row. That is
 * deliberately the un-indexed path (0047 measured 172 ms against 4.2 ms on a
 * 25 000-account copy), and it is the right trade twice over: the only caller
 * who takes it is one with no standing in the province and no screen in this
 * product that needs it, and paying for a second stored column would be paying
 * to make an oracle fast.
 */
export function nameSearchColumn(audience: NameAudience): SQLWrapper | SQL<string> {
  return audience.full ? schema.users.searchFold : searchFold(sql`${schema.users.username}`);
}

/**
 * The rung in effect, fail-closed.
 *
 * The access services take their `AppConfig` as an OPTIONAL constructor
 * parameter, on D80's precedent — a spec that builds one by hand keeps
 * working. What a hand-built service must NOT get is the open rung by
 * accident, so an absent config reads as `affiliated`: the same answer an
 * operator who sets nothing gets, and the same direction the default leans.
 */
export function policyOf(config?: { nameDisclosure: NameDisclosure } | null): NameDisclosure {
  return config?.nameDisclosure ?? 'affiliated';
}
