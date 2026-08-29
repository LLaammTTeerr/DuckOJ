import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { TagsController } from './tags.controller.js';
import { TagsService } from './tags.service.js';

// `AuthnModule` for the same reason `LanguagesModule` imports it on an
// all-`@Public()` controller: `AuthGuard` still resolves a signed-in
// caller's session and `ScopeGuard` still enforces `problems:read` against a
// token. `DB` needs no explicit import — `ConfigModule` is `@Global()`.
@Module({ imports: [AuthnModule], controllers: [TagsController], providers: [TagsService] })
export class TagsModule {}
