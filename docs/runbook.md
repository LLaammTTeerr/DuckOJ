# Runbook

## Prerequisites

- Node.js 22 (see `.nvmrc`).
- `corepack enable` — this repo pins `packageManager: pnpm@9.12.0` in `package.json`,
  and Corepack reads that pin. On a normal machine, `corepack enable` makes a bare
  `pnpm` work directly afterwards. **This sandbox has no bare `pnpm` shim** — every
  command below is written as `corepack pnpm ...` so it works here; drop the
  `corepack` prefix on a machine where `pnpm` already resolves.
- A container runtime for the test suite (see below).

## Container runtime for tests — read this before running `pnpm -r test`

`packages/db`'s tests, and most of `apps/api`'s, start a real PostgreSQL container
via Testcontainers. **This machine has no Docker daemon.** It runs rootless
**Podman**, and `packages/db/test/harness.ts` contains a detection block that
points Testcontainers at Podman's Docker-API-compatible socket when
`/var/run/docker.sock` is absent:

```ts
if (!process.env.DOCKER_HOST) {
  const podmanSocket = `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`;
  if (!existsSync('/var/run/docker.sock') && existsSync(podmanSocket)) {
    process.env.DOCKER_HOST = `unix://${podmanSocket}`;
  }
}
```

That socket must be **running** before you run the test suite:

    systemctl --user start podman.socket

Without it, every database-backed test fails with a confusing "cannot find a
container runtime" style error rather than anything that points at Podman. On a
Docker-equipped machine (including CI, which has `/var/run/docker.sock`), the
detection block is a no-op — Testcontainers talks to Docker directly and this
step is unnecessary.

Containers (a Postgres instance per test file, plus a Ryuk reaper) are cleaned up
automatically a few seconds after the test process exits. `podman ps -a` right
after a run may show them still alive mid-reap — that is expected, not a leak.

## Local development

    corepack enable
    corepack pnpm install
    systemctl --user start podman.socket   # or start Docker — see above

    # docker-compose.yml's `postgres` service has no host port mapping (it's only
    # reachable from other Compose services), so it is not useful for running the
    # API against by hand. Run a standalone container instead:
    podman run -d --name qhhoj-pg -p 5432:5432 \
      -e POSTGRES_USER=qhhoj -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=qhhoj \
      postgres:16-alpine
    # (substitute `docker run` on a Docker-equipped machine)

    export DATABASE_URL=postgres://qhhoj:dev@localhost:5432/qhhoj
    corepack pnpm --filter @qhhoj/db migrate
    export TOTP_ENC_KEY=$(openssl rand -hex 32)
    export PUBLIC_ORIGIN=http://localhost:5173
    corepack pnpm --filter @qhhoj/api dev
    corepack pnpm --filter @qhhoj/web dev

`@qhhoj/db`'s `migrate` script and `@qhhoj/api`'s `dev` script are already defined
in their `package.json`s (`tsx ../../scripts/migrate.ts` and `tsx watch src/main.ts`
respectively) — no separate `pnpm exec` incantation is needed. `TOTP_ENC_KEY` and
`PUBLIC_ORIGIN` are both required by `apps/api/src/config/config.schema.ts`; the API
fails fast at boot with a clear Zod error if either is missing.

This exact sequence (container run, `migrate`, `api dev`, `curl /healthz`) was run
end-to-end while writing this runbook: the container started, `migrate` printed
`migrations applied`, the API mapped all routes and logged
`Nest application successfully started`, and `curl -fsS http://localhost:3000/healthz`
returned `{"status":"ok"}`.

## Running the full gate

    corepack pnpm install --frozen-lockfile
    corepack pnpm -r typecheck
    corepack pnpm -r lint
    corepack pnpm -r test

All three must be green before anything ships. `pnpm -r test` needs the container
runtime above.

## The `@Inject` convention — read this before writing a NestJS constructor

Every constructor parameter in `apps/api` carries an explicit `@Inject(...)`
decorator, **including class dependencies where idiomatic Nest would rely on
implicit type-based injection** (`constructor(private readonly foo: FooService)`
with no decorator). This is not a style preference:

