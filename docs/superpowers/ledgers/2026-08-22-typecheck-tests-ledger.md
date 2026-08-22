# Typechecking the test suites: ledger

**Trigger:** a finding recorded in the Phase 3f ledger (R6) — a `null`-versus-
`undefined` bug that `AppConfig`'s own types should have rejected, and did not,
because the test directory was never typechecked.

**Result:** 750 tests green, and every test file in the workspace is now
typechecked. Nine defects fixed.

---

## R1 — the gap was four times bigger than I reported

I wrote that `apps/api/tsconfig.json` includes only `src`. It does — and so
does every other package's. **Thirteen packages had test directories that no
typechecker had ever read**; `apps/web` was the only one that included its
tests, because its Vite setup needed a single non-composite config anyway.

Reporting one instance of a repo-wide gap is its own small failure. The survey
took one command and should have run before the claim.

## R2 — a separate config, not a widened `include`

Each package gains `tsconfig.test.json`: extends its own config, adds `test` to
`include`, and sets `noEmit`, `declaration: false`, `composite: false`,
`rootDir: "."`.

**Widening the existing `include` would have been wrong**: these are composite
projects that emit to `dist`, so adding `test` there would compile spec files
into the published output and change `rootDir` for the build. The second config
typechecks without emitting anything.

`typecheck` becomes `tsc -b && tsc --noEmit -p tsconfig.test.json`, so CI and
`pnpm verify` pick it up with no workflow change.

## R3 — what it found

Nine errors, in three shapes:

**A required field silently missing** — `contest-visibility.spec.ts` built a
`ProblemViewContext` without `inJoinedContest`, which Phase 4d had made
required. It passed at runtime because `undefined` is falsy, which is exactly
the accident the type was meant to prevent. **This is the drift I predicted in
the 3d ledger and then failed to catch, twice, by hand.**

**Untyped test doubles** — `vi.fn(async () => …)` infers an *empty* parameter
tuple, so `mock.calls[0]` has no element `0` and every assertion about what
`fetch` was called with was a cast past a type error. Fixed by giving each mock
the signature of the function it stands in for, which is also what makes the
assertions meaningful.

**Unchecked index access** — `headers['set-cookie'][0]` is `string | undefined`
under `noUncheckedIndexedAccess`. Replaced with a helper that fails naming the
response, so a missing cookie reports itself rather than surfacing as
`undefined is not a string` several assertions later.

## R4 — one lint rule had to change with it

Typing a `fetch` double requires naming `(input, init)` and using neither, and
`@typescript-eslint/no-unused-vars` had no `argsIgnorePattern`. Added `^_`
repo-wide.

**Repo-wide, not scoped to the packages that needed it today** — I first added
it under the `apps/api/src` block and it silently did nothing for the three
packages that were failing. A convention scoped to one package is how the same
paper cut reappears in the next.

## R5 — the guard was demonstrated, not assumed

Same discipline as a mutation test, applied to the tooling:

| Injected defect | Result |
|---|---|
| omit `inJoinedContest` — the exact drift that shipped unnoticed | `TS2741`, named field and type |
| pass a `number` where a `RankedPlayer[]` is required | `TS2345` |

A typecheck nobody has seen fail is a typecheck that might be checking nothing.

## R6 — a correction to the Phase 3d ledger

That ledger claims Nest's implicit constructor injection failed because "this
build does not emit decorator metadata". **Wrong**: `apps/api/tsconfig.json`
sets `emitDecoratorMetadata: true`, so the built application emits it.

Vitest transpiles with esbuild, which does not support the option, so
`design:paramtypes` is missing **in tests only** — the app would have worked in
production and failed in its own test suite. The explicit-`@Inject` convention
is still correct, for the better reason that it is the only form that works in
both.

Corrected in place, as an addition rather than an edit, because that phase's
commit message repeats the original claim.

## Deferred

**`apps/web` keeps its single config.** Its Vite/Bundler resolution and
`noEmit` already cover `src`, `test` and `e2e`; adding a second config there
would duplicate the only setup that was already right.

**Nothing typechecks `scripts/` tests** because `scripts/` has none. Its source
is already covered by `typecheck:scripts`.
