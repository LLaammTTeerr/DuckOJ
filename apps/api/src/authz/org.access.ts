import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { organizations, orgJoinRequests, orgMembers } from '@duckoj/db/guarded';
import { schema, type Db } from '@duckoj/db';
import type {
  AddOrgMemberRequestDto,
  CreateOrgRequest,
  OrgJoinRequestListDto,
  OrgJoinResultDto,
  OrgMemberDto,
  OrgMemberPageDto,
  OrgPageDto,
  OrgRoleDto,
  OrgSummaryDto,
  PaginationQueryDto,
  UpdateOrgRequestDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { isAdmin, type Actor } from './actor.js';
import { visibleOrgsWhere } from './org.visibility.js';

/** Postgres SQLSTATE for a unique-constraint violation. */
/** Advisory-lock namespace for the per-org owner invariant (two-int form). */
export const ORG_OWNER_LOCK = 0x0e6f7267; // 'org'

const UNIQUE_VIOLATION = '23505';

/**
 * What a write answers with: the first page of the roster it just changed.
 * `limit` matches `PaginationQuery`'s own default, so a write's body and the
 * client's first `GET .../members` describe the same page.
 */
const ROSTER_FIRST_PAGE: PaginationQueryDto = { limit: 25 };

/**
 * The longest a username can be (`RegisterRequest`'s own bound), which is
 * therefore the longest a roster cursor can meaningfully be. Refused rather
 * than passed through: a 100 KB cursor is not a page anybody left off at, and
 * every sibling list rejects a cursor its ordering column could never hold
 * (`invalid_cursor`, 422) rather than quietly scanning on it.
 */
const MAX_MEMBER_CURSOR = 64;

function parseMemberCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  if (cursor.length === 0 || cursor.length > MAX_MEMBER_CURSOR) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return cursor;
}
const ORG_SLUG_CONSTRAINT = 'organizations_slug_lower_idx';

/**
 * `z.input`, not `z.infer`: `visibility` and `joinPolicy` carry zod
 * defaults, so the output type (`CreateOrgRequestDto`) has both as
 * always-present. `create()` below keeps its own `?? 'private'` /
 * `?? 'request'` fallback — matching the zod defaults exactly — for a direct
 * (non-HTTP) caller that omits them, the same two-defaults trap
 * `problem.access.ts`'s `CreateProblemInput` guards against.
 */
export type CreateOrgInput = z.input<typeof CreateOrgRequest>;

export type UpdateOrgPatch = UpdateOrgRequestDto;

type OrgRow = { id: number; slug: string; visibility: 'public' | 'private' };

/**
 * The ONLY *service* permitted to import `@duckoj/db/guarded` for
 * organizations — with `org.visibility.ts` holding the shared visibility
 * condition and membership loader, exactly as `problem.visibility.ts` does
 * for problems. Every read of an organization anywhere in the API goes
 * through here, so visibility cannot be forgotten at a call site.
 */
