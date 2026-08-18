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

## Phase 1: how the judging pipeline fits together

A submission's journey, `POST /submissions` to a verdict in the browser:

1. **`apps/api`** validates the submission and, in the same request, writes a
   `submissions` row and a `grading_jobs` row (state `queued`, `lease_until`
   null, `attempt` 0), then returns.
2. **`apps/judged`**'s `Worker` (`apps/judged/src/worker.ts`) polls
   `JobStore.claim`, which atomically claims one queued-or-lease-expired job
   and stamps a `lease_until` ~60s out. It renews (`heartbeat`s) that lease
   every 20s (`HEARTBEAT_MS`) while the job is in flight, and bounds its own
   dispatch with a 300s ceiling (`MAX_GRADING_MS`) so a hung collaborator
   can't wedge the whole worker loop silently.
3. The claimed job is handed to `DmojDriver.dispatch`, which talks to the
   real DMOJ `judge` container over `BridgeServer`
   (`apps/judged/src/drivers/dmoj/bridge-server.ts`) — a raw TCP server
   speaking DMOJ's length-prefixed, zlib-compressed packet protocol
   (`packages/judge-protocol`).
4. As the judge reports compile/case/finish events, `EventWriter.apply`
   (`apps/judged/src/event-writer.ts`) writes each one to `submissions` /
   `submission_cases` and publishes a wake-up signal over Redis
   (`apps/judged/src/submission-events.ts`).
5. **`apps/api`**'s `SubmissionsGateway`
   (`apps/api/src/realtime/submissions.gateway.ts`) subscribes to that Redis
   channel and pushes the signal to every browser WebSocket subscribed to
   that submission id; the browser re-fetches the submission over the normal
   REST endpoint and updates the UI. No polling anywhere in this path.

### `judged` importing guarded tables directly is legitimate, not a lapse

`apps/api/src/**` may not import `@qhhoj/db/guarded` outside `authz/**`
(ESLint's `no-restricted-imports`, scoped to `files: ['apps/api/src/**/*.ts']`
in `eslint.config.js`), because guarded tables are visibility-filtered and
only `authz/**` is allowed to decide who sees what. `apps/judged/src/event-writer.ts`
imports `@qhhoj/db/guarded` directly (`submissions`, `submissionCases`) and
sits entirely outside that rule's file scope. This is correct, not a hole:
`judged` serves no user request and makes no visibility decision — it writes
grading results as the system, not on behalf of any particular actor. The
rule exists to stop a *handler* from filtering visibility by hand instead of
going through `authz/**`; `judged` never has a caller to filter for in the
first place.

### The realtime WebSocket: auth on upgrade, authorization per subscription

`SubmissionsGateway` sits outside the API's global `AuthGuard` — a WebSocket
upgrade never passes through NestJS's HTTP pipeline (`APP_GUARD` guards
routes, not raw `'upgrade'` events on the HTTP server) — so this class's own
checks are the *only* security here, not defense in depth on top of something
else:

- **Authenticates on the upgrade, before the socket opens.** `onUpgrade`
  calls `authenticate()` and only calls `wss.handleUpgrade` if it resolves an
  actor; an unauthenticated request gets a `401` status line and the raw
  socket is closed — an unauthenticated caller never holds an open
  WebSocket at all.
- **Never reads credentials from the query string.** `authenticate()` reads a
  bearer token from the `Authorization` header, or a session cookie —
  deliberately never `?token=`, because a query-string credential ends up in
  access logs, proxy logs and browser history, the exact leak Phase 0 closed
  for HTTP. Browsers can't set headers on a WebSocket handshake, so the
  browser path is the cookie; programmatic clients (e.g.
  `scripts/e2e-submit.ts`) use the header.
- **Authorizes per subscription, not just per connection.** A `subscribe`
  message calls `SubmissionAccessService.getVisible(actor, submissionId)`
  before adding it to that client's subscription set — being authenticated
  is not being authorized to watch any particular submission's grading.
- **The topic carries a signal, never data.** `notify()` publishes only
  `{ type: 'submission', id }` — never source, verdict, or anything else that
  would need its own per-message authorization check. The client re-fetches
  over the normal (authorized) REST endpoint to learn what actually changed.

