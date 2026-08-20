import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/authz/actor.js';
import {
  canCreateProblem,
  canEditProblem,
  canViewProblem,
  type ProblemViewContext,
  type ProblemVisibility,
} from '../src/authz/problem.visibility.js';

const ANON = null;
const user = (id: number): Actor => ({ userId: id, globalRole: 'user', via: 'session', scopes: [] });
const admin = (id: number): Actor => ({ ...user(id), globalRole: 'admin' });
const ctx = (over: Partial<ProblemViewContext> = {}): ProblemViewContext =>
  ({ memberRoles: [], sharedOrgIds: [], actorOrgIds: [], ...over });

// One case per cell of spec §2.4.
const CASES: Array<[string, Actor | null, ProblemVisibility, ProblemViewContext, boolean]> = [
  ['anon sees public',            ANON,     'public',  ctx(), true],
  ['anon cannot see org',         ANON,     'org',     ctx(), false],
  ['anon cannot see private',     ANON,     'private', ctx(), false],
  ['user sees public',            user(1),  'public',  ctx(), true],
  ['user cannot see org',         user(1),  'org',     ctx(), false],
  ['user cannot see private',     user(1),  'private', ctx(), false],
  ['org member sees org',         user(1),  'org',     ctx({ sharedOrgIds: [7], actorOrgIds: [7] }), true],
  ['org member cannot see private', user(1), 'private', ctx({ sharedOrgIds: [7], actorOrgIds: [7] }), false],
  ['non-shared org member cannot see org', user(1), 'org', ctx({ sharedOrgIds: [7], actorOrgIds: [8] }), false],
  ['tester sees private',         user(1),  'private', ctx({ memberRoles: ['tester'] }), true],
  ['author sees private',         user(1),  'private', ctx({ memberRoles: ['author'] }), true],
  ['curator sees private',        user(1),  'private', ctx({ memberRoles: ['curator'] }), true],
  ['admin sees private',          admin(9), 'private', ctx(), true],
];

describe('canViewProblem', () => {
  it.each(CASES)('%s', (_name, actor, visibility, context, expected) => {
    expect(canViewProblem(actor, { id: 1, visibility }, context)).toBe(expected);
  });
});

describe('canEditProblem', () => {
  it('lets an author edit', () => expect(canEditProblem(user(1), ctx({ memberRoles: ['author'] }))).toBe(true));
  it('lets a curator edit', () => expect(canEditProblem(user(1), ctx({ memberRoles: ['curator'] }))).toBe(true));
  it('does NOT let a tester edit', () => expect(canEditProblem(user(1), ctx({ memberRoles: ['tester'] }))).toBe(false));
  it('lets an admin edit', () => expect(canEditProblem(admin(9), ctx())).toBe(true));
  it('denies a setter who is not a member', () =>
    expect(canEditProblem({ ...user(1), globalRole: 'setter' }, ctx())).toBe(false));
});

describe('canCreateProblem', () => {
  it('lets a setter create', () => expect(canCreateProblem({ ...user(1), globalRole: 'setter' })).toBe(true));
  it('lets an admin create', () => expect(canCreateProblem(admin(9))).toBe(true));
  it('denies a plain user', () => expect(canCreateProblem(user(1))).toBe(false));
  it('denies anon', () => expect(canCreateProblem(ANON)).toBe(false));
});
