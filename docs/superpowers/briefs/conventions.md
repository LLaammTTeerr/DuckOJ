# Implementer conventions (read fully before touching code)

You are one implementer in an autonomous campaign
(`docs/superpowers/specs/2026-08-29-province-ready.md`). No human is watching:
never ask questions — rule on ambiguities, note each ruling in your report.
Never dispatch subagents.

## Read first
- `docs/runbook.md` sections: "Authentication is deny-by-default", "Adding a
  database table", "Adding an endpoint", "Regenerating contracts", "The
  `@Inject` convention", "Reading a guarded table".
- `docs/DECISIONS.md` (skim D1–D15; add a new numbered D-entry for any new
  product ruling you make).
- One existing example in the same shape as what you build (e.g.
  `apps/api/src/admin/admin-contests.controller.ts`, `apps/api/src/authz/contest.access.ts`,
  `packages/contracts/src/admin.ts`, `apps/web/src/routes/admin.tsx`).

## Hard rules
- Tooling: `corepack pnpm` (bare `pnpm` is not on PATH). Node 22, ESM TS.
- Deny-by-default AuthGuard: every route carries EXACTLY ONE marker
  (`@Public` / `@RequireScope` / `@NoScopeRequired` / `@SessionOnly`).
  Admin-only operations are `@SessionOnly` at the class + admin check in the
  service (404 for reads that would leak existence, 403 `admin_forbidden`).
- Reads answer 404, never 403, for things the actor may not see.
- Contracts: Zod schemas + `registry.registerPath` with `tags`; every new
  route gets a tag from the existing twelve (`packages/contracts/test/tags.spec.ts`
  guards this). Regenerate `openapi.json` + `packages/sdk/src/generated.ts`
  (`pnpm --filter @duckoj/contracts openapi && pnpm --filter @duckoj/sdk exec openapi-typescript ../../openapi.json -o src/generated.ts`).
- Migrations: SQL files in `packages/db/migrations/NNNN_name.sql` + drizzle
  meta; use the number given in your brief.
- Tests: TDD. Every behaviour test must be shown failing against the broken
  code (mutation-check: comment the fix out, run, see red, restore). Use
  `cp` backups for untracked files. Integration tests use
  `apps/api/test/db.harness.ts`'s `testDbUrl()` (Postgres container via podman).
- Web: React 19 + TanStack Router/Query, SDK client from `apps/web/src/api.ts`;
  every entity is a hyperlink; async handlers use try/catch/finally busy flags;
  monospace/plain style — match existing screens. Tests with Testing Library
  in `apps/web/test/`.
- Before reporting: run from repo root
  `corepack pnpm -r typecheck && corepack pnpm typecheck:scripts && corepack pnpm -r lint && corepack pnpm lint:scripts && corepack pnpm -r test`
  then the contracts/SDK regen (no diff left) and
  `corepack pnpm --filter @duckoj/web exec vite build`. All green or report why.
- Commit your work yourself: `git add -A && git commit -m "<conventional msg>"`
  on the current branch (main). Do not push.
- Run `graphify update .` at the end (ignore failures).

## Report
Write `docs/superpowers/briefs/<task>-report.md` (≤60 lines): what shipped,
files, tests (with the red→green evidence), rulings, anything left out.
Return only: status (DONE / DONE_WITH_CONCERNS / BLOCKED), commit shas, one
line of test summary, concerns.
