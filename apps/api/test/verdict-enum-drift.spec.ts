import { describe, expect, it } from 'vitest';
import { Verdict } from '@duckoj/contracts';
import { caseVerdict } from '@duckoj/db/guarded';

/**
 * `packages/contracts/src/submissions.ts`'s `Verdict` zod enum is a second,
 * independent copy of the database's `case_verdict` enum — `@duckoj/contracts`
 * is bundled into the browser and must stay free of a `@duckoj/db` (and
 * therefore drizzle) dependency, so it cannot import `caseVerdict` and
 * derive from it directly. That independence is exactly how Task 1 shipped
 * `caseVerdict` gaining `'CE'` while `Verdict` silently didn't: nothing
 * failed until `apps/api`'s own `tsc -b` caught the mismatch. This test is
 * the standing guard against that drift recurring, in either direction.
 */
describe('Verdict / case_verdict drift', () => {
  it('keeps the contracts Verdict enum in lockstep with the database case_verdict enum, order included', () => {
    expect(Verdict.options).toEqual(caseVerdict.enumValues);
  });
});
