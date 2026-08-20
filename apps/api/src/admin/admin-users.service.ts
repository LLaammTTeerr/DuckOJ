import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import type { AdminGrantRoleRequestDto, AdminUserSummaryDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { isAdmin, type Actor } from '../authz/actor.js';

/**
 * Mirrors `identity.ts`'s `globalRole` pgEnum. Duplicated here (rather than
 * imported) because the enum's members are also the schema's own runtime
 * source of truth for the Postgres `global_role` type — this is the request
 * body's independent domain check, kept in the service (not
 * `ZodValidationPipe`) so an unknown role answers the specific 400
 * `admin_role_invalid` this route documents, not the pipe's generic 422.
 */
const VALID_GLOBAL_ROLES = new Set<AdminUserSummaryDto['globalRole']>(['user', 'setter', 'admin']);

function isValidGlobalRole(value: string): value is AdminUserSummaryDto['globalRole'] {
  return VALID_GLOBAL_ROLES.has(value as AdminUserSummaryDto['globalRole']);
}

/**
 * `users.globalRole` is what `canCreateProblem` (and any future admin-only
 * check) reads. Nothing before this task could ever change it after account
 * creation, which made `POST /problems` unreachable end-to-end against a real
 * stack: `setter` had no path to be granted at all.
 *
 * Admin-only, enforced here — not by a route decorator alone — exactly as
 * `ProblemAccessService.create` enforces `canCreateProblem` itself rather
 * than trusting the controller to have checked first. The controller also
 * carries `@UseGuards(SessionOnlyGuard)`, so a scoped access token can never
 * reach here at all — this service does not re-check `actor.via` itself,
 * trusting the guard the same way `ProblemAccessService` trusts `AuthGuard`
 * to have attached an actor before any handler runs.
 */
@Injectable()
export class AdminUsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async grantRole(
    actor: Actor,
    username: string,
    body: AdminGrantRoleRequestDto,
  ): Promise<AdminUserSummaryDto> {
    if (!isAdmin(actor)) {
      throw new AppError(403, 'admin_forbidden', 'Only an admin may change a global role.');
    }
    if (!isValidGlobalRole(body.globalRole)) {
      throw new AppError(400, 'admin_role_invalid', `Unknown global role: ${body.globalRole}.`);
    }

    // Resolved to an id first, case-insensitively — matching
    // `users_username_lower_idx`, the same pattern
    // `ProblemAccessService.resolveMemberIds` uses to resolve a username, and
    // for the same reason an exact-match `eq()` against a case-folded unique
    // index is a real bug this phase already paid for once. Resolving to an
    // id here (rather than comparing `username` strings below) is also what
    // the self-demotion check needs: `MixedCase` vs `mixedcase` must resolve
    // to the same person before that comparison means anything.
    const [target] = await this.db
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .where(sql`lower(${schema.users.username}) = lower(${username})`)
      .limit(1);

    if (!target) {
      throw new AppError(404, 'user_not_found', `No such user: ${username}.`);
    }

    // Refuse self-demotion out of admin, rather than counting remaining
    // admins and only refusing the last one. A count is racy: two admins
    // demoting each other concurrently would each read "2 admins remain" and
    // both succeed, leaving zero — closing that race properly needs a
    // row lock and a transaction, to guard a scenario that requires two
    // administrators actively racing each other, which is not the realistic
    // failure mode. "You cannot demote yourself" needs no count, has no
    // race, and completely blocks the realistic accident: a sole admin
    // fat-fingering their own role and locking themselves (and everyone
    // else) out, recoverable only via raw SQL. The exotic multi-admin race
    // stays unhandled, deliberately, rather than fixed with a lock nothing
    // here otherwise needs.
    if (actor.userId === target.id && body.globalRole !== 'admin') {
      throw new AppError(
        400,
        'admin_self_demotion',
        'You cannot remove your own admin role. Have another admin do it, or grant it back to yourself first.',
      );
    }

    const [row] = await this.db
      .update(schema.users)
      .set({ globalRole: body.globalRole, updatedAt: new Date() })
      .where(eq(schema.users.id, target.id))
      .returning({ id: schema.users.id, username: schema.users.username, globalRole: schema.users.globalRole });

    return row!;
  }
}
