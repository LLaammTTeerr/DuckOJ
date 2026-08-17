import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/index.js';

/**
 * A structural guard, not a submissions-specific one: it walks every path and
 * method in the emitted document, so it catches the same class of bug for any
 * future path parameter, not just the one that triggered it.
 *
 * What triggered it: `z.coerce.number().int()` under zod v4 + zod-to-openapi
 * v9 documents an `in: "path"` parameter as `{"required": false, "schema":
 * {"type": ["integer", "null"]}}`. Both halves are illegal for a path
 * parameter under OpenAPI 3.1 — path parameters MUST be required, and there is
 * no such thing as "no id" for `/submissions/{id}`. It shipped silently
 * because nothing checked path parameters at all; `common.spec.ts` only
 * asserts `doc.openapi === '3.1.0'`.
 */

interface LooseParameter {
  name?: unknown;
  in?: unknown;
  required?: unknown;
  schema?: { type?: unknown } | undefined;
}

describe('OpenAPI path parameters', () => {
  it('are required and never nullable, for every path and method', () => {
    const doc = openApiDocument();
    const paths = (doc.paths ?? {}) as Record<string, Record<string, { parameters?: LooseParameter[] }>>;

    let pathParamsChecked = 0;
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const param of operation.parameters ?? []) {
          if (param.in !== 'path') continue;
          pathParamsChecked += 1;
          const label = `${method.toUpperCase()} ${path} param "${String(param.name)}"`;

          expect(param.required, `${label} must be required`).toBe(true);

          const type = param.schema?.type;
          const types = Array.isArray(type) ? type : [type];
          expect(types, `${label} must not be nullable`).not.toContain('null');
        }
      }
    }

    // Guards against the loop above passing vacuously if every path parameter
    // were ever removed or this test stopped matching real operations.
    expect(pathParamsChecked).toBeGreaterThan(0);
  });
});
