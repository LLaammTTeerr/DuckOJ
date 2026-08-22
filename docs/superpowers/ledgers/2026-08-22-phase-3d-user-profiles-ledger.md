# Phase 3d — User profiles: ledger

**Spec:** `docs/superpowers/specs/2026-08-22-phase-3d-user-profiles-design.md`

**Result:** 693 tests green (was 684). `GET /users`, `GET /users/:username`,
`PATCH /users/me`. Two new scopes.

---

## R1 — statistics count public problems only, and that is the assertion

`solvedCount`, `points` and `submissionCount` are computed over
`visibility = 'public'` problems, matching DMOJ's `calculate_points`, which
runs against `Problem.get_public_problems()`.

Counting *what the viewer may see* would make one profile mean different things
to different readers, and would leak — through arithmetic — that private
problems exist. So the test does not merely check a number; it asserts the
**same** numbers come back to an anonymous caller, the profile's owner, and an
admin. Equality across the three is what "viewer-independent" means, and a
single-reader test would have passed against a viewer-scoped implementation.

The fixture is the load-bearing part: a user with an AC on a public problem
*and* an AC on a private one. With every problem public, an implementation that
forgot the filter returns the same answer.

## R2 — nothing is stored

DMOJ denormalises `problem_count` and `points` onto the profile and recomputes
them on submission events. That is a second write path that drifts, and this
project deleted exactly such a column (`contest_submissions.points`) four
commits ago. Computed on read until a query plan says otherwise.

## R3 — the leak test asserts over the whole body

`email`, `status`, `passwordHash`, `timezone` and `locale` are checked by
serialising the entire response and searching it, not by naming fields. A
field-by-field test only covers the fields someone thought of; this one catches
a column added to the query later without touching the test.

**A suspended account still resolves.** A 404 would turn the profile route into
an oracle for who has been banned, which is the whole reason `status` is
private.

## R4 — a mutation that proved the wrong thing

My first attempt at the leak mutation added `email` to the service's column
list. **All eight tests stayed green** — correctly: `toSummary` builds the DTO
field by field, so a wider query changes nothing on the wire.

The mapper, not the column list, is the guard. Re-mutated to make `toSummary`
pass the field through, which reddens three tests. The first result was
reported as a bad mutation, not banked as evidence.

## R5 — the lint rule caught an architecture violation I had written

`users.service.ts` filtered on `problems.visibility` from `apps/api/src/users/`.
The repo's `no-restricted-imports` rule confines `@duckoj/db/guarded` to
`apps/api/src/authz/**`, and it fired:

> Guarded tables may only be imported from `apps/api/src/authz/**`. Add a
> method to the relevant `*.access.ts` service instead of querying directly.

It was right. A statistics query that decides what a reader may be told about
*is* a visibility decision. Moved to `authz/user.access.ts` as
`UserAccessService`, matching `ContestAccessService` and `OrgAccessService` —
controller in its own directory, access rules in `authz/`.

**The rule found this, not me.** It is worth more than the review that would
have missed it.

## R6 — a refactor I tried, measured, and reverted

`test/app.harness.ts` repeats `AppModule`'s module list by hand, so a module
wired in one and forgotten in the other is either served-but-untested or
tested-but-unserved. Both look like a passing suite, and the users module hit
the second case: the routes 404'd until I added it to the harness too.

I exported one shared `API_MODULES` array to remove the duplication. **It broke
127 tests.** The lists differ for real reasons: the harness omits `ConfigModule`
(which builds its own database pool instead of the Testcontainers one the
harness overrides), `RealtimeModule` (which dials Redis on construction), and
`HealthModule`/`DocsModule`.

Reverted, and the reason is now a comment at the site so the next person does
not repeat the experiment. **The duplication is deliberate, and the cost is
that a new module must be added in both places.**

## R7 — implicit constructor injection silently yields `undefined`

`constructor(private readonly users: UsersService) {}` compiled, started, and
returned 500 on every request under vitest.

**Correction, 22 Aug 2026:** I wrote here that "this build does not emit
decorator metadata". That is wrong — `apps/api/tsconfig.json` sets
`emitDecoratorMetadata: true`, so the *built* application emits it and implicit
injection would have worked in production. Vitest transpiles with esbuild,
which does not support the option, so `design:paramtypes` is absent **in tests
only**.

The convention is still right, and for a better reason than the one I gave:
explicit `@Inject` is the only form that works in both the built app and the
test runner. Left as a correction rather than an edit, since the original claim
is what the commit message of that phase says. Every other controller in the repo uses an explicit
`@Inject(Service)` — a convention I had not noticed until I broke it.

The failure is nasty because it is *not* a module-init error. It surfaces on
the first request as a bare `TypeError`, and `ProblemFilter` deliberately logs
only the error's name and frames — not its message — so the log said
`TypeError` and nothing else. Diagnosed by calling the service directly from a
scratch spec, which worked, isolating it to the controller.

## R8 — mutation evidence

| Mutation | Result |
|---|---|
| M1 statistics ignore problem visibility | 1 fail |
| M2 `points` sums every attempt instead of the best | 1 fail |
| M3 wider column list | **bad mutation, see R4** |
| M3′ mapper passes `email` through | 3 fail |
| M4 a suspended user 404s | 1 fail |
| M5 substring search instead of prefix | 1 fail |
| M6 `UpdateMeRequest` not `.strict()` | 1 fail |

## Deferred

**Avatars.** `users.avatarKey` exists, nothing uploads to it, and no URL scheme
resolves it. Returning a key nobody can dereference is worse than omitting the
field, so the DTO omits it.

**Username changes.** `PATCH /users/me` does not accept `username`. A rename
has to decide what happens to every citation of the old name, which is a bigger
question than a profile edit.

**Rating is exposed but never written.** `rating` and `maxRating` are on the
profile and are always `null`; Glicko-2 is the next phase and now has somewhere
to land.