### `EventWriter.apply`'s publish is not transaction-safe — read this before wrapping it in one

`apply()` calls `write()`, then — only once `write()` has resolved
successfully — `publish()` (`apps/judged/src/event-writer.ts`). What that
actually guarantees: **a write that fails publishes nothing** — a constraint
violation inside `write()` throws before `publish()` is ever reached, and
this is tested (`event-writer.spec.ts`, "does not publish when the write
itself fails"). What it does **not** guarantee is the stronger property that
a publish inside a *rolled-back transaction* gets undone. `apply` is always
called today with a non-transactional `Db`, so each `write()` is a single
auto-committed statement, and "after write resolves" already means "after
commit" — but that equivalence is a property of how `apply` happens to be
called, not something the code enforces. **Never call `apply` from inside a
caller-managed transaction**: a later rollback would undo the write after the
publish has already fired, and nothing here would know to take it back. A
transactional outbox is the real fix and is deferred to Phase 2. If you find
yourself wrapping a transaction around code that calls `apply`, stop and
re-read this first.

### Three known, deliberate warts

All three are deferred on purpose, not overlooked. Each is the kind of thing
that costs someone an afternoon if it isn't written down.

1. **A compile error is reported as verdict `IE`, not `CE`.** `case_verdict`
   has no `CE` member, so a compile failure writes `IE`. Details, and how the
   submit page and `scripts/e2e-submit.ts` actually distinguish it (by
   `compileOutput` being non-empty, not by verdict), are in "The `IE`-for-
   compile-error wart" section below.
2. **The bridge does not verify the judge key.** `BridgeServer.accept`
   (`apps/judged/src/drivers/dmoj/bridge-server.ts`) replies
   `handshake-success` unconditionally on any `handshake` packet — the `key`
   configured in `judge/judge.yml` is decorative, nothing on the bridge side
   ever checks it. Anything that can open a TCP connection to `judged`'s
   bridge port (9999) can register as a judge and be handed submissions,
   including their source. **Network isolation is the only control**:
   `docker-compose.yml`'s `judged` service deliberately publishes no ports to
   the host, and that must stay true — don't "fix" a need to reach 9999 by
   publishing it. Authenticating the handshake belongs with Phase 2's
   multi-judge work.
3. **There is no scheduling policy and no attempt cap.** `Worker` takes jobs
   in creation order, one judge, first-come-first-served (see the comment
   above the `Worker` class in `apps/judged/src/worker.ts`). A job that fails
   to dispatch is logged and the loop moves on to the next job, but the
   failed job simply re-leases once its 60s lease lapses and may fail again
   — indefinitely. A poison-pill submission degrades itself forever rather
   than being parked or capped. Priority, fairness and bounded retries all
   arrive with Phase 4's scheduling work.

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

This machine has no Docker daemon; it runs rootless Podman with `podman-compose`
1.5, not `docker compose`. `scripts/compose-up.sh` (below) was run against this
stack with that tooling, including a fresh (just-created) `pgdata` volume — see
"What was actually verified" for the exact evidence. Nothing in this section
describes untested behavior; anything not run is called out explicitly in that
section's last paragraph.

The web bundle imports `@qhhoj/sdk`, which is a workspace package with no
prebuilt `dist/` checked in — build it (or run the repo-wide typecheck, which
also emits it via `tsc -b`) before building the web bundle, or Vite fails with
`Failed to resolve entry for package "@qhhoj/sdk"`:

    corepack pnpm --filter @qhhoj/sdk typecheck
    corepack pnpm --filter @qhhoj/web exec vite build

**Caddy bind-mounts `./apps/web/dist`.** If you skip the `vite build` step, Caddy
starts fine but serves nothing (an empty or missing directory) — build the SPA
before bringing the stack up, not after.

`podman-compose` needs a `.env` (copy `.env.example` and set real secrets):

    cp .env.example .env
    sed -i "s/^TOTP_ENC_KEY=.*/TOTP_ENC_KEY=$(openssl rand -hex 32)/" .env
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env

### Bringing the stack up under podman-compose — use `scripts/compose-up.sh`

A plain `podman-compose up -d --build` **does not reliably run migrations
before the API starts.** `api`'s `depends_on: migrate: { condition:
service_completed_successfully }` is correct per the Compose spec, but under
podman-compose 1.5 it does not reliably hold. What was confirmed directly, by
timestamp: with a bare `up -d --build`, the `api` container's `StartedAt` was
earlier than `migrate`'s `StartedAt` by 10+ seconds in every run tried; `api`
happened to serve `/healthz` correctly regardless only because that probe
doesn't touch the database, but a request that did would have raced an
unmigrated schema. Naming `api` alongside `caddy` on a later `up -d` doesn't
help either — podman-compose still treats `migrate` as a dependency to
(re)start and re-triggers the same race, since it recreates and restarts the
`migrate` container as part of resolving `api`'s dependency graph.

The most likely mechanism, based on an isolated experiment (not a trace or
source read of podman-compose's `up` code path, so treat this as the leading
explanation rather than a proven fact): podman-compose pre-creates every
service's container before starting any of them, and
`podman wait --condition=stopped` on a container that was only ever *created*
— never started — was observed to return success immediately instead of
blocking until it actually runs and exits:

```
$ podman create --name t docker.io/library/postgres:16-alpine echo hi
$ podman inspect t --format 'state={{.State.Status}}'
state=created
$ time podman wait --condition=stopped t
0.105s, exit=0   # returns immediately — does not block
```

That would explain the observed race exactly, but the causal link between
this isolated behavior and what podman-compose's dependency checker does
internally during `up` was inferred from the timing correlation, not traced
step by step.

**Whatever the mechanism, the symptom is real and reproducible, so don't rely
on `podman-compose up -d` (with or without `--build`) alone.** Use
`scripts/compose-up.sh` instead — it encodes the sequence that was verified,
by timestamp, to guarantee `migrate` really starts, runs, and exits before
`api`'s container is even created, and it fails loudly (non-zero exit) if any
step fails rather than plowing on:

    ./scripts/compose-up.sh

What the script does, in order: `podman-compose build`; `up -d postgres`;
poll for `postgres` healthy; `up migrate` in the foreground (blocking until it
exits) and check its container's real exit code, not just podman-compose's
own return code; `up -d --no-deps api caddy`; poll for `api` healthy before
exiting. `--no-deps` on the last step is required — without it,
podman-compose restarts `migrate` as part of bringing `api` up and
reintroduces the race, even though migrations already applied cleanly.
(Re-running `migrate` itself is harmless — drizzle's migrator is idempotent,
confirmed by the "already exists, skipping" Postgres notices on a second run
— the danger is only `api` starting before that repeat run finishes.)

`--no-deps` also removes `caddy`'s own `depends_on: api: service_healthy`
gate, since it's the same flag applied to the same command — which is exactly
why the script polls `api` itself before exiting, restoring that guarantee
instead of leaving it to the (broken, under podman-compose) `depends_on`.

Override `COMPOSE`, `POSTGRES_TIMEOUT`, or `API_TIMEOUT` (seconds) as
environment variables if needed; see the comments at the top of
`scripts/compose-up.sh`.

Rootless Podman also cannot bind ports below 1024 without extra host
configuration (`ip_unprivileged_port_start` was `1024` on this machine), so
`docker-compose.yml`'s `caddy` service maps `8080:80` and `8443:443` instead of
`80:80`/`443:443` — the stack is not run as root to work around this. Caddy
inside the container is unaffected; it still listens on 80/443 internally.

### Caddy and HTTPS locally

`caddy validate` against this repo's `Caddyfile` confirms that a bare hostname
site address like `localhost` (the `.env.example` default for `SITE_ADDRESS`)
turns on Caddy's automatic HTTP→HTTPS redirect — this is correct Caddy behaviour
for what looks like a real domain, not a bug in this config. A plain
`curl http://localhost/healthz` will therefore hit a redirect rather than the
JSON body. Use (note the remapped port, per above):

    curl -L -k https://localhost:8443/healthz

