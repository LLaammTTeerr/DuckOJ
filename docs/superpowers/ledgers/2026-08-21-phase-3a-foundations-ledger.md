# Phase 3a decision ledger — token scopes and routing

**What this is.** The running record of every decision made while implementing
Phase 3a, written as the work happened. The spec says what was built; this says
why, and what was deliberately left undone.

**Read this before Phase 3b.** The deferred table below is the input to it.

| Deferred | Ruling |
|---|---|
| **No scope covers organization management, the member editor, or browser upload** — those routes do not exist yet. When 3b adds them, each needs a marker at birth, and the drift test will refuse the build until it has one. That is the intended pressure | R1 (the 3a/3b split) |
| **Marker mutual-exclusivity is enforced for three markers, not four.** `@Public()` deliberately sits outside the exclusive group because it governs a different axis — whether an actor is *required*, not what a token may *do*. `@Public()` + `@RequireScope` is a legal and used pair | R17, R19 |
| **Scope enforcement is per-route, not per-resource.** A token scoped `problems:write` may PATCH *any* problem it has the role for. Narrowing a token to specific problems is a different feature and a much larger one | Spec §2.4 — scopes narrow the *actor's* authority, they do not add resource-level ACLs |
| **`TokenSummary.scopes` stays `z.array(z.string())`** while `CreateTokenRequest.scopes` is the enum. Strict in, permissive out: a stored row predating the vocabulary must remain readable | R5 |
| **No UI to pick scopes.** `apps/web` has no token-management screen at all, so a picker has nothing to attach to. Tokens are minted over HTTP | R2 |
| **`@SessionOnly()` + `@RequireScope` is now forbidden, but no route ever carried it.** Forbidden while free rather than after someone writes it | R19 |
| Everything in Phase 2b's deferred table that 3a did not touch — the `apps/judged` flake, the `dist/` trap, hand-maintained Dockerfile COPY manifests, the org-resolution timing channel, `sizeBytes` drift, unpinned `Materializer.ensure()` coalescing, truncated-tar silent reads, no scheduling policy | Carried unchanged |

**How to read it.** Five of this phase's nineteen rulings correct *my own
briefs*, and that is the most useful signal in the document. The pattern is
identical in all five: I state a rule in one paragraph and its carve-out in
another, and never check them against each other. R17 is the clearest case —
I asked for "exactly one of four markers" and, three paragraphs later, declared
a two-marker combination legal. The implementer refused to build an incoherent
rule and said why. Every one of the five was caught by an implementer reading
carefully, not by me re-reading.

---

## The rulings

**R1** — Phase 3 splits into **3a** (scopes, router) and **3b** (screens).
Both 3a items get monotonically more expensive with every route added, and five
workstreams in one phase is the large-review-surface problem that hid defects
in Phase 2b's Task 7 until it was split.

**R2** — Task 5 (scope-picker UI) dropped as a no-op, checked *before*
dispatching: `git grep "auth/tokens" -- apps/web/src` returns nothing.

**R3** — Tasks 1-4 (`apps/api`, `packages/contracts`) and Task 6 (`apps/web`)
ran **in parallel**, deviating from one-implementer-at-a-time. That rule
prevents two agents colliding in the same files; these file sets are disjoint,
so it bought nothing and cost half the wall clock. Both agents were given their
boundary explicitly and told not to run `git checkout`/`stash`/`rebase`.

**R4** — My Step 5 mutation instruction was ambiguous about whether
`if (scopes.length === 0) return true` *replaces* the `via` branch or is *added*
to it. The implementer tested both: replacing breaks 2 of 4 cases (too blunt to
isolate anything); adding it breaks **exactly one**, the empty-token case. The
additive form is also the more plausible real bug — someone adds a convenience
shortcut without removing the correct branch.

**R5** — `CreateTokenRequest.scopes` is the enum; `TokenSummary.scopes` stays
strings. Input strict so an unknown scope is a 422 at the boundary; output
permissive because `access_tokens.scopes` is an untyped `text[]` and a row
predating the enum must still be readable.

**R6** — Implementers **skipped the repo-wide clean-tree gate** because
`podman ps` showed the dev stack live and Caddy bind-mounts `apps/web/dist`.
That is exactly the behaviour the plan's hazard paragraph was written to
produce, and the first time in this project a warning distilled from a past
incident visibly prevented its recurrence.

**R7** — Two links were left as plain `<a href>` in the router's first round
because `<Link>` throws without a `RouterProvider` and those components are
unit-tested directly. Sound reasoning pointing the wrong way: a **test-harness**
limitation was setting **production** behaviour, on the app's primary flow
(list → problem → submit). Fixed by giving the harness a router. **When a test
harness cannot express the right production behaviour, fix the harness.**

**R8** — TanStack's default search serializer JSON-quotes any value that is
itself valid JSON. `PROBLEM_CODE` admits `123`, `true`, `false`, `null` — all
valid JSON scalars. The implementer verified round-tripping against the
installed `router-core` source, where raw `URLSearchParams` would not. This
matters because Phase 2b's D1 was this exact link silently grading against the
wrong problem; a numeric code re-breaking it would look identical.

**R9** — Self-correction: the first "zero `/auth/me` refetches" claim was too
broad. The cache is shared, but a route calling `useAuthGate()` still fires one
background revalidation per visit (react-query `staleTime: 0` on a freshly
mounted observer). Reported unprompted.

**R10** — **My brief was wrong about what test 6 proves.** I claimed
"anonymous gets 401, not 403" pins guard ordering. Swapping `AuthGuard` and
`ScopeGuard` breaks tests 3, 4 and 5 while test 6 **still passes**, because
`ScopeGuard`'s own no-actor short-circuit lets anonymous through either way.
Ordering is pinned — by different tests than I said.