@Injectable()
export class OrgAccessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  async listVisible(
    actor: Actor | null,
    // `cursor?: string | undefined` rather than `cursor?: string`: the project
    // compiles with `exactOptionalPropertyTypes`, under which a parsed
    // `PaginationQueryDto` is not assignable to the narrower form.
    page: Pick<PaginationQueryDto, 'limit'> & { cursor?: string | undefined },
  ): Promise<OrgPageDto> {
    const after = parseCursor(page.cursor);
    const rows = await this.db
      .select()
      .from(organizations)
      .where(and(visibleOrgsWhere(this.db, actor), gt(organizations.id, after)))
      .orderBy(asc(organizations.id))
      .limit(page.limit + 1);

    const page_ = rows.slice(0, page.limit);
    // One extra query for the whole page, never one per row: `myRole` is a
    // fact about the viewer, and asking per organization would make this
    // list's cost scale with its own page size.
    const mine = await this.rolesOf(actor, page_.map((row) => row.id));
    const items = page_.map((row) => toOrgSummary(row, mine.get(row.id) ?? null));
    const nextCursor = rows.length > page.limit ? String(items.at(-1)!.id) : null;
    return { items, nextCursor };
  }

  async getVisible(actor: Actor | null, slug: string): Promise<OrgSummaryDto> {
    const row = await this.findVisibleOrgRow(actor, slug);
    return toOrgSummary(row, await this.roleIn(actor, row.id));
  }

  /** The actor's role in each of `orgIds`, absent where they hold none. */
  private async rolesOf(actor: Actor | null, orgIds: number[]): Promise<Map<number, OrgRoleDto>> {
    if (!actor || orgIds.length === 0) return new Map();
    const rows = await this.db
      .select({ orgId: orgMembers.orgId, role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.userId, actor.userId), inArray(orgMembers.orgId, orgIds)));
    return new Map(rows.map((row) => [row.orgId, row.role]));
  }

  async roleIn(actor: Actor | null, orgId: number): Promise<'owner' | 'admin' | 'member' | null> {
    if (!actor) return null;
    return roleOf(this.db, orgId, actor.userId);
  }

  /**
   * `members` is visible to any caller who can see the organization at all
   * — reuses `findVisibleOrgRow`, the exact same 404 gate `getVisible` uses,
   * with no additional "must be a member" restriction layered on top. See
   * `OrgMember`'s doc comment in `@duckoj/contracts` for why: a private
   * organization already 404s here for everyone but a member or an admin, so
   * a narrower gate on top of that would be redundant, and a public
   * organization's roster is credit, not a secret — the same reasoning
   * `ProblemDetail.members` already applies.
   */
  async listMembers(
    actor: Actor | null,
    slug: string,
    query: PaginationQueryDto,
  ): Promise<OrgMemberPageDto> {
    const row = await this.findVisibleOrgRow(actor, slug);
    return this.rosterOf(row.id, query);
  }

  /**
   * Inserts the organization and its creator as `owner`, in one transaction
   * — mirroring `ProblemAccessService.create` seeding the creator as
   * `author`. Without this, a freshly created organization would have no
   * owner or admin at all, and `update`'s "owner or admin of that org"
   * branch would be permanently unreachable until membership mutation (an
   * explicitly out-of-scope join-request state machine) exists. This is
   * object creation seeding its own creator, not the invite/approve/remove
   * flow the spec excludes.
   *
   * Admin-only at the route (`orgs:write`, admin role) — creating an
   * organization is not something any signed-in user may do.
   *
   * A racing duplicate `slug` (case-insensitively) is caught as the unique
   * violation on `organizations_slug_lower_idx` and rethrown as
   * `organization_slug_taken` — never pre-checked with a SELECT, which
   * races (mirrors `problem.access.ts`'s `toCreateConflict` for problem
   * codes).
   */
  async create(actor: Actor | null, body: CreateOrgInput): Promise<OrgSummaryDto> {
    if (!isAdmin(actor)) {
      throw new AppError(403, 'organization_forbidden', 'You may not create organizations.');
    }

    // Matches `CreateOrgRequest`'s zod defaults exactly — see `CreateOrgInput`'s
    // doc comment for why the two must agree.
    const visibility = body.visibility ?? 'private';
    const joinPolicy = body.joinPolicy ?? 'request';

    let orgId: number;
    try {
      orgId = await this.db.transaction(async (tx) => {
        const [org] = await tx
          .insert(organizations)
          .values({ slug: body.slug, name: body.name, about: body.about ?? null, visibility, joinPolicy })
          .returning({ id: organizations.id });
        await tx.insert(orgMembers).values({ orgId: org!.id, userId: actor!.userId, role: 'owner' });
        return org!.id;
      });
    } catch (error) {
      throw toOrgConflict(error);
    }

    // The creator was just seeded as `owner` in the transaction above, so
    // that is what they are — no round trip needed to learn it.
    return toOrgSummary((await this.findRowById(orgId))!, 'owner');
  }

  /**
   * Loads the organization, then — in this exact order — (1) invisible →
   * 404 `organization_not_found` (never a distinct code, never a 403 — an
   * org the caller cannot see must not disclose its existence, not even via
   * a patch that would otherwise fail for an unrelated reason), (2) visible
   * but the actor is neither owner/admin of THIS org nor a global admin →
   * 403 `organization_forbidden`, (3) applies the patch. Mirrors
   * `ProblemAccessService.loadForEdit`/`update`'s ordering exactly.
   *
   * Reads the result back by id (`findRowById`, no visibility re-check) —
   * not by re-resolving the (possibly just-changed) slug through
   * `getVisible` — for the same reason `ProblemAccessService.loadDetailById`
   * skips a fresh visibility check: the caller just proved they may act on
   * this exact row, and re-deriving from a slug that may have just changed
   * underneath the read would be a pointless second lookup, not a safer one.
   */
  async update(actor: Actor | null, slug: string, patch: UpdateOrgPatch): Promise<OrgSummaryDto> {
    const { row } = await this.loadForEdit(actor, slug);

    const set: Partial<typeof organizations.$inferInsert> = {};
    if (patch.slug !== undefined) set.slug = patch.slug;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.about !== undefined) set.about = patch.about;
    if (patch.visibility !== undefined) set.visibility = patch.visibility;
    if (patch.joinPolicy !== undefined) set.joinPolicy = patch.joinPolicy;

    if (Object.keys(set).length > 0) {
      try {
        await this.db.update(organizations).set(set).where(eq(organizations.id, row.id));
      } catch (error) {
        throw toOrgConflict(error);
      }
    }

    return toOrgSummary((await this.findRowById(row.id))!, await this.roleIn(actor, row.id));
  }

  /**
   * Loads an organization row by slug (case-insensitively, matching
   * `organizations_slug_lower_idx`) with no visibility filtering at all —
   * 404s only if no organization has that slug, full stop. The first half of
   * the 404-then-403 ordering every write path needs; visibility is checked
   * separately by `findVisibleOrgRow`/`loadForEdit` so a caller who reaches
   * this point never learns anything beyond "some slug exists or does not".
   */
  private async findOrgRow(slug: string): Promise<OrgRow> {
    const row = (
      await this.db
        .select({ id: organizations.id, slug: organizations.slug, visibility: organizations.visibility })
        .from(organizations)
        .where(sql`lower(${organizations.slug}) = lower(${slug})`)
        .limit(1)
    )[0];
    if (!row) throw new AppError(404, 'organization_not_found', 'No such organization.');
    return row;
  }

  /** Row-wise form of `visibleOrgsWhere`, for a single already-loaded row. */
  private async canViewRow(actor: Actor | null, row: OrgRow): Promise<boolean> {
    if (isAdmin(actor)) return true;
    if (row.visibility === 'public') return true;
    if (!actor) return false;
    return (await this.roleIn(actor, row.id)) !== null;
  }

  /**
   * `findOrgRow` plus the visibility check, in that order — shared by
   * `getVisible` and `listMembers` so the 404 gate can only drift by editing
   * one place.
   */
  private async findVisibleOrgRow(actor: Actor | null, slug: string): Promise<typeof organizations.$inferSelect> {
    const row = (
      await this.db
        .select()
        .from(organizations)
        .where(and(visibleOrgsWhere(this.db, actor), sql`lower(${organizations.slug}) = lower(${slug})`))
        .limit(1)
    )[0];
    if (!row) throw new AppError(404, 'organization_not_found', 'No such organization.');
    return row;
  }

  /**
   * Loads a organization by slug and applies the shared 404-then-403
   * ordering every write path against an existing organization needs: an
   * invisible organization 404s (never a distinct error for "exists but you
   * may not act on it"), then a visible-but-uneditable one (a plain member,
   * or a non-member) 403s. `role` is returned for callers that need it, but
   * nothing here currently does beyond the check itself.
   */
  /**
   * Join, or ask to. The policy decides which, and the caller learns it from
   * both the status code and `outcome`.
   */
  async join(
    actor: Actor,
    slug: string,
  ): Promise<{ result: OrgJoinResultDto; created: boolean }> {
    const row = await this.findVisibleOrgRow(actor, slug);
    if ((await this.roleIn(actor, row.id)) !== null) {
      throw new AppError(409, 'organization_member_exists', 'You are already a member.');
    }

    if (row.joinPolicy === 'invite') {
      throw new AppError(
        403,
        'org_invite_only',
        'This organization admits members by invitation only.',
      );
    }

    if (row.joinPolicy === 'open') {
      // Race-safe: the roleIn pre-check above gives the friendly 409 in the
      // common case, but two concurrent joins both pass it — the insert
      // itself must decide. Empty `returning` means the other request won.
      const inserted = await this.db
        .insert(orgMembers)
        .values({ orgId: row.id, userId: actor.userId, role: 'member' })
        .onConflictDoNothing()
        .returning({ userId: orgMembers.userId });
      if (inserted.length === 0) {
        throw new AppError(409, 'organization_member_exists', 'You are already a member.');
      }
      return { result: { outcome: 'joined', role: 'member' }, created: true };
    }

    // `request`. Idempotent while one is pending: the partial unique index
    // makes the second insert a no-op rather than a second row an approver
    // would then see twice.
    const inserted = await this.db
      .insert(orgJoinRequests)
      .values({ orgId: row.id, userId: actor.userId })
      .onConflictDoNothing()
      .returning({ id: orgJoinRequests.id });
    // Deciders are notified only when a request row actually appeared —
    // `returning` is empty on the idempotent re-ask, and re-notifying every
    // owner each time someone re-clicks would train them to ignore the kind.
    if (inserted.length > 0) {
      const [requester] = await this.db
        .select({ username: schema.users.username })
        .from(schema.users)
        .where(eq(schema.users.id, actor.userId))
        .limit(1);
      const deciders = await this.db
        .select({ userId: orgMembers.userId, role: orgMembers.role })
        .from(orgMembers)
        .where(eq(orgMembers.orgId, row.id));
      for (const member of deciders) {
        if (member.role !== 'owner' && member.role !== 'admin') continue;
        await this.notifications.notify(this.db, member.userId, 'org_join_requested', {
          orgSlug: row.slug,
          username: requester?.username ?? '',
        });
      }
    }
    return { result: { outcome: 'requested', role: null }, created: false };
  }

  /** Pending requests, oldest first. Owner or admin. */
  async listRequests(actor: Actor, slug: string): Promise<OrgJoinRequestListDto> {
    const { row } = await this.loadForEdit(actor, slug);
    const rows = await this.db
      .select({
        id: orgJoinRequests.id,
        username: schema.users.username,
        createdAt: orgJoinRequests.createdAt,
      })
      .from(orgJoinRequests)
      .innerJoin(schema.users, eq(schema.users.id, orgJoinRequests.userId))
      .where(and(eq(orgJoinRequests.orgId, row.id), eq(orgJoinRequests.state, 'pending')))
      .orderBy(asc(orgJoinRequests.id));
    return rows.map((r) => ({ id: r.id, username: r.username, createdAt: r.createdAt.toISOString() }));
  }

  /** Approve or reject. Both the membership and the audit row, or neither. */
  async decideRequest(
    actor: Actor,
    slug: string,
    requestId: number,
    approve: boolean,
  ): Promise<OrgMemberPageDto> {
    const { row } = await this.loadForEdit(actor, slug);
    await this.db.transaction(async (tx) => {
      const [request] = await tx
        .select({ id: orgJoinRequests.id, userId: orgJoinRequests.userId, state: orgJoinRequests.state })
        .from(orgJoinRequests)
        .where(and(eq(orgJoinRequests.id, requestId), eq(orgJoinRequests.orgId, row.id)))
        .limit(1)
        .for('update');
      if (!request) {
        throw new AppError(404, 'join_request_not_found', 'No such join request.');
      }
      // 409 rather than a silent no-op: a second decider is acting on
      // information they believe is current, and it is not.
      if (request.state !== 'pending') {
        throw new AppError(409, 'join_request_decided', 'That request has already been decided.');
      }

      await tx
        .update(orgJoinRequests)
        .set({
          state: approve ? 'approved' : 'rejected',
          decidedBy: actor.userId,
          decidedAt: new Date(),
        })
        .where(eq(orgJoinRequests.id, request.id));

      if (approve) {
        // `onConflictDoNothing` because an admin may have added them directly
        // between the request and its approval; the request is still decided.
        await tx
          .insert(orgMembers)
          .values({ orgId: row.id, userId: request.userId, role: 'member' })
          .onConflictDoNothing();
      }
      // Same transaction as the decision: a decided request whose
      // notification failed to write rolls back together with it.
      await this.notifications.notify(tx, request.userId, 'org_join_decided', {
        orgSlug: row.slug,
        approved: approve,
      });
    });
    return this.rosterOf(row.id);
  }

  /** Adds a member directly. Owner or admin; only an owner may grant a rank. */
  async addMember(actor: Actor, slug: string, body: AddOrgMemberRequestDto): Promise<OrgMemberPageDto> {
    const { row, role } = await this.loadForEdit(actor, slug);
    const effective = isAdmin(actor) ? 'owner' : role;
    if (body.role !== 'member' && effective !== 'owner') {
      throw new AppError(403, 'organization_forbidden', 'Only an owner may grant that role.');
    }
    const target = await this.userIdOf(body.username);
    if ((await this.roleIn({ ...actor, userId: target }, row.id)) !== null) {
      throw new AppError(409, 'organization_member_exists', 'They are already a member.');
    }
    // Same race shape as the open join: a concurrent approval or direct add
    // can land between the pre-check and this insert.
    const added = await this.db
      .insert(orgMembers)
      .values({ orgId: row.id, userId: target, role: body.role })
      .onConflictDoNothing()
      .returning({ userId: orgMembers.userId });
    if (added.length === 0) {
      throw new AppError(409, 'organization_member_exists', 'They are already a member.');
    }
    return this.rosterOf(row.id);
  }

  /** Removes a member. Owner or admin, or yourself leaving. */
  async removeMember(actor: Actor, slug: string, username: string): Promise<OrgMemberPageDto> {
    const row = await this.findVisibleOrgRow(actor, slug);
    const target = await this.userIdOf(username);
    const targetRole = await this.roleIn({ ...actor, userId: target }, row.id);
    if (targetRole === null) {
      throw new AppError(404, 'organization_member_not_found', 'They are not a member.');
    }

    // Leaving is this same route with your own name, so one code path decides
    // whether a removal is allowed.
    if (target !== actor.userId) await this.requireOutranks(actor, row.id, targetRole);

    // The last-owner check and the delete must be atomic per organization:
    // two concurrent owner-removals each counting "2 owners remain" is how
    // an org ends up with zero, a state only a database edit repairs. A
    // per-org advisory lock inside one transaction serialises exactly the
    // writers that contend on this invariant and nobody else.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ORG_OWNER_LOCK}, ${row.id})`);
      // Re-read INSIDE the lock. `targetRole` above was fetched on another
      // connection before any of this was serialised, and it is the value
      // `assertNotLastOwner` branches on: a target read as `member` skips
      // the check entirely. Promote that member to owner and remove the
      // previous one while this call waits at the lock — two ordinary
      // requests can do it — and the delete below lands on the only owner
      // with the guard never having run. The stale read stays useful for
      // the 404 and the rank check, which are about the caller's intent at
      // the time they asked; only the invariant needs the current truth.
      const current = await roleOf(tx, row.id, target);
      if (current === null) {
        throw new AppError(404, 'organization_member_not_found', 'They are not a member.');
      }
      await this.assertNotLastOwner(tx, row.id, current, null);
      await tx
        .delete(orgMembers)
        .where(and(eq(orgMembers.orgId, row.id), eq(orgMembers.userId, target)));
    });
    return this.rosterOf(row.id);
  }

  /** Sets a member's role. Owner only. */
  async setMemberRole(
    actor: Actor,
    slug: string,
    username: string,
    role: OrgRoleDto,
  ): Promise<OrgMemberPageDto> {
    const { row, role: actorRole } = await this.loadForEdit(actor, slug);
    if (!isAdmin(actor) && actorRole !== 'owner') {
      throw new AppError(403, 'organization_forbidden', 'Only an owner may set roles.');
    }
    const target = await this.userIdOf(username);
    const targetRole = await this.roleIn({ ...actor, userId: target }, row.id);
    if (targetRole === null) {
      throw new AppError(404, 'organization_member_not_found', 'They are not a member.');
    }
    // Same advisory-locked transaction as removeMember, and the same
    // re-read for the same reason: the role this demotion is judged against
    // must be the one the organization currently holds, not the one it held
    // before the lock was taken.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ORG_OWNER_LOCK}, ${row.id})`);
      const current = await roleOf(tx, row.id, target);
      if (current === null) {
        throw new AppError(404, 'organization_member_not_found', 'They are not a member.');
      }
      await this.assertNotLastOwner(tx, row.id, current, role);
      await tx
        .update(orgMembers)
        .set({ role })
        .where(and(eq(orgMembers.orgId, row.id), eq(orgMembers.userId, target)));
    });
    return this.rosterOf(row.id);
  }

  /**
   * **The invariant everything else hangs off**: an organization always has at
   * least one owner (design §3).
   *
   * Checked here and nowhere else, by every path that could remove ownership —
   * leaving, removal, and demotion. Three copies of this rule would be three
   * chances to strand an organization with nobody who can administer it, and
   * the only repair for that is a database edit.
   *
   * `nextRole` is `null` for a removal, or the role being assigned. The target
   * does not need naming: if they are an owner and the organization has only
   * one, that one is them.
   */
  private async assertNotLastOwner(
    tx: Db,
    orgId: number,
    currentRole: OrgRoleDto,
    nextRole: OrgRoleDto | null,
  ): Promise<void> {
    if (currentRole !== 'owner') return;
    if (nextRole === 'owner') return;
    const owners = await tx
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner')));
    if (owners.length <= 1) {
      throw new AppError(
        409,
        'org_last_owner',
        'An organization must always have at least one owner.',
      );
    }
  }

  /**
   * `owner > admin > member`, and an actor may act only on someone **strictly**
   * below them. Writing this as "below or equal" reads identically and lets an
   * admin remove another admin, which no happy-path test notices.
   */
  private async requireOutranks(actor: Actor, orgId: number, targetRole: OrgRoleDto): Promise<void> {
    if (isAdmin(actor)) return;
    const rank = { member: 0, admin: 1, owner: 2 } as const;
    const mine = await this.roleIn(actor, orgId);
    if (mine === null || rank[mine] <= rank[targetRole]) {
      throw new AppError(403, 'organization_forbidden', 'You may not act on that member.');
    }
  }

  private async userIdOf(username: string): Promise<number> {
    const [user] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.username}) = lower(${username})`)
      .limit(1);
    if (!user) throw new AppError(404, 'user_not_found', 'No such user.');
    return user.id;
  }

  /**
   * One keyset page of a roster (D58), ordered by username.
   *
   * The cursor is the last username on the page rather than a row id: the
   * ordering column IS the cursor, which is what makes the page stable while
   * people join and leave underneath it — a member added before the cursor
   * cannot push a later one onto a page the client has already seen, and one
   * removed cannot make it skip a row. `users.username` is unique, so no
   * tiebreaker is needed; `>` and `ORDER BY` resolve under the same
   * collation, so the walk cannot disagree with the sort.
   *
   * The writes call this with `ROSTER_FIRST_PAGE` — see `OrgMemberPage`'s
   * doc comment in `@duckoj/contracts` for why a write answers a bounded
   * page rather than the roster it just changed.
   */
  private async rosterOf(orgId: number, query: PaginationQueryDto = ROSTER_FIRST_PAGE): Promise<OrgMemberPageDto> {
    const after = parseMemberCursor(query.cursor);
    const rows = await this.db
      .select({
        username: schema.users.username,
        role: orgMembers.role,
        joinedAt: orgMembers.joinedAt,
      })
      .from(orgMembers)
      .innerJoin(schema.users, eq(schema.users.id, orgMembers.userId))
      .where(
        after === null
          ? eq(orgMembers.orgId, orgId)
          : and(eq(orgMembers.orgId, orgId), gt(schema.users.username, after)),
      )
      .orderBy(asc(schema.users.username))
      // One row past the page, so "is there more" is answered by the same
      // query rather than by a second COUNT that could disagree with it.
      .limit(query.limit + 1);

    const items: OrgMemberDto[] = rows
      .slice(0, query.limit)
      .map((r) => ({ username: r.username, role: r.role as OrgRoleDto, joinedAt: r.joinedAt.toISOString() }));
    return {
      items,
      nextCursor: rows.length > query.limit ? items.at(-1)!.username : null,
    };
  }

  private async loadForEdit(actor: Actor | null, slug: string): Promise<{ row: OrgRow; role: OrgRoleDto | null }> {
    const row = await this.findOrgRow(slug);
    if (!(await this.canViewRow(actor, row))) {
      throw new AppError(404, 'organization_not_found', 'No such organization.');
    }
    const role = await this.roleIn(actor, row.id);
    if (!isAdmin(actor) && role !== 'owner' && role !== 'admin') {
      throw new AppError(403, 'organization_forbidden', 'You may not edit this organization.');
    }
    return { row, role };
  }

  /**
   * Fetches an organization by id with no visibility check — the caller has
   * already established the actor may act on it (as its creator, or having
   * just passed `loadForEdit`'s edit check). Mirrors
   * `ProblemAccessService.loadDetailById`.
   */
  private async findRowById(id: number): Promise<typeof organizations.$inferSelect | undefined> {
    return (await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1))[0];
  }
}

/**
 * One member's role in one organization, on whatever connection is passed —
 * `this.db` for the ordinary checks, the *transaction* for the ones taken
 * under `ORG_OWNER_LOCK`. A free function rather than a method so a caller
 * cannot accidentally ask `this.db` a question it needs the locked
 * transaction to answer, which is precisely the bug this shape fixes.
 */
async function roleOf(db: Db, orgId: number, userId: number): Promise<OrgRoleDto | null> {
  const rows = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/**
 * Translates a Postgres unique-violation raised by a racing INSERT/UPDATE
 * into the same 409 a SELECT-then-write pre-check would have produced had it
 * won the race. Duplicated from `problem.access.ts`'s `toCreateConflict`
 * rather than shared — the two live in different layers and each maps a
 * different constraint name, matching that file's own precedent for why
 * `auth.service.ts`'s `toRegistrationConflict` is not reused either.
 */
function toOrgConflict(error: unknown): unknown {
  const pgError = asUniqueViolation(error);
  if (pgError?.constraint_name === ORG_SLUG_CONSTRAINT) {
    return new AppError(409, 'organization_slug_taken', 'That organization slug is already taken.');
  }
  return error;
}

function asUniqueViolation(error: unknown): { code: string; constraint_name?: string } | undefined {
  if (isUniqueViolationShape(error)) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return isUniqueViolationShape(cause) ? cause : undefined;
}

function isUniqueViolationShape(value: unknown): value is { code: string; constraint_name?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Cursors are opaque to clients but are ids here. A non-numeric cursor is a
 * client mistake, not a server fault: reject it as a validation problem rather
 * than letting `NaN` reach the driver and surface as a 500.
 */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const after = Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new AppError(422, 'invalid_cursor', 'That page cursor is not valid.');
  }
  return after;
}

function toOrgSummary(row: typeof organizations.$inferSelect, myRole: OrgRoleDto | null): OrgSummaryDto {
  return {
    myRole,
    id: row.id,
    slug: row.slug,
    name: row.name,
    about: row.about,
    visibility: row.visibility,
    joinPolicy: row.joinPolicy,
    createdAt: row.createdAt.toISOString(),
  };
}