- Vitest's default transform compiles TypeScript with esbuild.
- esbuild never emits `design:paramtypes` metadata, which is what Nest's implicit
  DI reads to resolve a constructor parameter's type at runtime.
- Without that metadata, implicit injection silently resolves to `undefined`
  instead of failing loudly, and the first symptom is a baffling 500 deep inside
  a handler — not a clear "cannot resolve dependency" error.

So: **every** constructor parameter — primitives via injection tokens, classes via
their own type — gets an explicit `@Inject(...)`. If you write idiomatic implicit
DI, it will typecheck, it will pass code review by eye, and it will break the
moment a test exercises that class.

## Authentication is deny-by-default — read this before adding a route

`AuthGuard` (`apps/api/src/authn/auth.guard.ts`) is registered globally as
`APP_GUARD`. **Every route requires an authenticated actor unless the handler, or
its whole controller, is marked `@Public()`.** Forgetting the marker fails closed
(401), never open — but forgetting the opposite (marking something `@Public()`
that shouldn't be) fails open, so treat the marker itself as the security-relevant
line in a diff.

Two ways to read the actor inside a handler:

- **`@CurrentActor() actor: Actor`** — throws `401` if there is no actor. Sound to
  type as non-nullable `Actor` precisely because it throws rather than handing you
  `undefined`.
- **`@MaybeActor() actor: Actor | null`** — the nullable form, for `@Public()`
  routes that legitimately serve both anonymous and signed-in callers (e.g.
  `GET /orgs`, which must show a member their private orgs but still work
  anonymously). **Must** be annotated `Actor | null` — `createParamDecorator`
  establishes no compile-time link between the decorator and the parameter type,
  so annotating it as plain `Actor` compiles cleanly and then hands the handler
  `null` at runtime the first time an anonymous caller hits it.

This is the single most important thing to understand before adding an endpoint.

**Credential-management routes take a second guard.**
`@UseGuards(SessionOnlyGuard)` (`apps/api/src/authn/session-only.guard.ts`)
rejects callers whose `Actor.via` is `'token'` with a 403 `session_required`.
`TokensController` and `TotpController` carry it at class level. Add it to
anything that mints, revokes or rewrites a credential: without it, a leaked
personal access token can disable its owner's TOTP (`POST /auth/totp/begin`
upserts a new secret with `confirmedAt: null`) and mint its own replacements, so
revoking the leaked token stops ending the compromise. This is *not* step-up
re-authentication and it does not check `scopes` — `Actor.scopes` is still read
by nothing, and what it should mean is a Phase 1 decision.

## Adding a database table

1. Add it to `packages/db/src/schema/identity.ts` (or another non-guarded schema
   file re-exported from `schema/index.ts`), or to `schema/guarded.ts` if reads
   must be visibility-filtered through `apps/api/src/authz/**` rather than queried
   directly.
2. From the repo root:
   `corepack pnpm --filter @qhhoj/db exec drizzle-kit generate --name <change>`
3. Commit the generated SQL under `packages/db/migrations/` as-is. **Never
   hand-edit a migration that has already been committed** — generate a new one
   for further changes instead.

## Adding an endpoint

1. Add the Zod schema to the **domain module** it belongs to —
   `packages/contracts/src/auth.ts`, `orgs.ts`, `tokens.ts`, or a new sibling —
   and put the `registry.registerPath({ ... })` call in that same file, next to
   the schema. `packages/contracts/src/registry.ts` only *constructs* the shared
   `OpenAPIRegistry`; it contains no paths and must not grow any. A new sibling
   file has to be re-exported from `src/index.ts`, because `registerPath` runs as
   an import side effect and `scripts/emit-openapi.ts` reaches the registry
   through `index.js` — a module nobody imports registers nothing, and emits
   nothing, silently.
2. Implement the controller in `apps/api`, validating input with
   `ZodValidationPipe`. Decide `@Public()` vs. authenticated, and
   `@CurrentActor()` vs. `@MaybeActor()`, per the authentication section above.
   If the route manages credentials, add `@UseGuards(SessionOnlyGuard)` — see
   the authentication section above.