**R11** — Registering `ScopeGuard` globally made it **shadow**
`SessionOnlyGuard` (Nest runs global guards first), so a token hitting a
credential route got `scope_required` instead of `session_required`. Behaviour
correct, explanation wrong: an operator reads "this token lacks a scope", goes
hunting for the scope to add, and none exists. Fixed with a composed
`@SessionOnly()` decorator that sets metadata **and** applies the guard, so the
two cannot drift; `ScopeGuard` defers when it sees the marker.

**R12** — I told an implementer to revert four tests. **Only two should have
been**, and it said so rather than complying. Two exercised `@SessionOnly()`
routes (collateral from the shadowing bug); two only called `/auth/me`, where a
refused token is deny-by-default working as designed. Reverting all four would
have quietly restored a contract that *should* change.

**R13** — `GET /auth/me` is **token-reachable**, via an explicit
`@NoScopeRequired()` marker. It reports the caller's own identity and grants
nothing — the shape of `aws sts get-caller-identity` — and refusing it makes a
token impossible to debug for no safety gain. The marker is the load-bearing
part: leaving the route undecorated produces the *same* 403, so "deliberately
open" and "nobody reviewed this" would be byte-identical in the code.

**R14** — The R49 escalation test was **shown to catch the bug shape**, not
merely to pass: swapping the required scope on `POST /problems` let the
narrowly-scoped token create one (201, not 403).

**R15** — I carried "two tests assert the `/auth/me` accident" into Task 3.
There were three. All now assert `200` plus the caller's own username — a
stronger proof than a status code, which a 200 with the wrong username would
have satisfied.

**R16** — Task 3's two concerns folded into Task 4's brief before dispatch
rather than after review.

**R17** — **My amendment contradicted itself**: "exactly one of four markers"
versus "`@Public()` + `@RequireScope` is legal", three paragraphs apart, with
the current tree already violating the first. The implementer built the
coherent reading — at-least-one-of-four plus the contradictory pair — and said
why.

**R18** — The drift test uses **reflection over the booted app**, not source
parsing. Decisive argument: `@SessionOnly()` is composed, so in source it is one
token whether or not it still applies the guard. Only reflection distinguishes
*applied* from *silently broken*, and a test asserting runtime truth must not
assert file contents.

**R19** — `@SessionOnly()` + `@RequireScope` forbidden too, generalised to **at
most one of `{@RequireScope, @NoScopeRequired, @SessionOnly}`** rather than
enumerating pairs. `@Public()` stays outside the group. Forbidden while no route
carried it, which is when it is free.

---

## Acceptance

All ten criteria verified individually. Highlights:

- A token with **no** scopes reaches no scoped route, and the test fails
  against the plausible wrong implementation (`scopes.length === 0` ⇒
  unrestricted).
- R49's exact escalation sequence is refused at `SessionOnlyGuard` for
  `/admin` and at `ScopeGuard` for `POST /problems`, with the victim's role
  unchanged in the database.
- `parseRoute` no longer exists.
- **The Playwright suite passes with a zero-line diff against `main`** — the
  strongest available evidence that adopting a router changed no observable
  behaviour, because the assertions were written against the routing it
  replaced.
- All gates green from a clean tree with `dist/` **and** `tsconfig.tsbuildinfo`
  deleted. 435 tests.

---

## Addendum — the `dist/` trap, reproduced and narrowed

Phase 2b's deferred table describes this hazard as "`apps/api` resolves
workspace packages through their built `dist/`, not live `src/`, so a
mid-session mutation check can pass spuriously". True, but **overstated**, and
an overstated hazard is one people route around unnecessarily. Reproduced
deliberately, three steps:

1. `tsc -b --force` on `packages/contracts` so `dist` provably matches source
   (0 mutation markers in `dist`).
2. Mutate `packages/contracts/src/scopes.ts` only — `hasScope` returns `true`
   unconditionally. Markers: 1 in `src`, still 0 in `dist`.
3. Run **bare `vitest run scope-guard`** from `apps/api`, bypassing the package
   script.

Result: **`Tests 7 passed`.** A mutation that guts the entire scope predicate
is invisible.

**The correction, and it is the useful part:** running the same mutation
through `corepack pnpm --filter @duckoj/api test scope-guard` fails **2 tests**
correctly, because that script is `tsc -b && vitest run` and `packages/contracts`
is one of `apps/api`'s project references — so `tsc -b` rebuilds `dist` before
vitest reads it. Every package script in this repo has that shape.

So the trap bites **only** when someone invokes `vitest` directly. It is not a
property of the test suite; it is a property of skipping the build step.

**Ruling R20: not fixing this by aliasing, and the reason is a real trade-off.**
The obvious fix — a vitest `resolve.alias` pointing `@duckoj/*` at `src/` —
would remove the trap entirely and speed the suite up. It would also stop the
tests exercising the **built artifact**, and packaging errors are a failure
class this project has already paid for twice: a Dockerfile missing a workspace
package broke a real image build in two separate phases. An alias would make
`exports`-map mistakes and missing build output invisible to every test.

Trading a hazard that needs someone to bypass the tooling for a hazard that
hides real packaging bugs is a bad trade. Documented instead:

**Always run tests through the package script (`corepack pnpm --filter <pkg>
test`). A bare `vitest` invocation reads stale `dist` and will show you a
passing mutation.** This applies with most force during a mutation check —
exactly when a spurious pass is read as "this test cannot fail" and the test
gets weakened or deleted.
