# Phase 5a — Web screens for contests, profiles and recovery: ledger

**Decisions:** D2 (UI after email).

**Result:** 766 tests green (was 750). Seven new screens. The password-reset
flow is reachable from a browser for the first time.

---

## R1 — I shipped a feature that linked to 404s

Phase 3f's mail says `${PUBLIC_ORIGIN}/reset-password?token=…` and
`/verify-email?token=…`. **Neither route existed.** The recovery feature was
complete, tested end to end at the API, and unreachable by the person it was
for.

Same shape as the two holes this project has already closed — a contest nobody
could join, an organization nobody could join — and I created this one myself
four commits earlier. Worth naming: *"the API is done"* is not a claim about
whether anyone can use it.

Fixed first, before the screens D2 actually asked for.

## R2 — verification waits for a click

`/verify-email` renders a button rather than firing the request on mount.
**Link prefetchers and mail scanners follow URLs**, and a one-time token spent
by a scanner is a token the user never gets to use.

The test asserts nothing has been called before the click, which is the only
form of that assertion that would fail against the on-mount version.

## R3 — the forgot-password screen keeps the server's silence

The endpoint answers identically whether or not the account exists. A screen
that said "we sent it" only for real addresses would undo that entirely, so it
says *"if that address has an account"* unconditionally.

Mutating the copy to imply existence reddens the test.

## R4 — a defect the test found in my own UI

With no token, `/verify-email`'s button read **"Working…"** — because `busy`
and `disabled` were one flag, and a missing token disabled it. Nothing was
working. Split into two props.

## R5 — `RecoveryLink` sits beside `LoginForm`, not inside it

Adding a `<Link>` to `LoginForm` broke its three unit tests: that component is
deliberately router-free so they can render it bare, and a `<Link>` needs a
router context they do not build.

Reverted and placed at the three call sites in the router instead. The
component's testability is a property worth preserving, not an obstacle.

## R6 — the router's typed links caught six missing routes

Writing `<Link to="/contests/$key">` before registering the route is a compile
error listing every path that does exist. Ten errors on first typecheck, all of
them "this route is not in the tree" or "this param is not on it".

That is a better failure than a runtime 404, and it is the reason the contest
pages could not accidentally ship linking to nothing — which is exactly what
R1 was.

## R7 — two contract gaps the SDK surfaced

`GET /users/{username}` and `/users/{username}/rating` never declared their
path parameter in the OpenAPI registry, so the generated SDK typed
`params.path` as `undefined` and the call would not compile.

Real gaps in the contract, not a web-app problem: any generated client would
have had the same hole. Fixed in `packages/contracts`.

## R8 — the stale-artifact trap, a fifth time

After regenerating `packages/sdk/src/generated.ts`, the web app still failed to
typecheck. `@duckoj/sdk` resolves through `dist`, and the generated *source*
had updated while the built artifact had not.

Documented four times in this project — stale `dist`, stale image, stale SDK,
stale migrate container — and it still cost a diagnosis. `pnpm -r build` before
a cross-package typecheck is the habit; I did not have it.

## R9 — the `contestKey` obligation, made visible

4d's design noted that the web app owes the contest key from its contest
screen. It now does: the contest's problem table links to
`/submit?problem=…&contest=…`, and `SubmitPage` sends `contestKey` only when
that search param is present.

**Submitting from the ordinary problem page is still practice**, and the screen
says so — "Join to submit" where the link would otherwise be. That is the cost
of the explicit-key decision, surfaced rather than hidden.

## R10 — mutation evidence

| Mutation | Result |
|---|---|
| M1 Submit link offered before joining | 1 fail |
| M2 join enabled before the contest starts | 1 fail |
| M3 rating change unsigned | 1 fail |
| M4 `unrated` rendered as blank | 1 fail |
| M5 forgot-password confirms the account exists | 1 fail |
| M6 reset form renders without a token | 1 fail |
| M7 verification token spent on mount | 1 fail |

## Deferred

**No organization screens.** Orgs are joinable over HTTP as of 3e and still
have no UI; the same gap R1 is about, now knowingly rather than accidentally.

**No admin screens** — rating a contest, promoting a user and deciding join
requests are all API-only.

**The scoreboard renders per-problem points only**, not attempts or penalty
detail. `format_data` carries more for `icpc`; showing it needs a per-format
cell renderer, which is a design question rather than a plumbing one.
