/**
 * The package this pipeline builds must be the package `polygon:import` +
 * `package:build` build. Not "equivalent" — the same hash, because the hash is
 * what a revision points at and what a submission is graded against (D87).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPackage } from '@duckoj/package-format';
import { importPolygon } from '@duckoj/polygon-import';
import { afterAll, describe, expect, it } from 'vitest';

import { loadProblem, packageProblem } from '../src/index.js';
import { cleanupFixtures, cloneFixture } from './helpers.js';

afterAll(cleanupFixtures);

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'prepare-pkg-'));
}

describe('packageProblem', () => {
  it('hashes a Polygon directory exactly as polygon:import + package:build do', async () => {
    const dir = await cloneFixture('polygon-good');
    const viaPrepare = await scratch();
    const viaCli = await scratch();
    try {
      const built = await packageProblem(await loadProblem(dir, { code: 'tong-hai-so' }), viaPrepare);
      await importPolygon(dir, viaCli);
      const reference = await buildPackage(viaCli);
      expect(built.hash).toBe(reference.hash);
    } finally {
      await rm(viaPrepare, { recursive: true, force: true });
      await rm(viaCli, { recursive: true, force: true });
    }
  });

  it('packs a source checker so the manifest is complete (D60)', async () => {
    const dir = await cloneFixture('polygon-checker');
    const out = await scratch();
    try {
      const built = await packageProblem(await loadProblem(dir, { code: 'tong-hai-so' }), out);
      expect(built.files.map((f) => f.path)).toContain('checker/check.cpp');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('packs the skills layout with its subtasks as batches', async () => {
    const dir = await cloneFixture('skills-zoo');
    const out = await scratch();
    try {
      const built = await packageProblem(await loadProblem(dir, { code: 'tong-hai-so' }), out);
      expect(built.manifest.tests.map((t) => t.group)).toEqual([1, 1]);
      expect(built.manifest.tests.reduce((sum, t) => sum + t.points, 0)).toBe(100);
      expect(built.files.map((f) => f.path).sort()).toEqual([
        'manifest.json',
        'tests/g1/01.ans',
        'tests/g1/01.in',
        'tests/g1/02.ans',
        'tests/g1/02.in',
      ]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('refuses to build into the prepared directory itself', async () => {
    const dir = await cloneFixture('polygon-good');
    const problem = await loadProblem(dir, { code: 'tong-hai-so' });
    await expect(packageProblem(problem, dir)).rejects.toThrow(/must not be the prepared directory/);
  });

  it('leaves nothing behind from an earlier build in the same directory', async () => {
    const dir = await cloneFixture('polygon-good');
    const out = await scratch();
    try {
      const problem = await loadProblem(dir, { code: 'tong-hai-so' });
      const first = await packageProblem(problem, out);
      await (await import('node:fs/promises')).writeFile(join(out, 'stale.txt'), 'left over');
      const second = await packageProblem(problem, out);
      // A stale file changes the archive's hash without changing anything the
      // manifest names, which would attach a revision nobody asked for.
      expect(second.hash).toBe(first.hash);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
