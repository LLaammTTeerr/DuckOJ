/**
 * The end-to-end property: a synthetic polygon dir imports into a directory
 * that `buildPackage`'s own validation (manifest ↔ files agreement) accepts.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '@duckoj/package-format';
import { importPolygon, PolygonImportError } from '../src/index.js';

const XML = `<?xml version="1.0"?>
<problem short-name="sum">
  <names><name language="english" value="Sum"/></names>
  <judging>
    <testset name="tests">
      <time-limit>2000</time-limit>
      <memory-limit>1048576</memory-limit>
      <test-count>2</test-count>
      <input-path-pattern>tests/%02d</input-path-pattern>
      <answer-path-pattern>tests/%02d.a</answer-path-pattern>
    </testset>
  </judging>
</problem>`;

describe('importPolygon', () => {
  it('copies the tests and writes a manifest that describes exactly them', async () => {
    const src = await mkdtemp(join(tmpdir(), 'polygon-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'polygon-dest-'));
    await mkdir(join(src, 'tests'), { recursive: true });
    await writeFile(join(src, 'problem.xml'), XML);
    await writeFile(join(src, 'tests/01'), '1 2\n');
    await writeFile(join(src, 'tests/01.a'), '3\n');
    await writeFile(join(src, 'tests/02'), '5 5\n');
    await writeFile(join(src, 'tests/02.a'), '10\n');

    const plan = await importPolygon(src, dest);
    expect(plan.manifest.limits).toEqual({ timeMs: 2000, memoryKb: 1024 });

    const written = parseManifest(JSON.parse(await readFile(join(dest, 'manifest.json'), 'utf8')));
    expect(written.tests).toHaveLength(2);
    // The copied bytes, not just the names.
    expect(await readFile(join(dest, 'tests/01.in'), 'utf8')).toBe('1 2\n');
    expect(await readFile(join(dest, 'tests/02.ans'), 'utf8')).toBe('10\n');
  });

  it('a missing test file fails the copy — never a manifest pointing at nothing', async () => {
    const src = await mkdtemp(join(tmpdir(), 'polygon-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'polygon-dest-'));
    await mkdir(join(src, 'tests'), { recursive: true });
    await writeFile(join(src, 'problem.xml'), XML);
    await writeFile(join(src, 'tests/01'), '1 2\n');
    await writeFile(join(src, 'tests/01.a'), '3\n');
    // tests/02 deliberately absent.
    await expect(importPolygon(src, dest)).rejects.toThrow(/tests\/02/);
  });

  /**
   * A Polygon export that is missing a file — a truncated download, a
   * `tests` script that never ran, an `answer-path-pattern` that does not
   * match what is on disk — is the likeliest way a real package fails to
   * import, and this file's own rule is that what cannot be represented is
   * refused LOUDLY. It was the one refusal that was not: `copyFile` raised a
   * bare `ENOENT`, which `scripts/polygon-import.ts` does not recognise
   * (it catches `PolygonImportError` and prints `refused: ...`, exit 2), so
   * the documented CLI contract gave way to an unhandled rejection and a
   * stack trace out of `node:fs`.
   */
  it('reports a missing file as a refusal, not as a crash out of node:fs', async () => {
    const src = await mkdtemp(join(tmpdir(), 'polygon-src-'));
    const dest = await mkdtemp(join(tmpdir(), 'polygon-dest-'));
    await mkdir(join(src, 'tests'), { recursive: true });
    await writeFile(join(src, 'problem.xml'), XML);
    await writeFile(join(src, 'tests/01'), '1 2\n');
    // tests/01.a — the answer for a test that IS present — is absent.
    await writeFile(join(src, 'tests/02'), '3 4\n');
    await writeFile(join(src, 'tests/02.a'), '7\n');

    await expect(importPolygon(src, dest)).rejects.toBeInstanceOf(PolygonImportError);
    // And it names the file and the pattern that asked for it, because the
    // usual cause is the pattern, not the file.
    await expect(importPolygon(src, dest)).rejects.toThrow(/tests\/01\.a/);
  });
});