`-L` follows the redirect, `-k` trusts Caddy's self-signed internal-CA
certificate for local testing.

### What was actually verified

The full stack was brought up end-to-end under `podman-compose` 1.5 on this
machine, via `scripts/compose-up.sh`, and torn down with `podman-compose
down`. Observed directly:

- `./scripts/compose-up.sh` exited `0` on a **freshly created `pgdata` volume**
  (verified empty via `podman volume ls` immediately beforehand) and printed
  `postgres is healthy`, `migrate exited 0`, `api is healthy`, in that order,
  followed by a `podman-compose ps` showing all four services in the expected
  state.
- On that same run, `podman inspect` showed `migrate`'s `FinishedAt` at
  `18:54:00.622` and `api`'s `StartedAt` at `18:54:01.202` — `api` genuinely
  started after `migrate` finished, not merely after it was created.
- `migrate` printed `migrations applied` with no "already exists" notices on
  that fresh volume (a real first-time schema creation, not an idempotent
  no-op) — confirmed separately on a pre-migrated volume too, where it printed
  the "already exists, skipping" notices and still exited `0`.
- **Failure mode was also exercised**, not just the success path: with
  `POSTGRES_PASSWORD` in `.env` deliberately changed to a value that did not
  match the already-initialized database, `./scripts/compose-up.sh` printed
  the real `password authentication failed for user "qhhoj"` error from
  `migrate`, then `FATAL: migrate exited with code 1`, and exited `1` itself
  (confirmed via `echo $?` on the un-piped invocation, not inferred from
  output). `podman ps -a` afterward showed only `postgres` and the failed
  `migrate` — `api` and `caddy` were never created. The script does not
  proceed past a failed migration.
