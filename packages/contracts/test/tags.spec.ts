/**
 * Every route carries exactly one tag, and only tags the document declares.
 *
 * The same structural-guard shape as `openapi-path-params.spec.ts`: walk the
 * emitted document rather than the source files, so a future route
 * registered anywhere is covered the day it appears. An untagged route is
 * invisible-but-present in the grouped reference — filed under a generated
 * "default" section nobody looks at — which is exactly how a route escapes
 * review.
 */
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/index.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

describe('route tags', () => {
  const doc = openApiDocument();
  const declared = new Set((doc.tags ?? []).map((tag) => tag.name));

  it('declares the tag list at the document root', () => {
    expect(declared.size).toBeGreaterThan(0);
  });

  it('every operation carries exactly one declared tag', () => {
    const untagged: string[] = [];
    const unknown: string[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of METHODS) {
        const op = (item as Record<string, { tags?: string[] } | undefined>)[method];
        if (!op) continue;
        const tags = op.tags ?? [];
        if (tags.length !== 1) untagged.push(`${method.toUpperCase()} ${path}`);
        else if (!declared.has(tags[0]!)) unknown.push(`${method.toUpperCase()} ${path} -> ${tags[0]!}`);
      }
    }
    expect(untagged).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('admin routes are filed under Admin regardless of which file registers them', () => {
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      if (!path.startsWith('/admin')) continue;
      for (const method of METHODS) {
        const op = (item as Record<string, { tags?: string[] } | undefined>)[method];
        if (op) expect(op.tags).toEqual(['Admin']);
      }
    }
  });

  it('every declared tag is used by at least one route — no ghost sections', () => {
    const used = new Set<string>();
    for (const item of Object.values(doc.paths ?? {})) {
      for (const method of METHODS) {
        const op = (item as Record<string, { tags?: string[] } | undefined>)[method];
        for (const tag of op?.tags ?? []) used.add(tag);
      }
    }
    expect([...declared].filter((tag) => !used.has(tag))).toEqual([]);
  });
});
