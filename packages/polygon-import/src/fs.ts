/**
 * The filesystem half: read `problem.xml`, plan, copy, write the manifest.
 * Everything decidable is decided in `parse.ts`; this only executes the plan.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { planImport, type PolygonImportPlan } from './parse.js';

export async function importPolygon(srcDir: string, destDir: string): Promise<PolygonImportPlan> {
  const xml = await readFile(join(srcDir, 'problem.xml'), 'utf8');
  const plan = planImport(xml);

  await mkdir(destDir, { recursive: true });
  for (const copy of plan.copies) {
    await mkdir(join(destDir, dirname(copy.to)), { recursive: true });
    await copyFile(join(srcDir, copy.from), join(destDir, copy.to));
  }
  await writeFile(join(destDir, 'manifest.json'), JSON.stringify(plan.manifest, null, 2) + '\n');
  return plan;
}
