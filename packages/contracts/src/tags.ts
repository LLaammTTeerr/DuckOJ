import { z } from 'zod';
import { registry } from './registry.js';

/**
 * A topic tag, expanded. Both names travel together, always: the client
 * picks by the viewer's active locale (D18 — two locales, no negotiation
 * round-trip), and a response that carried only the "current" one would make
 * the language switch a refetch of every problem on screen.
 *
 * `slug` is the identity — what `?tag=` carries, what `PATCH /problems/{code}`
 * names, and the only part of this object that is stable across a rename of
 * either name.
 */
export const Tag = z.object({
  slug: z.string(),
  nameVi: z.string(),
  nameEn: z.string(),
});
export type TagDto = z.infer<typeof Tag>;

/**
 * Deliberately not `cursorPage(Tag)`, on `LanguageList`'s reasoning exactly:
 * this is a closed vocabulary seeded by a migration, twenty-five rows today
 * and never thousands. Adding `nextCursor` later would be additive, not a
 * rename.
 */
export const TagList = z.object({ items: z.array(Tag) });
export type TagListDto = z.infer<typeof TagList>;

/**
 * A problem's difficulty: the setter's own 1–10 estimate, `null` for "nobody
 * has said". Not derived from solve rates — see the column's doc comment in
 * `packages/db/src/schema/guarded.ts`.
 */
export const Difficulty = z.number().int().min(1).max(10);
export type DifficultyDto = z.infer<typeof Difficulty>;

/** The coercing twin for query strings, where `?difficultyMin=3` is `"3"`. */
export const DifficultyQuery = z.coerce.number().int().min(1).max(10);

registry.registerPath({
  method: 'get',
  path: '/tags',
  tags: ['Problems'],
  summary: 'Every topic tag a problem can carry',
  responses: {
    200: {
      description: 'The whole vocabulary, ordered by slug',
      content: { 'application/json': { schema: TagList } },
    },
  },
});
