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
  /**
   * How much of a problem's authored time limit this language gets, as a
   * WHOLE PERCENT (D154). 100 is "exactly what the setter wrote"; `python3`
   * is seeded at 300.
   *
   * On the contract rather than in a server constant because it changes the
   * number a pupil is graded against, and a limit the judge enforces but the
   * API will not name is not a limit — it is a surprise. An integer percent
   * rather than a float because the API computes it to DISPLAY and `judged`
   * computes it to ENFORCE, and the two must be the same number.
   */
  timeMultiplierPct: z.number().int(),
  /**
   * Kilobytes ADDED to a problem's authored memory limit for this language
   * (D154). Additive, not a multiplier: an interpreter's cost is a fixed
   * floor — CPython 3.11 occupies about 15 MB in this judge's image before
   * the solution allocates anything — and a floor does not scale with how
   * generous the problem is.
   */
  memoryExtraKb: z.number().int(),
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
  tags: ['Languages'],
  summary: 'Every language POST /submissions accepts a languageKey for, active or not',
  responses: {
    200: {
      description: 'Every language, including inactive ones (flagged via isActive, not omitted)',
      content: { 'application/json': { schema: LanguageList } },
    },
  },
});
