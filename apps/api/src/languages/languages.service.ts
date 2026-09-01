import { Inject, Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import type { LanguageListDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';

/**
 * `schema.languages` carries no visibility rule — it is not one of the
 * guarded tables `@duckoj/db/guarded` restricts to `apps/api/src/authz/**`
 * (see `eslint.config.js`), and there is no actor-dependent question to
 * answer here the way `ProblemAccessService`/`OrgAccessService` answer "can
 * this actor see this row". Every language, active or not, is visible to
 * every caller, signed in or not. That is what makes a thin service —
 * rather than a fourth `*.access.ts` in `authz/` — the right shape: an
 * `authz/` service exists to be the *one* place a guarded table's visibility
 * rule is decided, and there is no rule to decide here. This mirrors
 * `PackagesService`, the other precedent for a plain, non-`authz/` service
 * reading an unguarded table directly.
 */
@Injectable()
export class LanguagesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Inactive languages are included, not filtered out: a submission made
   * against a language later deactivated still needs its name renderable,
   * and hiding the row would force every consumer to cope with a dangling
   * `languageKey` instead. `isActive` is how a caller distinguishes
   * "gradeable right now" from "exists, but `POST /submissions` will 404
   * `language_not_found` for it" — see `SubmissionAccessService.create`.
   */
  async listAll(): Promise<LanguageListDto> {
    const rows = await this.db
      .select({
        key: schema.languages.key,
        name: schema.languages.name,
        extension: schema.languages.extension,
        isActive: schema.languages.isActive,
        // D154. On the wire because they change the limit a pupil is graded
        // against: a multiplier the judge enforces but the API will not name
        // is not a limit, it is a surprise. The number actually in force on a
        // given problem is `ProblemDetail.languageLimits` — these are the
        // defaults it is computed from.
        timeMultiplierPct: schema.languages.timeMultiplierPct,
        memoryExtraKb: schema.languages.memoryExtraKb,
      })
      .from(schema.languages)
      .orderBy(asc(schema.languages.key));
    return { items: rows };
  }
}
