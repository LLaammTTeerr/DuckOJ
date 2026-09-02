/**
 * D201 — an account cannot be minted by a path that never asked D200's
 * policy.
 *
 * This is the D113/D198 shape applied to the seam F-56 created. D197 shipped
 * a switch whose surfaces were seven and whose enforcement had been forgotten
 * by one of them; the equivalent failure here is not a *surface* forgetting to
 * redact, it is a **mint** — a code path that writes a `users` row — that
 * never consulted the policy at all. That is not hypothetical either: until
 * this slot there were four such paths and a policy for none of them, and the
 * live judge answered `201` to an anonymous `POST /auth/register`.
 *
 * Two claims, scanned rather than believed:
 *
 *   1. **The mint.** Every INSERT into `users` outside the sanctioned module
 *      must consult `assertRegistrationOpen` / `mayRegister` in the same
 *      function, or hold an audited allowlist entry naming the operator whose
 *      authority stands in for the policy.
 *   2. **One switch, read in one place.** `config.registration` may be
 *      branched on in exactly one module. A second reader is a second policy,
 *      and the second one is always the one that is wrong.
 *
 * `scripts/` is scanned as well as `apps/api/src` and `packages/`, and that is
 * load-bearing rather than thorough: two of the four mints in this product are
 * CLIs (D19's `bootstrap:admin`, the seeder's `system` row), and a census that
 * could not see them would be a census of half the seam claiming to be all of
 * it.
 *
 * A developer who trips this has exactly two legal moves, both named in the
 * failure message. A REMOVED mint fails as a stale entry, so the allowlist
 * stays an honest census of everything in this product that can create a
 * person.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, scanRoots, scanSources, type Hit } from './source-scan.js';

/**
 * The module that DEFINES the policy, plus the parser that reads the variable
 * into the config object. Every reference here IS the source of truth.
 */
const SANCTIONED = new Set([
  'apps/api/src/authz/registration.policy.ts',
  'apps/api/src/config/config.schema.ts',
]);

/**
 * Every path that writes a `users` row without consulting the policy, keyed by
 * `relativePath::enclosingFunction`, with the authority that stands in for it.
 *
 * A site that calls the predicate in the same function is not listed — it is
 * routed, which is the point — so what remains here is the census of every way
 * an account can come into existence on this judge *other* than somebody
 * signing themselves up.
 */
const ALLOWLIST: Record<string, string> = {
  'apps/api/src/authz/org-import.core.ts::runImport':
    'D61 — a school roster imported in one all-or-nothing call by an OWNER of that organization or a global admin, metered one per organization per minute. The authority is the caller’s standing in a named school, which `REGISTRATION` does not speak about: closing sign-ups to strangers must not stop a province seating its pupils, and this is the path a province is told to use INSTEAD of signing up. `orgs.spec.ts` owns the authorization.',
  'scripts/bootstrap-admin.ts::bootstrapAdmin':
    'D19 — the first admin, minted by a CLI against `DATABASE_URL` rather than by a route, precisely so that an HTTP endpoint which mints admins never exists. It also has to work on a stack that has no admin yet, which is the one situation in which D200’s bypass has nobody to be. Possession of the database is the authority.',
  'scripts/seed-problem.ts::(top-level)':
    'The locked `system` service account, `passwordHash: \'!\'` (not a valid argon2 encoding, so `PasswordService.verify` fails closed) and `onConflictDoNothing`. It exists because `problems.created_by` is NOT NULL; it is not a person and cannot be signed in as.',
};

/**
 * What is deliberately NOT here, named so the next reader does not assume the
 * scan covers it:
 *
 * - **A raw-SQL insert in a migration.** `packages/db/migrations/*.sql` is not
 *   TypeScript and is not scanned. A migration that inserted a person would be
 *   a schema change reviewed as one; the pattern below still matches
 *   `insert into users` inside a TS template literal, which is the only way
 *   one could reach a running server.
 * - **A promotion.** `admin-users.controller.ts` changes an existing account’s
 *   `global_role`; it creates nobody, and `REGISTRATION` is about existence,
 *   not privilege.
 * - **The test harness.** Specs are excluded from the walk, as they are for
 *   every guard of this shape: a fixture that creates a user is not a product
 *   surface, and `app.harness.ts` puts the whole suite on the `open` rung on
 *   purpose.
 */

