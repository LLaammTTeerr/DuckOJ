# B30 — whole-API-surface bug hunt (contracts / guards, 2026-08-31)

Branch `worktree-agent-ac85e895628c3c064`, nothing pushed. **DONE.** Fuzzed
**112 documented operations** against the real `AppModule` across three
credentials (session, scopeless token, admin) — standing spec is 7 shapes ×
session+token, a throwaway sweep added the admin pass. No D-numbers:
every fix applies an existing precedent (`SubmissionIdParam`), none is a product
ruling. Live stack untouched; all runs on throwaway podman Postgres, no `bh30-*`
left anywhere.

## Findings — commits `8a317a4`, `957df3d`, `9f202f4`

1. **`DELETE /auth/tokens/:id` 500s on an out-of-range id (medium, bug).** Used
   Nest `ParseIntPipe`; `99999999999999999999` → `1e20` (accepted, positive)
   overflowed `access_tokens.id` (`22003` → `500`). The only first-layer 500 the
   fuzz found. Fix: Zod pipe `RevokeTokenIdParam` (zod v4 `.int()` =
   `isSafeInteger`) → 422.
2. **`PATCH /contests/:key/clarifications/:id` same 500 (medium, bug).** Guard
   `!Number.isInteger(id)` caught `NaN` but not `1e20`. → `isSafeInteger`, 404.
3. **`POST /orgs/:slug/requests/:id/{approve,reject}` same 500 (medium, bug).**
   Hand-rolled `parseId` had the identical gap. → `isSafeInteger`, 400.
   → 1–3 in `8a317a4`; net `test/id-param-overflow.spec.ts`, all red (500) →
   green (422/404/400). The Zod-validated id params were already safe.
4. **Route-fuzz lost all write-body coverage when D82 landed (medium,
   coverage).** The B-5 fuzz sent no `Origin`, so post-D82 every cookie write
   403'd at the origin gate — no malformed body reached a write handler, and the
   vacuity guard couldn't see it. Extended (`957df3d`): `Origin` on the session
   pass (logout excluded), a scopeless-token pass, a numeric-edge/overflow-id
   pass, and a guard asserting ≥1 write hits a 422 pipe (mutation: drop the
   header → 0, red).
5. **Nothing tied registered routes to the contract (low, coverage).** Fuzzer
   walks OpenAPI, marker-coverage walks Nest; a registered-but-undocumented
   route was invisible to both. New `route-contract-parity.spec.ts` (`9f202f4`):
   114 registered non-internal routes, all documented; `/healthz`+`/readyz` the
   sole listed exemptions. Mutation: drop a path from openapi.json → red.
6. **Zero-scope token cannot write, on every route (cleared, now pinned by
   #4).** Every `@RequireScope` write → 403 (ScopeGuard), never partial, never
   5xx; only `POST /auth/email/verify/send` (202) and `GET /auth/me` (200) are
   token-reachable non-reads, both `@NoScopeRequired` by design and metered.

## Cleared with evidence

- **Cursor** — every `parseCursor` is `Number`+`isSafeInteger`+`<0` → 422;
  overflow/`NaN`/array/`1e309` all 422 (fuzz + existing `invalid_cursor` specs).
- **D102** — gated in `TokenService.issue`/`resolve` (two chokepoints);
  `password-change-required.spec.ts` holds it.
- **429** — `Retry-After`+code via `AppError.headers`→`ProblemFilter`;
  `rate-limit.spec.ts` / `submission-rate-limit.spec.ts`.

## Verify & concerns

typecheck (+scripts), lint (+scripts), contracts (39) and the touched api specs
(id-overflow, route-fuzz, parity, marker-coverage, tokens, orgs, clarifications)
green; regen no diff; `vite build` clean; full api suite 1127/1127 (3 shards).
- Findings 2 & 3 are latent behind a valid parent (a junk key/slug 404s before
  the id is bound), so the blind fuzz only surfaced #1; 2 & 3 are the same class,
  demonstrated with seeded parents.
- `withTestDb`'s per-test transaction makes an overflow 500 cascade — a **test
  artifact, not production** (each request gets its own connection). Inventory
  taken with a non-transactional throwaway sweep; only #1 was first-layer.
