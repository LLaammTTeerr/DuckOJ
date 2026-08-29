import { Inject, Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { schema, type Db } from '@duckoj/db';
import type { TagListDto } from '@duckoj/contracts';
import { DB } from '../config/config.module.js';

/**
 * A plain service, not a fourth `authz/*.access.ts`, on `LanguagesService`'s
 * precedent exactly: `schema.tags` is not one of the guarded tables (see
 * `eslint.config.js`) and there is no actor-dependent question to answer
 * here — every tag is visible to every caller, signed in or not.
 *
 * The actor-dependent half of this feature is the *association*:
 * `problem_tags` IS guarded, and D35's "hide the hint during a contest"
 * lives in `ProblemAccessService` where it belongs. Splitting it that way is
 * what keeps this file free of any rule at all.
 */
@Injectable()
export class TagsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The whole vocabulary, ordered by slug — the same order tags come back in
   * on a problem, so a filter bar and a chip row agree about where a tag
   * sits. Unpaginated by design (`TagList`'s doc comment): twenty-five rows,
   * seeded by migration 0018.
   */
  async listAll(): Promise<TagListDto> {
    const items = await this.db
      .select({ slug: schema.tags.slug, nameVi: schema.tags.nameVi, nameEn: schema.tags.nameEn })
      .from(schema.tags)
      .orderBy(asc(schema.tags.slug));
    return { items };
  }
}
