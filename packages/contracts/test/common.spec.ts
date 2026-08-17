import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cursorPage, ProblemDetails, openApiDocument } from '../src/index.js';

describe('common contracts', () => {
  it('validates a problem+json body', () => {
    const parsed = ProblemDetails.parse({
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      fields: { email: ['must be an email'] },
    });
    expect(parsed.status).toBe(422);
  });

  it('builds a cursor page schema around an item schema', () => {
    const page = cursorPage(z.object({ id: z.number() }));
    const parsed = page.parse({ items: [{ id: 1 }], nextCursor: null });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextCursor).toBeNull();
  });

  it('emits an OpenAPI 3.1 document', () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('QHH Online Judge API');
  });
});