3. Pick the `code` for each error the route can return. `code` is contract:
   `packages/contracts/src/common.ts` promises it is "stable across wording
   changes", so it is chosen deliberately, never derived from a display string.
   Conventions in use:
   - **404 → `<resource>_not_found`**, singular and spelled out, matching the
     table/domain name rather than the URL segment: `organization_not_found`,
     and by extension `problem_not_found`, `submission_not_found`,
     `contest_not_found`. Phases 1–4 add all of those; pick this shape, not
     `org_not_found` or `not_found_problem`.
   - **409 → `<field>_taken`** for uniqueness conflicts (`username_taken`).
   - Anything raised without an `AppError` falls back to the explicit
     status→code table in `apps/api/src/common/problem.filter.ts`.
4. Regenerate the OpenAPI document and the SDK's generated types (see next
   section). CI fails if either is stale.

## Regenerating contracts — do this after any change under `packages/contracts`

    corepack pnpm --filter @qhhoj/contracts openapi
    corepack pnpm --filter @qhhoj/sdk exec openapi-typescript ../../openapi.json -o src/generated.ts

This writes `openapi.json` (repo root) and `packages/sdk/src/generated.ts`. CI's
"Verify OpenAPI and SDK are up to date" step runs the same two commands and then
`git diff --exit-code -- openapi.json packages/sdk/src/generated.ts` — a
forgotten regeneration fails CI, not just a lint pass locally.

## Reading a guarded table

`@qhhoj/db/guarded` may only be imported from `apps/api/src/authz/**`; ESLint's
`no-restricted-imports` rule (`eslint.config.js`) enforces this over all of
`apps/api/src/**`, with `authz/**` exempted. Add a method to the relevant
`*.access.ts` service (e.g. `OrgAccessService.listVisible`) instead of querying
guarded tables directly from a controller or another service. This is deliberate
— see spec §8, "No handler filters visibility by hand".

**Honest limit of the rule:** it only catches *static* `import` statements. It
does not see a dynamic `import()`, and it says nothing about raw SQL —
`` db.execute(sql`select * from organizations`) `` from outside `authz/**` lints
clean. Neither is a realistic accidental shape, but the rule is a guard rail
against carelessness, not a total guarantee.

## Deploying

    corepack pnpm --filter @qhhoj/web exec vite build
    docker compose up -d --build

**Caddy bind-mounts `./apps/web/dist`.** If you skip the `vite build` step, Caddy
starts fine but serves nothing (an empty or missing directory) — build the SPA
before bringing the stack up, not after.

Migrations run automatically via the `migrate` Compose service before `api`
starts (`depends_on: condition: service_completed_successfully`).

`docker compose` needs a `.env` (copy `.env.example` and set a real
`TOTP_ENC_KEY`, e.g. `openssl rand -hex 32`).

### Caddy and HTTPS locally

`caddy validate` against this repo's `Caddyfile` confirms that a bare hostname
site address like `localhost` (the `.env.example` default for `SITE_ADDRESS`)
turns on Caddy's automatic HTTP→HTTPS redirect — this is correct Caddy behaviour
for what looks like a real domain, not a bug in this config. A plain
`curl http://localhost/healthz` will therefore hit a redirect rather than the
JSON body. Use:

    curl -L -k https://localhost/healthz

`-L` follows the redirect, `-k` trusts Caddy's self-signed internal-CA
certificate for local testing.

### Honest status of this deployment path

**The end-to-end `docker compose up` stack has never been run in this
environment.** No Docker daemon and no Compose provider (`podman compose`,
`podman-compose`, `docker-compose`) exist here. What has been verified instead,
command-by-command, on Podman directly: the API image builds cleanly
(`podman build -f apps/api/Dockerfile`), the built image's `CMD` boots Nest and
maps every route including `/healthz`, the `migrate` service's exact command
resolves its imports and reaches a real connection attempt against a fake
database, and `caddy validate` accepts the `Caddyfile`. None of that proves the
Postgres healthcheck gating, the `depends_on` ordering, or Caddy's reverse proxy
actually work together end-to-end under Compose — only a real `docker compose up`
on a Docker-equipped host would.
