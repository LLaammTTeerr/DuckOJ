import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/index.js';

/**
 * `packages.ts` documents, in a comment, that `GET
 * /internal/packages/{hash}/archive` must never be registered here — it is
 * machine-to-machine (a judge presenting a judge credential), not part of
 * the client SDK surface. But CI's regen-and-diff check only enforces that
 * `openapi.json`/the generated SDK stay in *sync* with whatever this file
 * registers; it does not enforce *which* paths get registered. Nothing
 * would fail if someone added the internal route here later — the comment
 * alone is not a guarantee.
 *
 * This is the guarantee: a structural check over every path this file
 * actually registers, so an `/internal/...` path added here (by accident or
 * otherwise) fails a test immediately, rather than merely reading as
 * inconsistent with a comment above it.
 */
describe('OpenAPI registry', () => {
  it('never registers an /internal/ path', () => {
    const doc = openApiDocument();
    const paths = Object.keys(doc.paths ?? {});

    // Guards against the assertion below passing vacuously if the document
    // ever ends up with no paths at all.
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      expect(path, `${path} must not be under /internal/`).not.toMatch(/\/internal\//);
    }
  });
});