- `api` reported `healthy` via its `node -e fetch(...)` healthcheck.
- `caddy` started clean, auto-provisioned its local-CA TLS certificate for
  `localhost`, and both `curl -fsS -L -k https://localhost:8443/healthz` and
  `.../readyz` returned `{"status":"ok"}` / `{"status":"ok","database":"ok"}`
  through the reverse proxy — not hitting `api` directly.
- `POST https://localhost:8443/api/v1/auth/register` through Caddy returned
  `201` with the created user profile (`id`, `username`, `email`, etc.), proving
  the reverse proxy, the API, and a migrated database all work together.
- The static SPA (`GET https://localhost:8443/`) served the built
  `apps/web/dist/index.html` through Caddy's `file_server`.
- `podman-compose down` removed all four containers and the project network.
  It reliably printed one warning first
  (`rootless netns: kill network process: permission denied` while stopping
  `api`'s network namespace) but still completed and left `podman ps -a` empty
  afterwards — this appears to be a benign rootless-Podman teardown quirk, not
  a failure to tear down.

Not independently verified: behavior under real `docker compose` (only
podman-compose was available here); behavior under a fresh Podman socket after
a host reboot; and the exact internal mechanism podman-compose uses when
checking `service_completed_successfully` (see the hedge above — the symptom
is confirmed, the internal cause is inferred, not traced).

## End-to-end acceptance against the real judge — `scripts/e2e-submit.ts`

This is the only check in the whole phase that submits real C++ through the
full path (browser API → database → `judged` → bridge → judge → sandbox →
back) instead of against a mock or a fake. Nothing here can be trusted from
reasoning alone; it has to actually run.

### Seed the problem before submitting

`scripts/compose-up.sh` brings the stack up but does **not** seed the
`aplusb` problem — the first end-to-end run against a freshly-brought-up
stack fails with `404 problem_not_found`. `scripts/seed-problem.ts` needs
`DATABASE_URL`, `JUDGE_TOKEN` (must match `judge/judge.yml`'s templated
`key` — see `.env.example`'s `JUDGE_TOKEN` and task-13-brief.md's Controller
addendum C1 — or the compose `judge` service authenticates nowhere and
retries its handshake forever), and, as of Task 13, `PACKAGE_STORE_DIR`
(where it writes the built archive's bytes — without this the `packages` row
it registers points at a blob that was never written, and the judge's later
archive fetch 404s even though the database looks fully seeded). `postgres`
has no host port mapping (see "Local development" above), so run this as a
one-off container on the Compose network, reusing the already-built
`migrate` image rather than building a new one, and mounting the *same*
named volume `api`'s `PACKAGE_STORE_DIR` uses so both containers see the
same bytes:

    podman run --rm --network <project>_default --env-file .env \
      -v <project>_package_store:/var/lib/qhhoj/packages \
      -e PACKAGE_STORE_DIR=/var/lib/qhhoj/packages \
      localhost/<project>_migrate:latest \
      sh -c 'DATABASE_URL="postgres://qhhoj:$POSTGRES_PASSWORD@postgres:5432/qhhoj" packages/db/node_modules/.bin/tsx scripts/seed-problem.ts'

`--env-file .env` is what carries `JUDGE_TOKEN` into the container — make
sure it's set in `.env` (copied from `.env.example`), not just exported in
your shell. (`<project>` is the Compose project name, e.g. `phase-1-skeleton`
— check `podman network ls` / `podman-compose ps` if unsure.) This only needs
to run once per fresh `pgdata` volume; the script is idempotent
(`onConflictDoNothing` throughout, and the package/judge-node rows it
registers are the same across runs — and the archive write is a plain
overwrite of deterministic bytes, so re-running it is never harmful).

**Upgrading an existing Phase 1 `pgdata` volume:** that volume's
`problem_revisions` row still holds the literal `package_hash =
'phase1-aplusb'` Phase 1 shipped, which satisfies no row in `packages` —
and, as of Task 12, `problem_revisions.package_hash` has a foreign key to
`packages.hash` (migration `0004_tiny_professor_monster.sql`). Drizzle's
Postgres migrator runs every pending migration inside **one transaction**
(`pg-core/dialect.js`'s `migrate()`), so `migrate` cannot partially land —
it's all pending migrations or none.

- **If the volume is already at migration `0003`** (has `packages` and
  `package_files` — i.e. it was already redeployed at some commit between
  `a8e7e05` and this task's), the case actually verified above applies
  directly: run the new `scripts/seed-problem.ts` against it *before*
  running `migrate`, so it repoints `phase1-aplusb` first; only then does
  `0004` find a database it can apply to.
- **If the volume genuinely predates `0003`** (a true original Phase 1
  skeleton, never redeployed since): **recreate it, don't upgrade it.**
  Remove the Phase 1 `pgdata` volume and re-run `scripts/compose-up.sh`
  against an empty one — `migrate` then applies every migration including
  `0004` from scratch (no pre-existing `phase1-aplusb` row to conflict
  with), and the seed populates a real package from clean. This destroys
  whatever was in that volume. That's fine by design here: this project's
  data does not need to survive a Phase 1-era dev volume — the data that
  eventually matters lives on a remote server and is migrated there later,
  separately, so a local Phase 1 volume is disposable, not something to
  carry forward by hand.

Either way this is not automated (migrations are forward-only and
generated, not hand-edited): it takes an operator either seeding before
migrating (already-at-`0003` case) or discarding and recreating the volume
(pre-`0003` case), once, by hand, per pre-existing volume.

### Running the script

    corepack pnpm exec tsx scripts/e2e-submit.ts

It registers a throwaway user, submits three fixed C++ sources against
`aplusb` (correct, wrong, and uncompilable) against `https://localhost:8443`
by default (`E2E_BASE_URL` overrides), and asserts verdict *and* points on
each. It exits non-zero and prints a `FAILED:` list if anything doesn't
match — see task-15-report.md for a real run's output.

### The `IE`-for-compile-error wart — expected, not a bug to chase

`EventWriter` (`apps/judged/src/event-writer.ts`) writes `verdict: 'IE'` for
every `compileError` event, because `case_verdict`
(`packages/db/src/schema/guarded.ts`) has no `CE` member — a per-case verdict
can never be `CE`, and the enum is shared between submission-level outcomes
and case verdicts. So an ordinary syntax error comes back labelled an
*internal* error, which reads as "our judge broke" rather than "your code
doesn't compile." This is a real modelling defect, confirmed, and
**deliberately left alone**: the correct fix is separating submission-level
outcomes from case verdicts, which is Phase 2 data-model work, not a Phase 1
patch. `scripts/e2e-submit.ts` does not assert `verdict === 'CE'`; it
distinguishes a compile failure solely by `compileOutput` being non-empty.
If you see `IE` on a submission whose `compileOutput` clearly shows a syntax
error, this is why — check `compileOutput` before assuming the judge itself
is broken.

### Diagnosing a submission stuck in `queued`/`compiling`

A worker is never "dead", only "out of lease" — `apps/judged/src/worker.ts`
renews (`heartbeat`s) the lease on `grading_jobs` every 20s while a job is in
flight, and a job whose lease has lapsed is eligible for another worker to
reclaim. Check, in order:

1. **`grading_jobs.state` and `lease_until` vs. `now()`:**

       podman exec <project>_postgres_1 psql -U qhhoj -d qhhoj \
         -c "select id, submission_id, state, lease_until, now(), attempt from grading_jobs order by id desc limit 5;"

   `lease_until` still advancing on repeated queries means a worker is
   actively heartbeating it — it hasn't been abandoned, whatever the
   submission's own `state` says. `apps/judged/src/worker.ts`'s
   `MAX_GRADING_MS` (300s) watchdog eventually rejects a job that never
   reaches a terminal driver event, logs `job failed`, and lets it re-lease
   on the next `attempt`.
2. **`judged` logs** (`podman logs <project>_judged_1`): look for a `job
   failed` line (which attempt, which error) and, in normal operation, the
   state transitions `EventWriter` writes as events arrive.
3. **`judge` logs** (`podman logs <project>_judge_1`): look for `Accept
   submission: <id>: executor: ..., code: ...` — its absence, with no error
   either, means the `submission-request` packet never reached the judge's
   read loop at all, which is the two-attempt incident described below.

### A real incident hit while writing this: a submission-request silently lost, twice — fixed

The first `scripts/e2e-submit.ts` run against this stack's original `judged`
process (the one Task 14 left running) hung: `correct` never left `queued`.
`grading_jobs` showed the job `leased` with `lease_until` advancing —
genuinely in flight, not abandoned — but `judge`'s logs never showed an
`Accept submission` line, nor any error. The connection had been established
long before (handshake logged clean) and stayed up through the whole
dispatch window with no reconnect in between, by `judge`'s own logs. After
`worker.ts`'s 300s watchdog rejected attempt 1 (`job failed: grading
exceeded 300000ms`), the job re-leased as attempt 2 on the *same*
long-lived `judged` process — and was lost the same way, again with no
error on either side.

**Root cause not established.** Temporary debug logging was added to
`BridgeServer.broadcast`/`accept` (then reverted — see the diff-free
`apps/judged` in this commit) to check `this.connections.size` at dispatch
time, but by the time that was in place, `podman stop`/`rm` had already been
used to recreate the `judged` container for an unrelated reason, destroying
the original process's state before it could be inspected mid-failure. Under
the rebuilt process, two immediate fresh submissions and the re-leased
attempt 3 of the original stuck job all dispatched and graded correctly on
the first try (`Accept submission` logged within ~1s each time), and stayed
reliable across everything else run for this task. So this was not
reproduced against a fresh process — only against whatever state the
original long-lived one had accumulated.

One suspicious, independently-confirmed fact worth recording even though it
wasn't tied conclusively to the incident above: `judge`'s own client
(`/judge/dmoj/packet.py`) sets a 300-second socket read timeout
(`self.conn.settimeout(300)`) and reconnects whenever that fires with no
data received — confirmed by `judge`'s logs showing `Attempting
reconnection` at almost exactly 300s intervals while idle. Real DMOJ's
protocol has a `ping`/`ping-response` packet pair for exactly this (both
directions are defined in `packages/judge-protocol/src/dmoj-packets.ts`),
but at the time nothing in `BridgeServer` or `DmojDriver` ever sent a
`ping` — the bridge never proactively kept the connection warm. That
reconnect cycle was real and reproducible; whether it, or something else,
caused the original two lost dispatches was never proven at the time (Task
15 deliberately reported it without patching an unconfirmed cause). The
self-healing path (watchdog → re-lease → next attempt succeeds) worked
exactly as designed in the meantime and is what actually recovered the
stuck submission on that run.

**Fixed since, whether or not it was the root cause of the original
incident:** `BridgeServer` now pings every judge connection on an interval
(`PING_INTERVAL_MS`, 30s in production — well under the judge's 300s read
timeout) and tracks the last time each connection produced *any* inbound
packet. A connection silent for several missed intervals is presumed dead
(the judge has already reconnected on a fresh socket) and is closed and
dropped from `this.connections`, so `broadcast()` can no longer write
dispatches into a socket nobody on the other end is reading. Covered by two
tests in `apps/judged/test/dmoj-driver.spec.ts` (`sends periodic ping frames
to a connected judge on the configured interval`, `drops a judge connection
that stops answering, and no longer broadcasts to it`) using an injected
short interval, and by two live end-to-end runs against the real containerized
judge after the fix (both `AC 3/3`, `WA 1/3`, `IE` with real compiler output
— no hangs). The real 300s-idle boundary against a live judge container was
**not** separately re-exercised in this session — the injected-short-interval
unit tests plus the live e2e passes were judged sufficient evidence; if a
stuck-dispatch incident recurs, re-check this fix first before assuming a new
cause.

### The live-update path (`/ws`) was broken through Caddy — fixed

Step 3 of task-15-brief.md asks for the WebSocket verdict-panel path to be
checked by hand in a browser; no browser was available in this environment,
so the authorized fallback (per the brief's Controller addendum, F7) was
used instead: open `wss://.../ws` with the session cookie, subscribe to a
submission, and confirm push frames arrive and correspond to real state
transitions.

The first attempt, against `wss://localhost:8443/ws` (the real path a
browser uses, through Caddy), failed immediately with `Unexpected server
response: 200` — not a WebSocket upgrade at all. The `Caddyfile` had no
route for `/ws`; it fell through to the SPA catch-all
(`try_files {path} /index.html`), which happily answers any unmatched path
with `index.html` and a 200. A direct check against the `api` container's
own port 3000 (bypassing Caddy entirely) worked correctly — 7 push frames
for one submission, each followed by a re-fetch showing genuine progression
(`queued` → `compiling` → `compiling` → `done`/`AC`) — proving the API's
`SubmissionsGateway` itself was never the problem. **Every real browser
reaches the API only through Caddy**, so this was a live defect in the
walking skeleton's actual live-update path, not a theoretical one.

Fixed by adding a `handle /ws { reverse_proxy api:3000 }` block to the
`Caddyfile`, alongside the existing `/api/*` and probe handles — Caddy's
`reverse_proxy` handles the WebSocket upgrade natively, no extra directives
needed. **Caveat when editing the `Caddyfile` while the stack is up:** it is
bind-mounted into the `caddy` container as a single file; if the edit
replaces the file's inode (as a normal file write typically does) rather
than writing in place, the running container keeps serving the *old*
content — `podman exec <project>_caddy_1 cat /etc/caddy/Caddyfile` will show
you which. Confirmed exactly that: `caddy validate` against the host file
passed, but the mounted copy inside the container was still the pre-edit
version until the container was recreated the same way as `judged` above
(`podman stop`/`rm` + `podman-compose up -d --no-deps caddy`). After that,
the same check through `wss://localhost:8443/ws` succeeded: 7 push frames,
real `queued` → `compiling` → `done`/`AC` progression, matching the direct
check exactly.

### Rebuilding and recreating a single service without touching the rest

`podman-compose up -d --no-deps <service>` does **not** reliably pick up a
freshly-built image if the container is still running — `podman-compose ps`
kept showing the old container ID and age after a `build` + `up -d
--no-deps`. What worked, for both `judged` (after code changes) and `caddy`
(after the `Caddyfile` edit above):

    podman-compose build <service>          # only if the image needs rebuilding
    podman stop <project>_<service>_1
    podman rm <project>_<service>_1
    podman-compose up -d --no-deps <service>

This does not touch `postgres`, `redis`, `api`, `migrate`, or the other
running services — it is safe mid-session and does not require tearing down
the stack or going through `scripts/compose-up.sh` again (that script's
migration-ordering guarantee is irrelevant to recreating a single already-
migrated-against service).
