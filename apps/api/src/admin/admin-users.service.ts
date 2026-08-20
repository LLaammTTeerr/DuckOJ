import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
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
 * than trusting the controller to have checked first.
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

    // Case-insensitive, matching `users_username_lower_idx` — the same
    // pattern `ProblemAccessService.resolveMemberIds` uses to resolve a
    // username, and for the same reason: an exact-match `eq()` against a
    // case-folded unique index is a real bug this phase already paid for
    // once.
    const [row] = await this.db
      .update(schema.users)
      .set({ globalRole: body.globalRole, updatedAt: new Date() })
      .where(sql`lower(${schema.users.username}) = lower(${username})`)
      .returning({ id: schema.users.id, username: schema.users.username, globalRole: schema.users.globalRole });

    if (!row) {
      throw new AppError(404, 'user_not_found', `No such user: ${username}.`);
    }
    return row;
  }
}
