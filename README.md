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

Two things described above had not been run end-to-end when Phase 0 shipped:

- **The full gate is verified command-by-command locally**
  (`pnpm -r typecheck && pnpm -r lint && pnpm -r test`), but the CI workflow
  itself (`.github/workflows/ci.yml`) has never executed on GitHub's runners.
- ~~`docker compose up` has never been run.~~ **Update, Phase 1:** the full
  Compose stack (Postgres, migration, API, `judged`, the real `judge`
  container, Caddy) has since been brought up and torn down end-to-end
  against real Podman, repeatedly, via `scripts/compose-up.sh` — see "Phase 1
  delivers" below and `docs/runbook.md`.

## Phase 1 delivers

Submissions, real grading, and live verdicts: a signed-in user submits C++
source against a seeded problem; `apps/judged` dispatches it to a real,
containerized DMOJ `judge` process over `packages/judge-protocol`'s wire
protocol; per-case and final verdicts are written to Postgres as they arrive;
and the browser sees the result over a WebSocket, without a manual refresh —
no polling anywhere in that path. Verified end to end against the real
containerized judge, not a mock: correct, wrong, and uncompilable C++ each
produced the expected outcome (`AC 3/3`, `WA 1/3`, and a compile failure
surfaced as verdict `IE` with the real compiler's error text — see
`docs/runbook.md` for why `IE` and not `CE` is expected here).

Phase 1 also ships three deliberate, deferred limitations — recorded in
`docs/runbook.md` so they don't cost the next person an afternoon: a compile
error is reported as verdict `IE`; the judge-bridge handshake never checks
the configured key, so network isolation (never publishing `judged`'s port)
is the only real control; and there is no scheduling policy or attempt cap,
so a job that keeps failing to dispatch keeps re-leasing forever instead of
being parked.

## Phase 1 does not deliver

Problem management (authoring or versioning problems beyond the one problem
`scripts/seed-problem.ts` seeds), problem packages, contests, organizations
as a judging surface, scoreboards, ratings, or any scheduling policy —
priority, fairness, and bounded retries all arrive in later phases.
