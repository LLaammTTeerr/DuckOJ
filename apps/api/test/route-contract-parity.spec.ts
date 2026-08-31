// The route fuzzer (`route-fuzz.spec.ts`) walks the OpenAPI document, and the
// marker-coverage spec (`route-marker-coverage.spec.ts`) walks the routes Nest
// actually registers — but nothing asserts the two sets are the *same* set. A
// route registered in Nest yet absent from `openapi.json` is invisible to the
// fuzzer (it never gets malformed input) *and* is contract drift the SDK and
// CLI are generated blind to; a path in the document with no route behind it
// is a promise the server does not keep. Either is a defect the two existing
// specs each look straight past.
//
// This closes the gap by discovering routes the same runtime-reflection way
// `route-marker-coverage.spec.ts` does — not by parsing source — and diffing
// them against the operations in the published document.
//
// Two things are deliberately outside the contract and excluded:
//   - `internal/*` controllers authenticate a judge, never an actor, and are
//     not part of the public SDK surface (the fuzzer excludes them too).
//   - `GET /healthz` and `GET /readyz` are orchestrator probes (D-level ops
//     endpoints), intentionally undocumented — no client generates against
//     them. They are the *only* documented-exemption, listed explicitly so a
//     third one cannot slip in unnoticed.
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, DB } from '../src/config/config.module.js';
import { TEST_CONFIG } from './app.harness.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const REQUEST_METHOD_NAME: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

/** Registered routes never meant to appear in the SDK contract. */
const UNDOCUMENTED_BY_DESIGN = new Set(['GET /healthz', 'GET /readyz']);

function joinPath(prefix: string, handlerPath: string): string {
  const segments = [prefix, handlerPath].filter((s) => s && s !== '/');
  return '/' + segments.join('/').replace(/\/+/g, '/').replace(/^\/+/, '');
}

/** Nest `:param` → OpenAPI `{param}`, so the two id schemes compare equal. */
function toOpenApiPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}');
}

function runtimeRoutes(discovery: DiscoveryService, scanner: MetadataScanner): string[] {
  const routes: string[] = [];
  for (const wrapper of discovery.getControllers()) {
    const controller = (wrapper.metatype ?? wrapper.instance?.constructor) as Type<unknown> | undefined;
    if (!controller) continue;
    const prefixRaw = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
    const prefix = Array.isArray(prefixRaw) ? (prefixRaw[0] ?? '') : (prefixRaw ?? '');
    if (prefix === 'internal' || prefix.startsWith('internal/')) continue;
    const prototype = wrapper.instance ? Object.getPrototypeOf(wrapper.instance) : controller.prototype;
    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, (...args: unknown[]) => unknown>)[methodName]!;
      const methodMeta = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (methodMeta === undefined) continue;
      const handlerPathRaw = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      const handlerPath = Array.isArray(handlerPathRaw) ? (handlerPathRaw[0] ?? '') : (handlerPathRaw ?? '');
      const method = REQUEST_METHOD_NAME[methodMeta] ?? `METHOD(${methodMeta})`;
      routes.push(`${method} ${toOpenApiPath(joinPath(prefix, handlerPath))}`);
    }
  }
  return routes;
}

function documentedOperations(): string[] {
  const document = JSON.parse(readFileSync(join(repoRoot, 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const ops: string[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const method of Object.keys(methods)) ops.push(`${method.toUpperCase()} ${path}`);
  }
  return ops;
}

describe('route/contract parity', () => {
  let app: INestApplication;
  let discovery: DiscoveryService;
  let scanner: MetadataScanner;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
      .overrideProvider(DB)
      .useValue({ execute: async () => [{ ok: 1 }] })
      .overrideProvider(APP_CONFIG)
      .useValue(TEST_CONFIG)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    discovery = app.get(DiscoveryService);
    scanner = app.get(MetadataScanner);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('every registered non-internal route is in the OpenAPI document', () => {
    const documented = new Set(documentedOperations());
    const undocumented = runtimeRoutes(discovery, scanner)
      .filter((route) => !documented.has(route) && !UNDOCUMENTED_BY_DESIGN.has(route))
      .sort();
    expect(undocumented, 'routes Nest registers that no contract documents').toEqual([]);
  });

  it('every OpenAPI operation is a route Nest registers', () => {
    const registered = new Set(runtimeRoutes(discovery, scanner));
    const orphaned = documentedOperations()
      .filter((op) => !registered.has(op))
      .sort();
    expect(orphaned, 'contract operations with no route behind them').toEqual([]);
  });

  it('discovers a plausible number of routes (not vacuous)', () => {
    expect(runtimeRoutes(discovery, scanner).length).toBeGreaterThan(80);
  });
});
