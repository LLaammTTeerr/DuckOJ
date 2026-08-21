import { z } from 'zod';
import { registry } from './registry.js';

/**
 * The full set of `POST /submissions`-valid keys is otherwise undiscoverable
 * except by reading `scripts/seed-problem.ts` — this route closes that gap
 * (spec §2.1). Inactive languages are **included, flagged**, not hidden: a
 * submission made against a language that was later deactivated must still
 * be able to render `languageKey`'s human name, which means every consumer
 * needs the inactive row too, not a dangling key with nothing behind it.
 */
export const Language = z.object({
  key: z.string(),
  name: z.string(),
  extension: z.string(),
  isActive: z.boolean(),
});
export type LanguageDto = z.infer<typeof Language>;

/**
 * Deliberately not `cursorPage(Language)`: the table this reads from
 * (`schema.languages`) has no visibility rule and, in practice, a handful of
 * rows — nothing here today or foreseeably needs a second page. If that ever
 * changes, adopting `cursorPage` is an additive, non-breaking response shape
 * change (`items` stays, `nextCursor` gets added), not a rename.
 */
export const LanguageList = z.object({ items: z.array(Language) });
export type LanguageListDto = z.infer<typeof LanguageList>;

registry.registerPath({
  method: 'get',
  path: '/languages',
  summary: 'Every language POST /submissions accepts a languageKey for, active or not',
  responses: {
    200: {
      description: 'Every language, including inactive ones (flagged via isActive, not omitted)',
      content: { 'application/json': { schema: LanguageList } },
    },
  },
});
