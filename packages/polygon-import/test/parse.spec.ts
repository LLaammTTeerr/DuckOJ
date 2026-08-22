/**
 * Against a SYNTHETIC problem.xml — written from a reading of the Polygon
 * package format, not exported by Polygon. If a real package disagrees with
 * this fixture, the fixture is what must move.
 */
import { describe, expect, it } from 'vitest';
import { PolygonImportError, planImport } from '../src/index.js';

function xml(overrides: Partial<Record<'assets' | 'testset' | 'names', string>> = {}): string {
  const testset =
    overrides.testset ??
    `<testset name="tests">
        <time-limit>1000</time-limit>
        <memory-limit>268435456</memory-limit>
        <test-count>3</test-count>
        <input-path-pattern>tests/%02d</input-path-pattern>
        <answer-path-pattern>tests/%02d.a</answer-path-pattern>
        <tests>
          <test method="manual"/>
          <test method="generated" points="30" group="easy"/>
          <test method="generated" points="70" group="hard"/>
        </tests>
        <groups>
          <group name="easy"/>
          <group name="hard"/>
        </groups>
      </testset>`;
  const assets =
    overrides.assets ??
    `<assets><checker type="testlib"><source path="check.cpp" type="cpp.g++17"/></checker></assets>`;
  const names = overrides.names ?? `<names><name language="english" value="A plus B"/></names>`;
  return `<?xml version="1.0" encoding="utf-8"?>
    <problem short-name="a-plus-b">
      ${names}
      <judging>${testset}</judging>
      ${assets}
    </problem>`;
}

describe('planImport', () => {
  it('maps limits, tests, groups and the checker', () => {
    const plan = planImport(xml());
    // Bytes → KB. 268435456 arriving as anything but 262144 is the
    // 268-million-KB manifest that parses cleanly and means nothing.
    expect(plan.manifest.limits).toEqual({ timeMs: 1000, memoryKb: 262144 });
    expect(plan.manifest.name).toBe('A plus B');
    expect(plan.manifest.tests).toEqual([
      { input: 'tests/01.in', answer: 'tests/01.ans', points: 1, group: 0 },
      { input: 'tests/02.in', answer: 'tests/02.ans', points: 30, group: 1 },
      { input: 'tests/03.in', answer: 'tests/03.ans', points: 70, group: 2 },
    ]);
    expect(plan.manifest.checker).toEqual({
      kind: 'source',
      path: 'checker/check.cpp',
      language: 'cpp17',
    });
    // Every polygon-side path expanded from the 1-indexed %02d pattern.
    expect(plan.copies).toContainEqual({ from: 'tests/01', to: 'tests/01.in' });
    expect(plan.copies).toContainEqual({ from: 'tests/03.a', to: 'tests/03.ans' });
    expect(plan.copies).toContainEqual({ from: 'check.cpp', to: 'checker/check.cpp' });
  });

  it('a checkerless package gets the standard checker', () => {
    const plan = planImport(xml({ assets: '<assets/>' }));
    expect(plan.manifest.checker).toEqual({ kind: 'standard' });
  });

  it('refuses an interactive problem by name', () => {
    expect(() =>
      planImport(xml({ assets: '<assets><interactor><source path="i.cpp"/></interactor></assets>' })),
    ).toThrow(/interactive/);
  });

  it('refuses a package with no "tests" testset', () => {
    expect(() =>
      planImport(
        xml({
          testset: `<testset name="pretests">
            <time-limit>1000</time-limit><memory-limit>268435456</memory-limit>
            <test-count>1</test-count>
            <input-path-pattern>tests/%02d</input-path-pattern>
            <answer-path-pattern>tests/%02d.a</answer-path-pattern>
          </testset>`,
        }),
      ),
    ).toThrow(/no testset named "tests"/);
  });

  it('refuses group dependencies rather than silently changing scoring', () => {
    expect(() =>
      planImport(
        xml({
          testset: `<testset name="tests">
            <time-limit>1000</time-limit><memory-limit>268435456</memory-limit>
            <test-count>1</test-count>
            <input-path-pattern>tests/%02d</input-path-pattern>
            <answer-path-pattern>tests/%02d.a</answer-path-pattern>
            <tests><test group="hard"/></tests>
            <groups><group name="hard"><dependencies><dependency group="easy"/></dependencies></group></groups>
          </testset>`,
        }),
      ),
    ).toThrow(/dependencies/);
  });

  it('refuses traversal and absolute paths coming out of problem.xml', () => {
    expect(() =>
      planImport(
        xml({
          testset: `<testset name="tests">
            <time-limit>1000</time-limit><memory-limit>268435456</memory-limit>
            <test-count>1</test-count>
            <input-path-pattern>../%d</input-path-pattern>
            <answer-path-pattern>tests/%d.a</answer-path-pattern>
          </testset>`,
        }),
      ),
    ).toThrow(/traversal/);
    expect(() =>
      planImport(xml({ assets: '<assets><checker><source path="/etc/passwd"/></checker></assets>' })),
    ).toThrow(/absolute/);
    expect(() => planImport(xml())).not.toThrow();
  });

  it('reports skipped testsets and statements instead of importing them halfway', () => {
    const doc = `<?xml version="1.0"?>
      <problem short-name="p">
        <statements><statement language="english" type="application/x-tex"/></statements>
        <judging>
          <testset name="pretests">
            <time-limit>1000</time-limit><memory-limit>1048576</memory-limit>
            <test-count>1</test-count>
            <input-path-pattern>tests/%d</input-path-pattern>
            <answer-path-pattern>tests/%d.a</answer-path-pattern>
          </testset>
          <testset name="tests">
            <time-limit>1000</time-limit><memory-limit>1048576</memory-limit>
            <test-count>1</test-count>
            <input-path-pattern>tests/%d</input-path-pattern>
            <answer-path-pattern>tests/%d.a</answer-path-pattern>
          </testset>
        </judging>
      </problem>`;
    const plan = planImport(doc);
    expect(plan.skipped).toContain('testset "pretests"');
    expect(plan.skipped).toContain('statements (import them by hand)');
    // Unpadded %d expands unpadded.
    expect(plan.copies).toContainEqual({ from: 'tests/1', to: 'tests/01.in' });
  });

  it('a declared test-count that disagrees with <tests> is refused', () => {
    expect(() =>
      planImport(
        xml({
          testset: `<testset name="tests">
            <time-limit>1000</time-limit><memory-limit>1048576</memory-limit>
            <test-count>5</test-count>
            <input-path-pattern>tests/%02d</input-path-pattern>
            <answer-path-pattern>tests/%02d.a</answer-path-pattern>
            <tests><test/><test/></tests>
          </testset>`,
        }),
      ),
    ).toThrow(/test-count says 5/);
  });

  it('the produced manifest passes the package schema itself', async () => {
    const { parseManifest } = await import('@duckoj/package-format');
    expect(() => parseManifest(planImport(xml()).manifest)).not.toThrow();
  });

  it('errors are PolygonImportError, so a CLI can tell them from crashes', () => {
    try {
      planImport('<problem/>');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolygonImportError);
    }
  });
});
