import { Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import {
  UpdateMeRequest,
  UserListQuery,
  type UpdateMeRequestDto,
  type UserListQueryDto,
  type UserPageDto,
  type UserProfileDto,
} from '@duckoj/contracts';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { CurrentActor, Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import type { Actor } from '../authz/actor.js';
import { UserAccessService } from '../authz/user.access.js';

@Controller('users')
export class UsersController {
  // Explicit `@Inject`, like every other controller here: this build does not
  // emit decorator metadata, so implicit constructor injection resolves to
  // `undefined` and fails at the first request rather than at module init.
  constructor(@Inject(UserAccessService) private readonly users: UserAccessService) {}

  /**
   * `/me` is declared before `/:username` so Nest matches it first — otherwise
   * a PATCH to `/users/me` would bind `username = 'me'`. Nest resolves routes
   * in declaration order, so this ordering is load-bearing, not cosmetic.
   *
   * Deliberately no `@Public()`: editing yourself requires knowing who you are.
   */
  @Patch('me')
  @RequireScope('users:write')
  updateMe(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(UpdateMeRequest)) body: UpdateMeRequestDto,
  ): Promise<UserProfileDto> {
    return this.users.updateMe(actor, body);
  }

  @Get()
  @Public()
  @RequireScope('users:read')
  list(
    @Query(new ZodValidationPipe(UserListQuery)) query: UserListQueryDto,
  ): Promise<UserPageDto> {
    return this.users.list(query);
  }

  @Get(':username')
  @Public()
  @RequireScope('users:read')
  get(@Param('username') username: string): Promise<UserProfileDto> {
    return this.users.getByUsername(username);
  }
}
