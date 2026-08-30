/**
 * From a `PreparedProblem` to a content-addressed DuckOJ package.
 *
 * The copy plan and the manifest were decided by the loader — for a Polygon
 * directory, by `@duckoj/polygon-import`'s `planImport` itself, so the archive
 * this produces is byte-for-byte the archive `polygon:import` +
 * `package:build` produce for the same directory, and the hash printed here is
 * the hash that path prints. That identity is the whole reason the loader does
 * not build a manifest of its own (D87).
 */
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { buildPackage, type BuiltPackage } from '@duckoj/package-format';

import { PrepareError } from './errors.js';
import type { PreparedProblem } from './model.js';

export interface PackagedProblem extends BuiltPackage {
  /** The package DIRECTORY that was materialised, ready for `package:build`. */
  dir: string;
}

/**
 * Materialise the package directory and build it.
 *
 * `clean` empties the destination first, so a re-run after a test was deleted
 * from the source does not leave the removed file behind — a stale file
 * changes the archive's hash without changing anything the manifest names,
 * which would make an idempotent re-publish attach a revision nobody asked for.
 */
export async function packageProblem(
  problem: PreparedProblem,
  outDirInput: string,
  options: { clean?: boolean } = {},
): Promise<PackagedProblem> {
  const outDir = resolve(outDirInput);
  if (outDir === problem.dir) {
    throw new PrepareError('the package directory must not be the prepared directory itself');
  }
  if (options.clean !== false) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const copy of problem.copies) {
    const dest = join(outDir, copy.to);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await copyFile(copy.from, dest);
    } catch (error) {
      throw new PrepareError(
        `cannot copy "${copy.from}" into the package as "${copy.to}": ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(problem.manifest, null, 2) + '\n');

  try {
    return { ...(await buildPackage(outDir)), dir: outDir };
  } catch (error) {
    throw new PrepareError(error instanceof Error ? error.message : String(error));
  }
}
