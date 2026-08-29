import { bigserial, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The topic taxonomy — "graphs", "dynamic programming", "number theory".
 *
 * Unguarded, on `languages`' precedent rather than `problems`': a tag row
 * carries no visibility rule of its own. Every tag is visible to every
 * caller, signed in or not (`GET /tags` is `@Public()`), because the list is
 * a fixed vocabulary a filter bar has to be able to render before it knows
 * which problems the viewer may see. What IS guarded is the *association* —
 * `problem_tags` lives in `guarded.ts`, because "which tags does THIS
 * problem carry" is exactly a question about a problem the viewer may not
 * be allowed to see (D35).
 *
 * Two name columns rather than one plus a translation table: the app has
 * exactly two locales and always will (D18), and the alternative shape
 * (`tag_names(tag_id, locale, name)`) buys a join and a missing-row case in
 * exchange for generality nothing here asks for.
 */
export const tags = pgTable(
  'tags',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /**
     * The stable, URL-safe identity — what `?tag=` carries, what a PATCH
     * names, and what the seed migration pins. Vietnamese, unaccented
     * (`quy-hoach-dong`), so it survives a URL, a shell and a filename
     * without escaping.
     */
    slug: text('slug').notNull(),
    nameVi: text('name_vi').notNull(),
    nameEn: text('name_en').notNull(),
  },
  (t) => [uniqueIndex('tags_slug_idx').on(t.slug)],
);
