# QHH Online Judge

A ground-up rewrite of the QHH Online Judge: a TypeScript monorepo with a NestJS
API, a PostgreSQL data layer, a typed SDK, and a React frontend.

- Design: `docs/superpowers/specs/2026-08-17-foundation-design.md`
- Runbook: `docs/runbook.md` — start here for local setup, testing, and the
  conventions a newcomer needs (container runtime for tests, the `@Inject`
  requirement, the auth-guard default, the guarded-import boundary, and more).

## Phase 0 delivers

Monorepo and tooling (pnpm workspaces, shared TypeScript/ESLint config, CI) ·
PostgreSQL schema for identity and organizations, migrated with Drizzle ·
authentication by session cookie, personal access token, and TOTP two-factor ·
RFC 9457 problem-detail errors · centralised authorization with an
ESLint-enforced import boundary around visibility-filtered ("guarded") tables ·
an OpenAPI document generated from Zod contracts and a typed SDK generated from
it · a minimal React SPA exercising the contracts-to-SDK-to-frontend loop · a CI
workflow (typecheck, lint, test, contract-drift check, build) · a Docker Compose
deployment shape (Postgres, migration job, API, Caddy reverse proxy).

## Phase 0 does not deliver

Problems, submissions, judging, contests, or ratings. Those are Phases 1–4. There
is also no judge worker, no object storage (MinIO), and no job queue (BullMQ) —
those arrive with the phases that need them.

Two things described above have not been run end-to-end in this environment and
should not be treated as verified until they are:

- **The full gate is verified command-by-command locally**
  (`pnpm -r typecheck && pnpm -r lint && pnpm -r test`), but the CI workflow
  itself (`.github/workflows/ci.yml`) has never executed on GitHub's runners.
- **`docker compose up` has never been run.** This development environment has
  no Docker daemon and no Compose provider. The API image has been built and
  smoke-tested directly with Podman (see `docs/runbook.md`), but the full
  Compose stack — Postgres healthcheck gating, migration-then-API ordering,
  Caddy's reverse proxy against a live API — is unverified end-to-end.
