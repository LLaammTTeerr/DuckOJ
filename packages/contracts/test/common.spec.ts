import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  cursorPage,
  DisplayName,
  ProblemDetails,
  RegisterRequest,
  UpdateMeRequest,
  openApiDocument,
} from '../src/index.js';

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
    expect(doc.info.title).toBe('DuckOJ API');
  });
});

/**
 * `z.string().min(1)` is satisfied by `'   '`, so a display name of three
 * spaces registered and patched cleanly — and then rendered as an empty
 * heading on the profile, an empty cell in the user list and an empty
 * author on every clarification. Probed against the live stack: `PATCH
 * /users/me {"displayName":"   "}` answered 200 with `"displayName":"   "`.
 */
describe('DisplayName', () => {
  it('refuses a name that is only whitespace', () => {
    for (const blank of ['   ', '\t', '\n', ' ', '   ']) {
      expect(DisplayName.safeParse(blank).success).toBe(false);
    }
  });

  it('trims the surrounding whitespace it does accept', () => {
    // Leading and trailing space is invisible where a name is rendered, and
    // it is what lets two accounts wear the same name.
    expect(DisplayName.parse('  Đặng Thị Ánh  ')).toBe('Đặng Thị Ánh');
  });

  it('is the same rule on registration and on the profile edit', () => {
    // One schema, two call sites: the two used to disagree (64 vs 100) and
    // could have disagreed about the blank case too.
    expect(RegisterRequest.shape.displayName).toBe(DisplayName);
    expect(UpdateMeRequest.shape.displayName.unwrap()).toBe(DisplayName);
  });

  it('measures the trimmed length, so padding cannot smuggle a name past the cap', () => {
    expect(DisplayName.safeParse(`  ${'a'.repeat(100)}  `).success).toBe(true);
    expect(DisplayName.safeParse('a'.repeat(101)).success).toBe(false);
  });
});
