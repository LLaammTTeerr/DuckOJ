import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { UsersController } from './users.controller.js';
import { UserAccessService } from '../authz/user.access.js';

// `AuthnModule` so `AuthGuard` resolves a session on the `@Public()` reads and
// `ScopeGuard` enforces `users:read`/`users:write` against a token. `DB` needs
// no import — `ConfigModule` is `@Global()`.
@Module({ imports: [AuthnModule], controllers: [UsersController], providers: [UserAccessService] })
export class UsersModule {}
