# Phase 3a — Token scopes and routing: design

**Status:** approved for implementation.
**Predecessors:** `2026-08-20-phase-2b-problems-design.md`.
**Read first:** `docs/superpowers/ledgers/2026-08-20-phase-2b-problems-ledger.md` — R23, R49, R52 and R58 are inputs to this spec.

---

## 1. Why this is its own phase

Phase 3 was going to be one phase: organization management, the problem
member editor, browser package upload, a router, and token scopes. That is
five workstreams, three of which are new screens.

Two of the five are **structural** and get monotonically more expensive the
more screens exist:

- **Routing.** `apps/web` hand-rolls `parseRoute` against
  `window.location.pathname`. Task 12 measured the cost at five routes: it now
  needs explicit static-before-dynamic ordering, and correctness depends on a
  human reading the file top to bottom in the right order rather than a router
  resolving specificity structurally (R58). Phase 3b adds at least four more
  routes.
- **Token scopes.** `Actor.scopes` is threaded through 69 import edges and
  enforced nowhere. Every new endpoint added before enforcement is another
  endpoint whose scope semantics have to be decided retroactively.

So this phase does those two, and nothing else. Phase 3b builds the screens on
top of a real router with a real permission model underneath.

This is the same reasoning that split Phase 2b's Task 7 into 7a and 7b, for
the same reason: a large review surface hides defects, and this project's
value has come from small diffs reviewed hard.

### In scope

- Adopt `@tanstack/react-router`; delete `parseRoute`.
- Enforce `Actor.scopes` on every token-authenticated route.
- A scope vocabulary, and the UI to pick scopes when minting a token.

### Out of scope

Organization management · the problem member editor · browser package upload ·
tags · contests · anything in Phase 2b's deferred table that is not one of the
two items above.

---

## 2. Token scopes

### 2.1 The problem, stated precisely

`Actor.scopes` is accepted at `POST /auth/tokens`, stored in
`access_tokens.scopes` (`text[]`, since migration `0000`), read back into the
actor by `TokenService.resolve`, and **read by nothing that makes a decision**.
Two comments in the codebase already say so.

The consequence is not cosmetic. Phase 2b's Task 10 reviewer minted a token
scoped `['submissions:read']` and used it to promote a user to **admin**
(R49). The fix was `SessionOnlyGuard` on the admin route, which is correct and
also blunt: a route is either session-only or open to any token its owner
holds. There is still no way to express "this token may submit but not
publish".

**A field that looks like a permission system invites people to trust it.**
Someone hands out a token believing it is read-only. It is not — it carries
every power its owner has, minus a handful of session-only routes.

### 2.2 No legacy to honour

The old DMOJ application has a single `api_token` per profile
(`judge/models/profile.py:268`) with no scopes of any kind. There is no
vocabulary to inherit and the deferred data migration constrains nothing here.
This is a free design, and it is the last moment it will be free.

### 2.3 The vocabulary

`<resource>:<action>`, lowercase, colon-separated. Exactly these:

| Scope | Grants |
|---|---|
| `problems:read` | `GET /problems`, `GET /problems/:code` |
| `problems:write` | `POST /problems`, `PATCH /problems/:code` |
| `problems:publish` | attach a revision, publish a revision, list revisions |
| `submissions:read` | `GET /submissions/:id` |
| `submissions:write` | `POST /submissions` |
| `orgs:read` | `GET /orgs`, `GET /orgs/:slug` |
| `packages:read` | `GET /packages/:hash` |
| `packages:write` | `POST /packages` |

Deliberately absent: any scope granting credential management or role grants.
Those routes stay `SessionOnlyGuard` and are unreachable by **any** token,
scoped or not. A machine credential must not be able to rewrite the
credentials that govern it, and a scope that could grant that power would
re-open R49 through the front door.

`problems:publish` is separate from `problems:write` on purpose. Editing a
statement and making a revision live are different blast radii: publishing
changes what every future submission is graded against.

### 2.4 The rule

**A scope grants nothing on its own. It only ever narrows.**

Authorization is `hasRole(actor) AND hasScope(actor)`. A token scoped
`problems:write` held by a plain user still cannot create a problem, because
`canCreateProblem` fails first. Scopes are a ceiling, never a floor —
otherwise minting a token becomes a privilege-escalation primitive, which is
precisely the bug this phase exists to close.

