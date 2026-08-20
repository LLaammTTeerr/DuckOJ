# Phase 3a — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make `Actor.scopes` mean something, and replace hand-rolled routing with a real router — the two structural items that get more expensive with every screen Phase 3b adds.

**Architecture:** A `ScopeGuard` registered as a global `APP_GUARD` after `AuthGuard`, reading `@RequireScope` metadata. Enforcement branches on `Actor.via`, never on `scopes.length`. On the web side, `@tanstack/react-router` replaces `parseRoute` wholesale; the existing Playwright suite is the acceptance bar.

**Tech Stack:** NestJS 11, Zod 4 contracts, React 19 + TanStack Router, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-21-phase-3a-foundations-design.md`

## Global Constraints

1. **Enforcement branches on `via`, never on emptiness.** `SessionService` returns `scopes: []` for every session; `TokenService` returns whatever the token was minted with, which may also be `[]`. Same value, opposite meanings. `via === 'session'` skips scope checks entirely; `via === 'token'` requires the scope to be present.
2. **Scopes narrow, never grant.** Authorization is `hasRole(actor) AND hasScope(actor)`. A scope never admits an actor a role check would refuse.
3. **Deny by default, structurally.** A token-authenticated request to a route carrying no `@RequireScope` is refused, not allowed. Forgetting the decorator fails closed.
4. **No scope grants credential management or role grants.** `TokensController`, `TotpController` and `AdminUsersController` stay `SessionOnlyGuard` and are unreachable by any token.
5. **The Playwright suite is the router's acceptance bar.** It must pass **unchanged**. If adopting the router requires editing those assertions, behaviour changed — justify it in the ledger rather than editing the test.
6. **Every new test demonstrated to fail** against unfixed or deliberately-broken code, with the observed failure output reported.
7. **All gates green before every commit:** `corepack pnpm -r typecheck`, `-r lint`, `-r test`. Delete `dist/` **and** `tsconfig.tsbuildinfo` for a clean-tree check — `rm -rf */dist` alone leaves `tsc -b` believing every project is current, printing `Done` and emitting nothing.

### Two hazards already paid for

**A green suite proves nothing about integration.** Five bugs across three phases were invisible to a full unit suite and appeared only on a live stack. Task 7 runs the browser suite against real Caddy for exactly this.

**`apps/web/dist` is bind-mounted into Caddy.** A clean-tree gate that deletes it takes the running site down, and rebuilding is not enough — the container's mount points at the deleted inode and Caddy must be recreated. Do not run a clean-tree gate against a stack you still need.

## File structure

**Created:** `packages/contracts/src/scopes.ts` (vocabulary + `hasScope`) · `apps/api/src/authn/scope.guard.ts` · `apps/api/src/authn/require-scope.decorator.ts` · `apps/api/test/scope-matrix.spec.ts` · `apps/api/test/route-marker-coverage.spec.ts` · `apps/web/src/router.tsx`

**Modified:** `apps/api/src/authn/authn.module.ts` · every controller (decorators) · `packages/contracts/src/tokens.ts` · `apps/web/src/main.tsx` · `apps/web/src/routes/*.tsx` (links) · `apps/web/package.json`

---

## Task 1: The scope vocabulary and predicate

**Files:** Create `packages/contracts/src/scopes.ts`; modify `packages/contracts/src/{index,tokens}.ts`; test `packages/contracts/test/scopes.spec.ts`

**Produces:** `SCOPES` (the frozen list), `Scope` (union type), `hasScope(actor, required)`.

- [ ] **Step 1: Write the failing test first**

```ts
const session = (scopes: string[] = []) => ({ userId: 1, globalRole: 'user', via: 'session', scopes });
const token   = (scopes: string[] = []) => ({ userId: 1, globalRole: 'user', via: 'token',   scopes });

// The whole design, in four cases. A session ignores scopes; a token requires them.
it('a session is never constrained by scopes', () => {
  expect(hasScope(session([]), 'problems:write')).toBe(true);
  expect(hasScope(session(['submissions:read']), 'problems:write')).toBe(true);
});
it('a token holding the scope passes', () => expect(hasScope(token(['problems:write']), 'problems:write')).toBe(true));
it('a token lacking the scope fails', () => expect(hasScope(token(['problems:read']), 'problems:write')).toBe(false));
it('a token with NO scopes fails — empty means "declared nothing", not "unrestricted"', () =>
  expect(hasScope(token([]), 'problems:write')).toBe(false));
```

The fourth case is the one that distinguishes a correct implementation from one keyed on `scopes.length === 0`. An implementation that treats empty as unrestricted passes the first three and fails only this.

- [ ] **Step 2: Run it, watch it fail.** Expected: module not found.

- [ ] **Step 3: Implement**

```ts
export const SCOPES = [
  'problems:read', 'problems:write', 'problems:publish',
  'submissions:read', 'submissions:write',
  'orgs:read',
  'packages:read', 'packages:write',
] as const;
export type Scope = (typeof SCOPES)[number];

export function hasScope(actor: { via: 'session' | 'token'; scopes: string[] }, required: Scope): boolean {
  // Branch on `via`, NOT on scopes.length — a session's [] means "unrestricted
  // human" and a token's [] means "declared no permissions". Same value,
  // opposite meanings; keying on emptiness gets one of them wrong.
  if (actor.via === 'session') return true;
  return actor.scopes.includes(required);
}
```

`packages/contracts` must not import from `apps/api` — `hasScope` takes a structural argument, not the `Actor` type.

- [ ] **Step 4: Tighten `CreateTokenRequest`.** `scopes` becomes `z.array(z.enum(SCOPES))`, so an unknown scope is a 422 at the boundary rather than a string stored forever that matches nothing. Add a test that `["bogus:scope"]` is rejected.

- [ ] **Step 5: Prove discrimination.** Change `hasScope` to `if (actor.scopes.length === 0) return true;` — the plausible wrong implementation. Confirm case 4 fails and cases 1-3 pass. Report the output. Revert.

- [ ] **Step 6: Commit**

---

## Task 2: `@RequireScope` and `ScopeGuard`

**Files:** Create `apps/api/src/authn/require-scope.decorator.ts`, `apps/api/src/authn/scope.guard.ts`; modify `apps/api/src/authn/authn.module.ts`; test `apps/api/test/scope-guard.spec.ts`

**Consumes:** Task 1's `hasScope`, `Scope`.

- [ ] **Step 1: Write the failing tests**

Against a real app (`apps/api/test/app.harness.ts`), using a route that carries `@RequireScope`:

```
a session reaches a scoped route
a token holding the scope reaches it
a token lacking the scope gets 403 scope_required
a token with no scopes gets 403 scope_required
a token reaching a route with NO scope metadata gets 403 scope_required   <- deny by default
an anonymous request still gets 401 from AuthGuard, not 403               <- ordering
```

The fifth is the structural guarantee. The sixth pins guard ordering: `AuthGuard` must run first, or an unauthenticated request reports a scope problem instead of an authentication one.

- [ ] **Step 2: Run, watch fail**

- [ ] **Step 3: Implement**

```ts
export const REQUIRED_SCOPE = 'duckoj:required-scope';
export const RequireScope = (scope: Scope): CustomDecorator<string> => SetMetadata(REQUIRED_SCOPE, scope);
```

```ts
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const actor = req.actor;
    // No actor: either @Public() or a judge route. AuthGuard already decided;
    // scopes are a property of an actor and there is none to constrain.
    if (!actor) return true;
    if (actor.via === 'session') return true;

    const required = this.reflector.getAllAndOverride<Scope | undefined>(REQUIRED_SCOPE, [
      context.getHandler(), context.getClass(),
    ]);
    // Deny by default: a token-reachable route with no declared scope is a
    // hole, so refuse rather than allow. Forgetting the decorator fails closed.
    if (!required) throw new AppError(403, 'scope_required', 'This route is not reachable with an access token.');
    if (!hasScope(actor, required)) {
      throw new AppError(403, 'scope_required', `This token lacks the ${required} scope.`);
    }
    return true;
  }
}
```

Register in `AuthnModule`'s providers as a second `APP_GUARD`. **Verify the order empirically** — Nest runs global guards in registration order, and test 6 is what proves `AuthGuard` still runs first. If the order is wrong, say so rather than reordering blindly.

- [ ] **Step 4: Prove discrimination.** Delete the `if (!required)` branch (allow-by-default). Confirm test 5 fails. Report. Revert.

- [ ] **Step 5: Commit**

---

## Task 3: Decorate every route, and keep R49 closed

**Files:** modify every controller under `apps/api/src`; test `apps/api/test/scope-matrix.spec.ts`

- [ ] **Step 1: Inventory the routes.** `git grep -nE "@(Get|Post|Patch|Put|Delete)\(" -- apps/api/src`. For each, decide: `@Public()`, `@RequireScope(...)`, or session-only. Put the inventory in your report as a table — it is the reviewable artifact of this task.

Mapping from spec §2.3:

| Route | Marker |
|---|---|
| `GET /problems`, `GET /problems/:code` | `@Public()` + `@RequireScope('problems:read')` |
| `POST /problems`, `PATCH /problems/:code` | `@RequireScope('problems:write')` |
| `POST /problems/:code/revisions`, `…/publish`, `GET …/revisions` | `@RequireScope('problems:publish')` |
| `POST /submissions` | `@RequireScope('submissions:write')` |
| `GET /submissions/:id` | `@RequireScope('submissions:read')` |
| `GET /orgs`, `GET /orgs/:slug` | `@Public()` + `@RequireScope('orgs:read')` |
| `POST /packages` | `@RequireScope('packages:write')` |
| `GET /packages/:hash` | `@RequireScope('packages:read')` |
| `/auth/tokens/*`, `/auth/totp/*`, `/admin/*` | leave `SessionOnlyGuard`, no scope |
| `/auth/login`, `/auth/register`, `/auth/logout`, `/auth/me` | see below |
| `/healthz`, `/readyz`, `/docs`, `/openapi.json` | `@Public()` |
| `internal/*` | judge routes, untouched |

**A `@Public()` route can still carry `@RequireScope`** and should where a token might call it: `@Public()` governs whether an actor is required, the scope governs what a token may do once one is attached. Anonymous callers skip both.

`/auth/me` is the one judgement call: it reports the caller's own identity and grants nothing. Decide, and say which in the report.

- [ ] **Step 2: The escalation test, kept and extended.** Phase 2b's R49 was found by minting a token scoped `['submissions:read']` and using it to promote a user to admin. Reproduce that sequence and assert it fails — at `SessionOnlyGuard` for `/admin`, and now at `ScopeGuard` for token-reachable routes.

- [ ] **Step 3: The scope matrix.** Data-driven: each scope × {session, token-with, token-without, token-empty}. Assert status and `code`.

- [ ] **Step 4: Run the full workspace suite.** Existing tests use sessions and should be unaffected. **Any existing test that breaks is a finding, not a nuisance** — report which and why before changing it.

- [ ] **Step 5: Commit**

---

## Task 4: The route-marker drift test

**Files:** create `apps/api/test/route-marker-coverage.spec.ts`

- [ ] **Step 1:** Parse every controller for `@Controller` prefixes and route decorators. For each non-internal route, assert it carries at least one of: `@Public()`, `@RequireScope`, or a class-level `SessionOnlyGuard`.

Model it on `packages/contracts/test/route-coverage.spec.ts`, which exists because registering a route with Nest and registering it with the contracts registry are two independent acts that silently disagreed for eleven routes.

- [ ] **Step 2: Prove it discriminates.** Remove one decorator; confirm the test names the route. Report. Restore.

- [ ] **Step 3: Commit**

---

## Task 5: Scope picker when minting a token

**Files:** modify `apps/web/src/routes/` (wherever token minting lives; if there is no UI for it yet, **say so and stop** — building one is Phase 3b's surface, not this task's)

- [ ] **Step 1: Check whether a token UI exists at all.** `git grep -rn "auth/tokens" -- apps/web/src`. If nothing renders it, report that and skip to Task 6 — do not invent a screen.

- [ ] **Step 2 (only if a UI exists):** Replace the free-text scope input with checkboxes over `SCOPES`, and show the exact scope strings — a setter reading `problems:publish` learns more than one reading "Can publish".

- [ ] **Step 3: Commit or report skipped**

---

## Task 6: Adopt the router

**Files:** create `apps/web/src/router.tsx`; modify `apps/web/src/main.tsx`, `apps/web/src/routes/*.tsx`

**The Playwright suite must pass unchanged.** That is this task's acceptance bar.

- [ ] **Step 1: Read the current routing.** `parseRoute` in `main.tsx` matches five paths, with static-before-dynamic ordering that must be preserved: `/problems/new` wins over `/problems/:code`. TanStack Router resolves specificity structurally, which is the point — but verify it, do not assume.

- [ ] **Step 2: Build the route tree.** Root route renders the `Shell` (nav + `<main>`); children are `/`, `/problems`, `/problems/new`, `/problems/$code`, `/problems/$code/edit`, `/problems/$code/revisions`, `/submit`.

- [ ] **Step 3: Convert links.** Plain `<a href>` becomes `<Link to>`. This changes navigation from a full page load to a client-side transition — a real behaviour change. **State that survives a transition but did not before is the risk**; the `me` query in particular is now shared across routes rather than re-fetched.

- [ ] **Step 4: Delete `parseRoute`.** Not commented out. If something still needs it, the conversion is incomplete.

- [ ] **Step 5: Run the vitest suite and the Playwright suite.** Playwright needs a rebuilt bundle and a recreated Caddy container:
  `corepack pnpm --filter @duckoj/web build && podman-compose up -d --no-deps --force-recreate caddy` then `corepack pnpm --filter @duckoj/web test:e2e`.
- [ ] **Step 6: Verify deep links specifically.** `/problems/aplusb` on a cold load, and `/problems/new` resolving to the create form rather than a problem whose code is `new`.
- [ ] **Step 7: Commit**

---

## Task 7: Acceptance and ledger

- [ ] **Step 1: Clean-tree gate.** `rm -rf packages/*/dist apps/*/dist packages/*/tsconfig.tsbuildinfo apps/*/tsconfig.tsbuildinfo`, then install and all three gates. **Rebuild `apps/web` and recreate Caddy afterwards** — the gate deletes the directory Caddy serves from.
- [ ] **Step 2: Verify each acceptance criterion individually, with evidence.**
- [ ] **Step 3: Write `docs/superpowers/ledgers/2026-08-21-phase-3a-foundations-ledger.md`** — deferred-work table first, then the rulings.
- [ ] **Step 4: Report. Do not merge or push.**

---

## Acceptance criteria

1. A token minted with no scopes reaches **no** scoped route, and the test proving it fails against an implementation keyed on `scopes.length === 0`.
2. A session is never constrained by scopes, on any route.
3. A token scoped `submissions:read` cannot promote a user to admin — R49's exact sequence, still refused.
4. A token-authenticated request to a route with no `@RequireScope` is refused, and deleting the deny-by-default branch makes a test fail.
5. An anonymous request to a scoped route gets 401, not 403 — guard ordering intact.
6. Every non-internal route carries `@Public()`, `@RequireScope`, or `SessionOnlyGuard`, and removing one marker makes the drift test name that route.
7. An unknown scope string is rejected at the contract boundary.
8. `parseRoute` no longer exists in the codebase.
9. The Playwright suite passes **unchanged**, including deep links on a cold load.
10. All gates green from a clean tree with `dist/` **and** `tsconfig.tsbuildinfo` deleted.
