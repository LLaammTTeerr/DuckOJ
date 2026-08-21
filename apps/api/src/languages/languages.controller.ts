import { Controller, Get, Inject } from '@nestjs/common';
import type { LanguageListDto } from '@duckoj/contracts';
import { Public } from '../authn/auth.guard.js';
import { RequireScope } from '../authn/require-scope.decorator.js';
import { LanguagesService } from './languages.service.js';

/**
 * The sharpest gap `POST /submissions` left open (spec §2.1): nothing else
 * lists the `languageKey` values it will accept, so a caller that has not
 * read `scripts/seed-problem.ts` cannot submit at all. `@Public()` — signed
 * out or not, a caller must see this before it can even attempt a submission
 * — plus `@RequireScope('languages:read')`, so an anonymous caller reaches
 * it unconditionally (`AuthGuard` never requires an actor here) and a token
 * needs the scope to reach it (`ScopeGuard` short-circuits before the scope
 * check only when there is no actor at all).
 */
@Controller('languages')
export class LanguagesController {
  constructor(@Inject(LanguagesService) private readonly languages: LanguagesService) {}

  @Get()
  @Public()
  @RequireScope('languages:read')
  list(): Promise<LanguageListDto> {
    return this.languages.listAll();
  }
}
