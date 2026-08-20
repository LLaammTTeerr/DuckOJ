import { Body, Controller, Inject, Param, Patch } from '@nestjs/common';
import { AdminGrantRoleRequest, type AdminGrantRoleRequestDto, type AdminUserSummaryDto } from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor } from '../authn/auth.guard.js';
import { SessionOnly } from '../authn/session-only.guard.js';
import type { Actor } from '../authz/actor.js';
import { AdminUsersService } from './admin-users.service.js';

/**
 * No `@Public()` anywhere in this file: every handler here requires
 * authentication at the guard level before this controller ever sees the
 * request, and admin-only is then enforced inside `AdminUsersService`, not by
 * a decorator here — this controller carries no authorization logic of its
 * own.
 *
 * `@SessionOnly()` applied class-wide, exactly as `TokensController` does it:
 * minting an admin is a strictly stronger case than the credential-management
 * routes that decorator already protects. Without it, a scoped access token —
 * `Actor.scopes` constrains nothing outside `SessionOnlyGuard` itself; there
 * is no scope enforcement anywhere else — carries its owner's full authority,
 * and an admin's leaked token becomes a permanent admin-minting capability
 * that survives its own revocation (mint a fresh admin, then revoke nothing).
 * A machine credential must not be able to rewrite the credentials that
 * govern it.
 */
@Controller('admin/users')
@SessionOnly()
export class AdminUsersController {
  constructor(@Inject(AdminUsersService) private readonly adminUsers: AdminUsersService) {}

  @Patch(':username')
  grantRole(
    @CurrentActor() actor: Actor,
    @Param('username') username: string,
    @Body(new ZodValidationPipe(AdminGrantRoleRequest)) body: AdminGrantRoleRequestDto,
  ): Promise<AdminUserSummaryDto> {
    return this.adminUsers.grantRole(actor, username, body);
  }
}
