import { z } from 'zod';

export const ProblemDetails = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Machine-readable, stable across wording changes. */
  code: z.string(),
  /** Present only on validation failures. */
  fields: z.record(z.string(), z.array(z.string())).optional(),
});
export type ProblemDetailsDto = z.infer<typeof ProblemDetails>;

export const PaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQueryDto = z.infer<typeof PaginationQuery>;

export function cursorPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const Timestamp = z.string().datetime({ offset: true });
