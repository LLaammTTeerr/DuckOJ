/**
 * Import an EXTRACTED Polygon "full" package directory into a DuckOJ
 * package directory, then optionally build it:
 *
 *   corepack pnpm exec tsx scripts/polygon-import.ts <polygon-dir> <out-dir>
 *   corepack pnpm run package:build <out-dir> problem.tar.zst
 *
 * Deliberately a CLI, not an upload endpoint: server-side zip ingestion is
 * zip-slip/bomb surface, and the CLI's output goes through the existing
 * `buildPackage` → `POST /packages` path, which already validates
 * everything (ruling in the 2026-08-22 roadmap).
 */
import { importPolygon, PolygonImportError } from '@duckoj/polygon-import';

const [src, dest] = process.argv.slice(2);
if (!src || !dest) {
  console.error('usage: polygon-import <extracted-polygon-dir> <output-package-dir>');
  process.exit(1);
}

try {
  const plan = await importPolygon(src, dest);
  console.log(`imported "${plan.manifest.name}": ${String(plan.manifest.tests.length)} tests, ` +
    `${String(plan.manifest.limits.timeMs)} ms / ${String(plan.manifest.limits.memoryKb)} KB, ` +
    `checker ${plan.manifest.checker.kind}`);
  for (const item of plan.skipped) console.log(`skipped: ${item}`);
} catch (err) {
  if (err instanceof PolygonImportError) {
    console.error(`refused: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
