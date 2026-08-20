// Registering a route in a Nest controller (`apps/api/src/**/*.controller.ts`)
// and registering it in this package's OpenAPI registry are two independent
// acts, and nothing enforced that they agree — which is exactly how the
// document's route coverage silently fell behind the live API. This test
// closes that gap the same way `apps/api/test/dockerfile-manifest.spec.ts`
// closes the analogous one for Dockerfile COPY manifests: by deriving both
// sides from source and asserting they match, rather than trusting a
// checklist to stay current.
//
// Two carve-outs, both structural rather than a hardcoded route list:
//
//  - Anything under an `internal/` controller prefix. Those are
//    machine-to-machine routes (a judge presenting a judge credential) that
//    must never reach the client SDK — `packages.ts` and
//    `no-internal-routes.spec.ts` already enforce that the registry never
//    documents one; this test must not force the opposite mistake by
//    demanding one be added.
//  - Routes `app.setup.ts` excludes from `setGlobalPrefix` (`healthz`,
//    `readyz`). The document's one `servers` entry is `/${API_PREFIX}` —
//    root-relative on purpose, so every documented path is implicitly
//    understood to live under it. The health probes do not: they are
//    infrastructure contracts (the Compose healthcheck, the Caddyfile), not
//    versioned API surface, and documenting `/healthz` under a document
//    whose server is `/api/v1` would claim it lives at `/api/v1/healthz` —
//    which is false. A document claiming a route at the wrong path is worse
//    than omitting it, so they are excluded here rather than misdocumented.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface Route {
  method: string;
  path: string;
}

function findControllerFiles(): string[] {
  const results: string[] = [];
  const root = join(repoRoot, 'apps', 'api', 'src');
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(abs, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.controller.ts')) results.push(full);
    }
  };
  walk(root);
  return results;
}

/** `:param` -> `{param}`, the OpenAPI path-template spelling. */
function toOpenApiPath(nestPath: string): string {
  return nestPath.replace(/:(\w+)/g, '{$1}');
}

const HTTP_METHOD_DECORATORS = ['Get', 'Post', 'Patch', 'Delete', 'Put'] as const;

/** Every route registered across every non-`internal/` controller. */
function discoverControllerRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of findControllerFiles()) {
    const src = readFileSync(file, 'utf8');

    const controllerMatch = src.match(/@Controller\((.*?)\)/s);
    if (!controllerMatch) continue; // not every file under */controller.ts necessarily declares one
    const prefixMatch = controllerMatch[1]!.match(/'([^']*)'/);
    const prefix = prefixMatch ? prefixMatch[1]! : '';
    if (prefix === 'internal' || prefix.startsWith('internal/')) continue;

    const methodPattern = new RegExp(`@(${HTTP_METHOD_DECORATORS.join('|')})\\((.*?)\\)`, 'g');
    for (const match of src.matchAll(methodPattern)) {
      const method = match[1]!.toLowerCase();
      const argMatch = match[2]!.match(/'([^']*)'/);
      const handlerPath = argMatch ? argMatch[1]! : '';
      const full = '/' + [prefix, handlerPath].filter(Boolean).join('/');
      routes.push({ method, path: toOpenApiPath(full) });
    }
  }
  return routes;
}

/** The exact segment names `app.setup.ts` passes as `setGlobalPrefix`'s
 * `exclude` list — read from source, not duplicated as a literal, so this
 * test cannot itself drift from the wiring it is describing. */
function discoverPrefixExcludedSegments(): Set<string> {
  const src = readFileSync(join(repoRoot, 'apps', 'api', 'src', 'app.setup.ts'), 'utf8');
  const match = src.match(/setGlobalPrefix\(\s*API_PREFIX\s*,\s*\{\s*exclude:\s*\[(.*?)\]/s);
  if (!match) {
    throw new Error('route-coverage: could not find setGlobalPrefix(...) exclude list in app.setup.ts');
  }
  return new Set([...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!));
}

function routeKey(r: Route): string {
  return `${r.method.toUpperCase()} ${r.path}`;
}

describe('contracts registry route coverage', () => {
  it('registers exactly the non-internal, non-probe routes the API controllers expose', () => {
    const excludedSegments = discoverPrefixExcludedSegments();

    const controllerRoutes = discoverControllerRoutes().filter(
      (r) => !excludedSegments.has(r.path.replace(/^\//, '')),
    );
    // Guards this test against passing vacuously if the controller scan
    // itself broke and silently found nothing.
    expect(controllerRoutes.length).toBeGreaterThan(0);

    const doc = openApiDocument();
    const documentRoutes = new Set<string>();
    for (const [path, methods] of Object.entries(doc.paths ?? {})) {
      for (const method of Object.keys(methods as Record<string, unknown>)) {
        documentRoutes.add(routeKey({ method, path }));
      }
    }

    const controllerKeys = new Set(controllerRoutes.map(routeKey));

    const missingFromDocument = [...controllerKeys].filter((k) => !documentRoutes.has(k)).sort();
    const missingFromControllers = [...documentRoutes].filter((k) => !controllerKeys.has(k)).sort();

    expect(missingFromDocument, 'routes a controller exposes but the registry never documents').toEqual([]);
    expect(missingFromControllers, 'routes the registry documents but no controller exposes').toEqual([]);
  });
});