/** An account being created, as drizzle spells it and as raw SQL would. */
const MINT = /\.insert\(\s*(?:schema\.)?users\s*\)|insert\s+into\s+users\b/i;
/** The switch itself, and the environment variable it is parsed from. */
const SWITCH = /\bconfig\??\.registration\b|\bREGISTRATION\b/;
/** Routed through the predicate. */
const ROUTED = /\bassertRegistrationOpen\s*\(|\bmayRegister\s*\(/;

const roots = [...scanRoots, join(repoRoot, 'scripts')];
const scan = (pattern: RegExp): Hit[] => scanSources(pattern, ROUTED, roots);

describe('every account this judge can mint asked D200 first (D201)', () => {
  const mints = scan(MINT);

  it('finds the mints at all (the scan is not vacuously green)', () => {
    // A rename that made this scan match nothing would turn every assertion
    // below into a tautology, which is how a guard of this shape usually
    // dies. Four paths create a `users` row today: self-service registration,
    // D61's roster import, D19's bootstrap CLI and the seeder's `system` row.
    expect(mints.length).toBeGreaterThanOrEqual(4);
    // And at least one of them is actually routed, so `routed` is not a
    // predicate that quietly matches nothing.
    expect(mints.filter((h) => h.routed).length).toBeGreaterThanOrEqual(1);
  });

  it('routes the self-service mint through the policy, in its own body', () => {
    // Named explicitly rather than left to the census: this is THE path D200
    // governs, and "some mint somewhere is routed" would stay green if the
    // one that matters stopped being.
    const selfService = mints.find((h) => h.key === 'apps/api/src/authn/auth.service.ts::register');
    expect(selfService?.routed).toBe(true);
  });

  it('every INSERT into users is policed or audited', () => {
    const offenders = mints.filter(
      (h) => !SANCTIONED.has(h.file) && !h.routed && !(h.key in ALLOWLIST),
    );
    const message =
      offenders.length === 0
        ? ''
        : [
            'A `users` row is created by a path that never consulted D200.',
            '',
            'Until F-56 there was no registration policy in this system at all, and the',
            'live judge answered 201 to an anonymous POST /auth/register — anyone on the',
            'internet could hold an account on a province’s school judge. Two legal',
            'moves:',
            '',
            '  1. ask the policy — `assertRegistrationOpen(policy, actor)`, with the rung',
            '     from `registrationOf(config)`; or',
            '  2. add an entry to ALLOWLIST in this file naming the OPERATOR whose',
            '     authority stands in for it (an org owner running an import, possession',
            '     of the database, a service account that is not a person).',
            '',
            ...offenders.map((o) => `  ${o.key}\n      ${o.line}`),
          ].join('\n');
    expect(message).toBe('');
  });

  it('keeps the allowlist an honest census — no stale entries', () => {
    const seen = new Set(mints.map((h) => h.key));
    const stale = Object.keys(ALLOWLIST).filter((key) => !seen.has(key));
    expect(
      stale.length === 0
        ? ''
        : `Allowlist entries that no longer match any source line (remove them):\n  ${stale.join('\n  ')}`,
    ).toBe('');
  });

  it('is read in exactly one place, which is what makes it one policy', () => {
    // The admin dashboard REPORTS the rung (F-40's lesson: an operator set a
    // variable and had no way to see whether it reached the process) and does
    // it through `registrationOf`, the same fail-closed reader the endpoint
    // itself calls — so it never names the field and never appears here.
    const switches = scan(SWITCH);
    // Floor, for the same reason as above: the parser names the variable
    // three times and the policy module reads the field once.
    expect(switches.length).toBeGreaterThanOrEqual(3);
    const offenders = switches.filter((h) => !SANCTIONED.has(h.file));
    expect(
      offenders.length === 0
        ? ''
        : [
            '`REGISTRATION` was read outside `registration.policy.ts`. A second reader is',
            'a second policy: call `registrationOf(config)` and let',
            '`assertRegistrationOpen(policy, actor)` decide.',
            '',
            ...offenders.map((o) => `  ${o.key}\n      ${o.line}`),
          ].join('\n'),
    ).toBe('');
  });
});