### 2.5 Empty scopes: two meanings, one trap

`SessionService.resolve` returns `scopes: []` for every session
(`session.service.ts:53`). `TokenService.resolve` returns whatever the token
was minted with, which may also be `[]`.

So an empty array means "unrestricted human" on one path and "declared no
permissions" on the other. **Same value, opposite meanings** — and any
enforcement that keys on `scopes.length === 0` will get one of the two wrong.

The rule, and it is the one thing in this spec most likely to be implemented
incorrectly:

```
via === 'session'  ->  scopes are not consulted at all
via === 'token'    ->  the required scope MUST be present in scopes
```

Enforcement branches on `via`, never on emptiness. A token minted with no
scopes therefore reaches **nothing** that requires one — deny by default,
consistent with the global `AuthGuard`.

That is a breaking change for any token already issued. Acceptable: this is
pre-alpha, `access_tokens` holds only what this project's own e2e scripts
minted, and the alternative — empty means full access — perpetuates exactly
the trap being closed.

### 2.6 Mechanism

A `@RequireScope('problems:write')` decorator setting route metadata, read by
a `ScopeGuard` registered as a global `APP_GUARD` after `AuthGuard`.

**Deny-by-default, enforced structurally.** A route reachable by a token and
carrying no `@RequireScope` is a hole, so the guard rejects any
token-authenticated request to a route with no scope metadata, rather than
allowing it. Forgetting the decorator fails closed with `403 scope_required`,
never open — the same shape as `@Public()`, whose absence produces a 401.

A drift test asserts every non-internal route either carries `@RequireScope`,
carries `@Public()`, or is under `SessionOnlyGuard`. Modelled on
`route-coverage.spec.ts`, which exists because two independent registrations
silently disagreed for eleven routes.

---

## 3. Routing

### 3.1 What exists

`@tanstack/react-router` has been a declared dependency since Phase 0 and is
imported nowhere. `apps/web/src/main.tsx` matches five paths by regex, links
are plain `<a href>`, there is no History API listener, and every navigation
is a full page load.

### 3.2 What changes

Adopt the router. Delete `parseRoute`. Convert the five routes and the shell
to the router's own layout mechanism.

Client-side navigation is a real behaviour change, not cosmetic: today every
link discards the app's state and re-runs `/auth/me`. That is also why it has
worked so far, so the risk is the reverse — state that survives a transition
now, and did not before.

### 3.3 The one thing that must not regress

Deep links. `/problems/aplusb` must serve on a cold load, and `/problems/new`
must still win over the generic `/problems/:code` capture. The Caddyfile's
`try_files {path} /index.html` already handles the cold load; the router must
not undo it.

The Playwright suite already asserts this across three routes and is the check
that matters — jsdom cannot see a route that only breaks behind a real server.

---

## 4. Testing

1. **The scope matrix.** Every scope crossed with: a session (ignores scopes),
   a token holding it, a token lacking it, a token with none. Data-driven,
   against a real database.
2. **The escalation test, kept and extended.** R49's reviewer proved the hole
   by minting a scoped token and promoting a user to admin. That exact
   sequence must fail — and must now fail at the scope guard for
   token-reachable routes, and at `SessionOnlyGuard` for credential routes.
3. **The drift test** of §2.6.
4. **Browser tests for routing.** The existing Playwright suite must pass
   unchanged. That is the acceptance bar for §3: if adopting a router requires
   editing those assertions, the router changed behaviour and the change needs
   justifying in the ledger, not an edited test.
5. **Every new test demonstrated to fail** against unfixed code, with the
   failure output recorded. Phase 2b's most valuable evidence came from
   implementers reporting that their own tests could not fail.

---

## 5. Risks

**Scope enforcement is a global guard.** Getting it wrong locks every
token-authenticated route out of the system, including `scripts/e2e-*.ts`.
Those scripts use sessions, not tokens, so they should be unaffected — verify
that rather than assume it.

**The `via` branch is the whole design.** An implementation that checks
`scopes.length === 0` instead of `via` will pass a naive test suite and grant
every session-authenticated request nothing, or every empty-scoped token
everything. §2.5 exists because this is the likely defect.

**Router adoption touches every route at once.** There is no incremental path
— `parseRoute` either owns routing or the router does. Mitigated by the
Playwright suite, which tests the observable behaviour rather than the
mechanism.
