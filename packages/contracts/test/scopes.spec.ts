import { describe, expect, it } from 'vitest';
import { CreateTokenRequest, hasScope, SCOPES } from '../src/index.js';

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

// Pinned by hand, one literal entry per scope — never regenerated from
// `SCOPES` itself (that would make this test tautological) and never a
// snapshot (a snapshot accepts any change on `-u`, including a scope quietly
// dropped). Phase 3b spec §2.1 added `languages:read`; Phase 3c §2.3 adds
// `orgs:write` — extend this list by hand again the next time a scope is
// added or removed, so a reviewer sees the vocabulary change in the diff
// rather than trusting a regenerated file.
describe('scope vocabulary', () => {
  it('is exactly this list — extend by hand, never by regenerating a snapshot', () => {
    expect(SCOPES).toEqual([
      'problems:read',
      'problems:write',
      'problems:publish',
      'submissions:read',
      'submissions:write',
      'orgs:read',
      'packages:read',
      'packages:write',
      'languages:read',
      'orgs:write',
    ]);
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
