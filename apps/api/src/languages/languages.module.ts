import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { LanguagesController } from './languages.controller.js';
import { LanguagesService } from './languages.service.js';

// `AuthnModule` for the same reason `ProblemsModule`/`OrgsModule` import it
// on an all-`@Public()` controller: `AuthGuard` still resolves a signed-in
// caller's session cookie here (harmlessly unused today, since `list()`
// takes no actor) and `ScopeGuard` still enforces `languages:read` against a
// token. `DB` needs no explicit import — `ConfigModule` is `@Global()`.
@Module({ imports: [AuthnModule], controllers: [LanguagesController], providers: [LanguagesService] })
export class LanguagesModule {}
