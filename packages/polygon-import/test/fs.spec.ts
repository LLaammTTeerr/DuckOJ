/**
 * The end-to-end property: a synthetic polygon dir imports into a directory
 * that `buildPackage`'s own validation (manifest ↔ files agreement) accepts.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '@duckoj/package-format';
import { importPolygon } from '../src/index.js';

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
});
