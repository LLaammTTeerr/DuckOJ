/**
 * The filesystem half: read `problem.xml`, plan, copy, write the manifest.
 * Everything decidable is decided in `parse.ts`; this only executes the plan.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { planImport, PolygonImportError, type PolygonImportPlan } from './parse.js';

export async function importPolygon(srcDir: string, destDir: string): Promise<PolygonImportPlan> {
  const xml = await readFile(join(srcDir, 'problem.xml'), 'utf8');
  const plan = planImport(xml);

  await mkdir(destDir, { recursive: true });
  for (const copy of plan.copies) {
    await mkdir(join(destDir, dirname(copy.to)), { recursive: true });
    try {
      await copyFile(join(srcDir, copy.from), join(destDir, copy.to));
    } catch (error) {
      // The one refusal in this package that was not a refusal.
      //
      // `parse.ts`'s rule is that what cannot be represented is refused
      // loudly, and every decision it makes throws `PolygonImportError` so
      // `scripts/polygon-import.ts` can print `refused: ...` and exit 2. A
      // file the plan names but the export does not carry — a truncated
      // download, a `tests` script that never ran, an `answer-path-pattern`
      // that does not match what is on disk, which is the likeliest way a
      // real Polygon package fails to import — arrived instead as a bare
      // `ENOENT` from `node:fs`, sailed past that catch, and ended the CLI
      // as an unhandled rejection with a stack trace pointing at
      // `copyFile`. The path is named because the usual cause is the
      // pattern in `problem.xml`, not the file.
      throw new PolygonImportError(
        `problem.xml names "${copy.from}", which is not in this package ` +
          `(planned as "${copy.to}"): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await writeFile(join(destDir, 'manifest.json'), JSON.stringify(plan.manifest, null, 2) + '\n');
  return plan;
}
