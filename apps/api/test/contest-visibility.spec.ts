/**
 * `canViewContest` is `canViewProblem`'s decision with a different membership
 * model, because both call `canViewVisible` — there is one predicate (design
 * §5). This matrix is the proof that routing a contest through it produces the
 * same answers `problem-visibility.spec.ts` pins for a problem, cell for cell,
 * with "member" spelled "creator".
 */
import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/authz/actor.js';
import {
  canCreateContest,
  canViewContest,
  type ContestViewContext,
  type ContestVisibility,
} from '../src/authz/contest.visibility.js';
import { canViewProblem, type ProblemViewContext } from '../src/authz/problem.visibility.js';

const ANON = null;
const user = (id: number): Actor => ({ userId: id, globalRole: 'user', via: 'session', scopes: [] });
const setter = (id: number): Actor => ({ ...user(id), globalRole: 'setter' });
const admin = (id: number): Actor => ({ ...user(id), globalRole: 'admin' });
const ctx = (over: Partial<ContestViewContext> = {}): ContestViewContext => ({
  isCreator: false,
  sharedOrgIds: [],
  actorOrgIds: [],
  ...over,
});

const CASES: Array<[string, Actor | null, ContestVisibility, ContestViewContext, boolean]> = [
  ['anon sees public', ANON, 'public', ctx(), true],
  ['anon cannot see org', ANON, 'org', ctx(), false],
  ['anon cannot see private', ANON, 'private', ctx(), false],
  ['user sees public', user(1), 'public', ctx(), true],
  ['user cannot see org', user(1), 'org', ctx(), false],
  ['user cannot see private', user(1), 'private', ctx(), false],
  ['org member sees org', user(1), 'org', ctx({ sharedOrgIds: [7], actorOrgIds: [7] }), true],
  ['org member cannot see private', user(1), 'private', ctx({ sharedOrgIds: [7], actorOrgIds: [7] }), false],
  ['non-shared org member cannot see org', user(1), 'org', ctx({ sharedOrgIds: [7], actorOrgIds: [8] }), false],
  ['creator sees their own private contest', user(1), 'private', ctx({ isCreator: true }), true],
  ['admin sees private', admin(9), 'private', ctx(), true],
];

describe('canViewContest', () => {
  it.each(CASES)('%s', (_name, actor, visibility, context, expected) => {
    expect(canViewContest(actor, { visibility }, context)).toBe(expected);
  });

  /**
   * The anti-divergence assertion. Not a restatement of the table above: it
   * asserts the two entities answer *identically* on every cell where their
   * contexts correspond, which is the property that fails first if someone
   * later gives contests a predicate of their own.
   */
  it.each(CASES)('agrees with canViewProblem on: %s', (_name, actor, visibility, context, expected) => {
    const problemCtx: ProblemViewContext = {
      memberRoles: context.isCreator ? ['author'] : [],
      sharedOrgIds: context.sharedOrgIds,
      actorOrgIds: context.actorOrgIds,
    };
    expect(canViewProblem(actor, { id: 1, visibility }, problemCtx)).toBe(expected);
  });
});

describe('canCreateContest', () => {
  it.each([
    ['a setter may', setter(1), true],
    ['an admin may', admin(1), true],
    ['a plain user may not', user(1), false],
    ['an anonymous caller may not', ANON, false],
  ])('%s', (_name, actor, expected) => {
    expect(canCreateContest(actor)).toBe(expected);
  });
});
