# Standing constraint: the API is the product surface

**Recorded 2026-08-21, at the user's direction, before Phase 3b design.**

> "you need to create API for virtual everything possible so that we can build
> an MCP on top of this for agent to interact with"

## What this changes

Every capability the web app has must be reachable over HTTP by a caller with
no browser. The web app becomes **one client of the API**, not the place where
features live. An MCP server is then a thin translation layer over routes that
already exist, rather than a parallel implementation.

Concretely, from now on:

1. **No capability may exist only in the UI.** If a screen can do it, a route
   can do it. A form that assembles three API calls is fine; a form that does
   something no route exposes is a defect.
2. **Every route is registered in the OpenAPI document.** The MCP layer is
   generated from it, so an unregistered route is invisible to agents — the
   same failure that hid eleven routes until Phase 2b's Task 7b.
   `route-coverage.spec.ts` already enforces this.
3. **Every route carries a scope.** Phase 3a's `@RequireScope` is what lets an
   agent hold a *narrow* credential. An MCP server running with a token scoped
   `problems:read` is a materially different risk from one holding its owner's
   full authority. `route-marker-coverage.spec.ts` already enforces this.
4. **Reads must be listable, not only fetchable-by-id.** An agent cannot use
   `GET /submissions/:id` without a way to discover ids. Today there is no
   submissions list endpoint; that is the clearest gap.
5. **Errors stay machine-readable.** The `code` field is the contract; message
   wording is not. This already holds and must keep holding.

## Known gaps, as of this note

- No `GET /submissions` list — an agent cannot enumerate its own submissions.
- No user-facing read of a problem's members beyond `GET /problems/:code`.
- No organization write routes at all (create, update, membership).
- No token *listing* by scope, and no way to introspect what a scope grants.
- No `GET /languages` — an agent must guess `languageKey` values, and
  `POST /submissions` rejects unknown ones with no way to discover valid ones.

The last is the sharpest: it makes the submit route unusable by a caller that
did not read the seed script.

## What this does not mean

It does not mean building an MCP server now, and it does not mean designing
routes for hypothetical agents. It means that when Phase 3b adds a screen, the
route comes first and the screen consumes it — which is the order the project
already follows, now written down so it survives a phase where UI is the
deliverable.
