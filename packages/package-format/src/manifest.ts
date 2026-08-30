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

export type TestCaseDto = z.infer<typeof TestCase>;

/**
 * One sample's prose, keyed by the sample test's own `input` path (D94).
 *
 * NOT a `sample: true` flag — D87 refused one and still does: sample-ness is
 * `points: 0` in a group that scores nothing (see `isSampleTest`), a zero-point
 * case runs exactly as any other and awards nothing, which IS what a sample is.
 * This annotates a sample the manifest already describes; it never creates one.
 *
 * Keyed by path rather than by index into a derived `samples` list, because
 * that list is derived: inserting one test above a sample would silently move
 * every explanation down one problem. A path is stable, unique inside a
 * manifest (`findPathCollision` guarantees it) and already the thing the
 * `tests` array is written in terms of.
 */
export const SampleAnnotation = z.object({
  /** The `input` path of the test this explains — must name a sample. */
  input: PackagePath,
  explanation: z.string().min(1).max(4096),
});
export type SampleAnnotationDto = z.infer<typeof SampleAnnotation>;

export const PackageManifest = z
  .object({
    schemaVersion: z.literal(PACKAGE_SCHEMA_VERSION),
    name: z.string().min(1),
    checker: CheckerSpec,
    limits: z.object({
      timeMs: z.number().int().positive(),
      memoryKb: z.number().int().positive(),
    }),
    tests: z.array(TestCase).min(1),
    /**
     * Optional, and absent in every package built before D94 — which is why
     * the schema version does NOT move: an old manifest parses unchanged, and
     * an old parser reading a new manifest drops a key it does not know rather
     * than failing. A package's identity is its file digests, so adding this
     * to a manifest does change that package's hash, exactly as editing any
     * other line of it would.
     */
    samples: z.array(SampleAnnotation).max(64).optional(),
  })
  .superRefine((manifest, ctx) => {
    // An explanation attached to a test that is not a sample would render
    // nowhere and read, to the setter who wrote it, as work that was silently
    // thrown away. Refuse it here, where the message can name the path.
    const samplePaths = new Set(manifest.tests.filter(isSampleTest(manifest.tests)).map((t) => t.input));
    const seen = new Set<string>();
    for (const [i, annotation] of (manifest.samples ?? []).entries()) {
      if (!samplePaths.has(annotation.input)) {
        ctx.addIssue({
          code: 'custom',
          path: ['samples', i, 'input'],
          message: `'${annotation.input}' is not a sample test (a sample is worth 0 points in a group worth 0)`,
        });
      }
      if (seen.has(annotation.input)) {
        ctx.addIssue({
          code: 'custom',
          path: ['samples', i, 'input'],
          message: `'${annotation.input}' is explained twice`,
        });
      }
      seen.add(annotation.input);
    }
  });

export type PackageManifestDto = z.infer<typeof PackageManifest>;

/**
 * Is this test one of the problem's samples?
 *
 * D87 ruled a sample is `points: 0, group: 0`, which is what the browser
 * authoring tab writes — but it is NOT what the other authoring path
 * produces. Polygon marks its samples explicitly and puts them in a *named*
 * group (every `problem.xml` under `content/problems`: `points="0"`,
 * `group="samples"`), so
 * `@duckoj/polygon-import` numbers that group 1 and every seeded problem's
 * samples sit at `points: 0, group: 1`. A rule of "group 0" alone therefore
 * finds no samples at all in the problems this repo actually ships.
 *
 * The rule that covers both, and only those: **worth nothing, in a group that
 * is worth nothing**.
 *
 *  - Group 0 is "ungrouped — every case stands alone" (see `TestCase.group`),
 *    so a zero-point case there is scored on its own and is a sample. Its
 *    neighbours' points are irrelevant, and must be: the authoring tab writes
 *    scored ungrouped cases beside its samples.
 *  - A real batch (group > 0) is a sample group only when the WHOLE batch
 *    scores nothing. This is the load-bearing half: `distributePoints` splits
 *    a subtask's points across its tests, and 10 points over 12 tests gives
 *    two of them 0 — those are members of a scored batch, not samples, and
 *    publishing one as a sample would hand out jury test data.
 */
export function isSampleTest(tests: readonly TestCaseDto[]): (test: TestCaseDto) => boolean {
  const groupTotals = new Map<number, number>();
  for (const test of tests) groupTotals.set(test.group, (groupTotals.get(test.group) ?? 0) + test.points);
  return (test) => test.points === 0 && (test.group === 0 || groupTotals.get(test.group) === 0);
}

/**
 * The manifest's samples, in manifest order, each with its explanation (D94).
 *
 * The file list is derived from `tests` and the annotations are JOINED onto
 * it — never the other way around. Everything in a package that is not a
 * sample is jury data, and a `samples` array is a client-supplied field on a
 * blob that may have been stored before this schema existed: reading a file
 * because `samples[]` named it would let a manifest nominate any test file in
 * the package as public.
 */
export function manifestSamples(
  manifest: PackageManifestDto,
): Array<{ input: string; answer: string; explanation: string | null }> {
  const explanations = new Map((manifest.samples ?? []).map((s) => [s.input, s.explanation]));
  return manifest.tests
    .filter(isSampleTest(manifest.tests))
    .map((test) => ({
      input: test.input,
      answer: test.answer,
      explanation: explanations.get(test.input) ?? null,
    }));
}

export function parseManifest(input: unknown): PackageManifestDto {
  const parsed = PackageManifest.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid package manifest — ${detail}`);
  }
  return parsed.data;
}
