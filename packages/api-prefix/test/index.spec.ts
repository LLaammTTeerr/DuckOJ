import { describe, expect, it } from 'vitest';
import { API_PREFIX } from '../src/index.js';

describe('API_PREFIX', () => {
  it('is a bare path segment — no leading or trailing slash', () => {
    expect(API_PREFIX).toBe('api/v1');
    expect(API_PREFIX.startsWith('/')).toBe(false);
    expect(API_PREFIX.endsWith('/')).toBe(false);
  });
});
