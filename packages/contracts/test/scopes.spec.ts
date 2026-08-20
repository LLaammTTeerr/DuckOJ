import { describe, expect, it } from 'vitest';
import { CreateTokenRequest, hasScope } from '../src/index.js';

const session = (scopes: string[] = []) => ({ userId: 1, globalRole: 'user', via: 'session' as const, scopes });
const token = (scopes: string[] = []) => ({ userId: 1, globalRole: 'user', via: 'token' as const, scopes });

// The whole design, in four cases. A session ignores scopes; a token requires them.
describe('hasScope', () => {
  it('a session is never constrained by scopes', () => {
    expect(hasScope(session([]), 'problems:write')).toBe(true);
    expect(hasScope(session(['submissions:read']), 'problems:write')).toBe(true);
  });

  it('a token holding the scope passes', () => {
    expect(hasScope(token(['problems:write']), 'problems:write')).toBe(true);
  });

  it('a token lacking the scope fails', () => {
    expect(hasScope(token(['problems:read']), 'problems:write')).toBe(false);
  });

  it('a token with NO scopes fails — empty means "declared nothing", not "unrestricted"', () => {
    expect(hasScope(token([]), 'problems:write')).toBe(false);
  });
});

describe('CreateTokenRequest', () => {
  it('accepts a known scope', () => {
    const parsed = CreateTokenRequest.parse({ name: 'ci', scopes: ['problems:write'] });
    expect(parsed.scopes).toEqual(['problems:write']);
  });

  it('rejects an unknown scope at the boundary', () => {
    expect(() => CreateTokenRequest.parse({ name: 'ci', scopes: ['bogus:scope'] })).toThrow();
  });
});
