import { describe, expect, it } from 'vitest';
import { findMissingPackageFiles } from '../src/completeness.js';
import { parseManifest, type PackageManifestDto } from '../src/manifest.js';

function manifest(over: Partial<PackageManifestDto> = {}): PackageManifestDto {
  return parseManifest({
    schemaVersion: 1,
    name: 'A plus B',
    checker: { kind: 'standard' },
    limits: { timeMs: 1000, memoryKb: 65536 },
    tests: [{ input: 'tests/01.in', answer: 'tests/01.ans', points: 100, group: 0 }],
    ...over,
  });
}

const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe('findMissingPackageFiles', () => {
  it('says nothing about a manifest that describes the package it came with', () => {
    expect(
      findMissingPackageFiles(manifest(), files('manifest.json', 'tests/01.in', 'tests/01.ans')),
    ).toEqual([]);
  });

  it('names a test file the package does not contain', () => {
    expect(findMissingPackageFiles(manifest(), files('manifest.json', 'tests/01.in'))).toEqual([
      'tests/01.ans',
    ]);
  });

  /**
   * The case nothing checked. `buildPackage` compared only `manifest.tests`
   * against the packed tree, and neither it nor `attachRevision` looked at
   * `checker.path` at all — while every Polygon import plans exactly this
   * shape of checker. A package promising a checker it does not carry
   * uploaded, attached and published cleanly, and failed for the first time
   * on a judge, mid-grade, against a submission that was fine.
   */
  it('names a source checker the package does not contain', () => {
    const withChecker = manifest({
      checker: { kind: 'source', path: 'checker/check.cpp', language: 'cpp17' },
    });
    expect(
      findMissingPackageFiles(withChecker, files('manifest.json', 'tests/01.in', 'tests/01.ans')),
    ).toEqual(['checker/check.cpp']);
    expect(
      findMissingPackageFiles(
        withChecker,
        files('manifest.json', 'tests/01.in', 'tests/01.ans', 'checker/check.cpp'),
      ),
    ).toEqual([]);
  });

  it('reports each missing path once, sorted, however many tests name it', () => {
    const repeated = manifest({
      tests: [
        { input: 'tests/01.in', answer: 'shared.ans', points: 1, group: 0 },
        { input: 'tests/02.in', answer: 'shared.ans', points: 1, group: 0 },
      ],
    });
    expect(findMissingPackageFiles(repeated, files('tests/02.in'))).toEqual([
      'shared.ans',
      'tests/01.in',
    ]);
  });
});
