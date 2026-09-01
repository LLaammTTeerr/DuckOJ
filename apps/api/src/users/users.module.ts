import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { UsersController } from './users.controller.js';
import { UserAccessService } from '../authz/user.access.js';
import { RateLimiter } from '../common/rate-limiter.js';

// `AuthnModule` so `AuthGuard` resolves a session on the `@Public()` reads and
// `ScopeGuard` enforces `users:read`/`users:write` against a token. `DB` needs
// no import — `ConfigModule` is `@Global()`.
//
// `RateLimiter` is provided here rather than imported, on `SubmissionsModule`'s
// precedent and for its reason: it is stateless (it counts rows in
// `rate_events`), so a second instance costs nothing, and importing the module
// that owns it would close a cycle. D188's walk meter is what needs it.
@Module({
  imports: [AuthnModule, AuthzModule],
  controllers: [UsersController],
  providers: [UserAccessService, RateLimiter],
})
export class UsersModule {}
