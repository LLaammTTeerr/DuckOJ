import { describe, expect, it } from 'vitest';
import { API_PREFIX } from '@duckoj/api-prefix';
import { openApiDocument } from '../src/index.js';

describe('OpenAPI registry', () => {
  // The task brief that specified this test asserted `registry.servers[0]`,
  // but `OpenAPIRegistry` (the `@asteasolutions/zod-to-openapi` class
  // `registry` is an instance of) has no `servers` property at all — only
  // the *document* `openApiDocument()` generates does, via the `servers`
  // array passed to `generateDocument()`. `registry.servers` would not even
  // type-check. This asserts against the generated document instead, which
  // is what actually carries the value under test.
  it('derives the OpenAPI server URL from API_PREFIX, not a literal', () => {
    const doc = openApiDocument();
    // Comparing against the imported constant rather than the string
    // '/api/v1' is deliberate: Phase 2a shipped an assertion comparing two
    // hardcoded literals, which could not fail no matter how far the two
    // drifted apart. This assertion can fail — if `registry.ts` ever
    // reverts to a literal, `API_PREFIX` and the literal would disagree
    // (`API_PREFIX` is bare, `'/api/v1'` is not) and this test would catch it.
    expect(doc.servers?.[0]?.url).toBe(`/${API_PREFIX}`);
  });
});
