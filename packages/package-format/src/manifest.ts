import { z } from 'zod';

export const PACKAGE_SCHEMA_VERSION = 1;

/**
 * A path inside the package.
 *
 * Rejecting `..` and absolute paths here is not defensive tidiness — this
 * value is joined against a directory and written to disk by the judge-agent,
 * so an unchecked path is an arbitrary-write primitive reachable by anyone who
 * can upload a package. Validating at the schema boundary means every consumer
 * gets the guarantee without having to remember it.
 */
const PackagePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), { message: 'must be relative' })
  .refine((p) => !p.split('/').includes('..'), { message: 'must not traverse upwards' });

export const CheckerSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standard') }),
  z.object({ kind: z.literal('source'), path: PackagePath, language: z.string().min(1) }),
]);

export const TestCase = z.object({
  input: PackagePath,
  answer: PackagePath,
  points: z.number().min(0),
  /** Batch/subtask index. 0 means ungrouped — every case stands alone. */
  group: z.number().int().min(0).default(0),
});

export const PackageManifest = z.object({
  schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
  name: z.string().min(1),
  checker: CheckerSpec,
  limits: z.object({
    timeMs: z.number().int().positive(),
    memoryKb: z.number().int().positive(),
  }),
  tests: z.array(TestCase).min(1),
});

export type PackageManifestDto = z.infer<typeof PackageManifest>;

export function parseManifest(input: unknown): PackageManifestDto {
  const parsed = PackageManifest.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid package manifest — ${detail}`);
  }
  return parsed.data;
}
