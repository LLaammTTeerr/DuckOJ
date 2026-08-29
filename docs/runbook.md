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
    podman run -d --name duckoj-pg -p 5432:5432 \
      -e POSTGRES_USER=duckoj -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=duckoj \
      postgres:16-alpine
    # (substitute `docker run` on a Docker-equipped machine)

    export DATABASE_URL=postgres://duckoj:dev@localhost:5432/duckoj
    corepack pnpm --filter @duckoj/db migrate
    export TOTP_ENC_KEY=$(openssl rand -hex 32)
    export PUBLIC_ORIGIN=http://localhost:5173
    corepack pnpm --filter @duckoj/api dev
    corepack pnpm --filter @duckoj/web dev

`@duckoj/db`'s `migrate` script and `@duckoj/api`'s `dev` script are already defined
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

`apps/api/src/**` may not import `@duckoj/db/guarded` outside `authz/**`
(ESLint's `no-restricted-imports`, scoped to `files: ['apps/api/src/**/*.ts']`
in `eslint.config.js`), because guarded tables are visibility-filtered and
only `authz/**` is allowed to decide who sees what. `apps/judged/src/event-writer.ts`
imports `@duckoj/db/guarded` directly (`submissions`, `submissionCases`) and
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

### Three known, deliberate warts — two since closed

All three were deferred on purpose at Phase 1, not overlooked. Two have since
been fixed; both entries stay below, corrected in place, because a stale
"expected, not a bug" note is worse than no note at all — see the `CE` section
later in this document for exactly that lesson, learned the hard way.

1. ~~**A compile error is reported as verdict `IE`, not `CE`.** `case_verdict`
   has no `CE` member, so a compile failure writes `IE`.~~ **Fixed in Phase
   2b:** migration `0005` added `CE` to `case_verdict` and `EventWriter` now
   writes it on a `compileError` event. See "A compile error is `CE`" below
   for the full story, including why the old wording was actively dangerous
   to leave standing.
2. ~~**The bridge does not verify the judge key.** `BridgeServer.accept`
   (`apps/judged/src/drivers/dmoj/bridge-server.ts`) replies
   `handshake-success` unconditionally on any `handshake` packet — the `key`
   configured in `judge/judge.yml` is decorative, nothing on the bridge side
   ever checks it.~~ **Closed in Phase 2a:** every judge now presents a real
   `(name, token)` credential at the handshake, checked against `judge_nodes`,
   fails closed. See "Judges now authenticate" further down (in "End-to-end
   acceptance against the real judge") for how a wrong token actually
   surfaces — it looks like a network problem and is not one. Network
   isolation (`judged`'s bridge port is never published to the host) is now
   defense in depth rather than the only control, and should stay that way
   regardless.
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
`TokensController` and `TotpController` carry it at class level, and so does
`AdminUsersController` (Phase 2b) — minting an admin is a strictly stronger
case of "rewrites the credentials that govern it" than anything the first two
guard, and Task 10 shipped without this guard at first: a scoped access token
could `PATCH /admin/users/:username` and grant itself `admin`, which meant a
leaked token became a permanent admin-minting capability surviving its own
revocation. Caught in review before merge, not after. Add the guard to
anything that mints, revokes or rewrites a credential, or grants a privilege
that can be used to do so: without it, a leaked personal access token can
disable its owner's TOTP (`POST /auth/totp/begin` upserts a new secret with
`confirmedAt: null`) and mint its own replacements, so revoking the leaked
token stops ending the compromise. This is *not* step-up re-authentication and
it does not check `scopes` — `Actor.scopes` is still read by nothing, and what
it should mean is a decision nobody has made yet.

## Adding a database table

1. Add it to `packages/db/src/schema/identity.ts` (or another non-guarded schema
   file re-exported from `schema/index.ts`), or to `schema/guarded.ts` if reads
   must be visibility-filtered through `apps/api/src/authz/**` rather than queried
   directly.
2. From the repo root:
   `corepack pnpm --filter @duckoj/db exec drizzle-kit generate --name <change>`
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

    corepack pnpm --filter @duckoj/contracts openapi
    corepack pnpm --filter @duckoj/sdk exec openapi-typescript ../../openapi.json -o src/generated.ts

This writes `openapi.json` (repo root) and `packages/sdk/src/generated.ts`. CI's
"Verify OpenAPI and SDK are up to date" step runs the same two commands and then
`git diff --exit-code -- openapi.json packages/sdk/src/generated.ts` — a
forgotten regeneration fails CI, not just a lint pass locally.

## The API docs viewer — `/api/v1/docs`

The committed `openapi.json` above is a **build artifact**, feeding SDK
generation, and it can drift from what the running API actually registered
between a code change and the next `pnpm --filter @duckoj/contracts openapi`.
`apps/api/src/docs/docs.controller.ts` serves a second copy of the document
that cannot drift from itself, because it calls `openApiDocument()` fresh on
every request rather than reading a file: `GET /api/v1/openapi.json`. A
vendored viewer for it — [Scalar](https://github.com/scalar/scalar)'s
standalone bundle, shipped from `apps/api/assets/vendor/`, not pulled from a
CDN, because the Compose stack has no guaranteed outbound network and a docs
page that silently fails to load offline is worse than no docs page — is
served alongside at `GET /api/v1/docs`. Both routes are `@Public()`: gating
the one place a new integrator learns the API behind a session they don't
have yet would defeat the point.

**Both live under the API's own `/api/v1` prefix, deliberately, not at the
root.** The `Caddyfile` proxies `/api/*`, `/ws`, and the two health probes to
the API; everything else falls through to the SPA's catch-all
(`try_files {path} /index.html`), which answers any unmatched path with
`index.html` and a `200`. A document served at a bare root `/openapi.json`
would therefore not 404 — it would silently serve the web app's markup as if
it were the OpenAPI document, verified directly against the running stack:

    $ curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/openapi.json
    200
    $ curl -sk https://localhost:8443/openapi.json | head -c 60
    <!doctype html><html lang="vi"><head><meta charset="utf-8"

That is a worse failure than the `/ws` bug this project already paid for once
(see "The live-update path (`/ws`) was broken through Caddy" below): a `200`
carrying the wrong body looks like success, and the first symptom would be a
docs viewer that renders nothing with no error anywhere. Serving both routes
inside the existing `/api/v1` prefix means the Caddyfile's `handle /api/*`
block already routes them correctly with no edit needed — one less place for
two configs to disagree. This is also why `openApiDocument()`
(`packages/contracts/src/registry.ts`) derives its `servers` entry from
`` `/${API_PREFIX}` `` rather than a bare `api/v1`: a *relative* server URL
resolves against the location the document was served from, and a bare prefix
served from `/api/v1/openapi.json` would send every "try it" request in the
viewer to `/api/v1/api/v1/...`.

## Reading a guarded table

`@duckoj/db/guarded` may only be imported from `apps/api/src/authz/**`; ESLint's
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

The web bundle imports `@duckoj/sdk`, which is a workspace package with no
prebuilt `dist/` checked in — build it (or run the repo-wide typecheck, which
also emits it via `tsc -b`) before building the web bundle, or Vite fails with
`Failed to resolve entry for package "@duckoj/sdk"`:

    corepack pnpm --filter @duckoj/sdk typecheck
    corepack pnpm --filter @duckoj/web exec vite build

**Caddy bind-mounts `./apps/web/dist`.** If you skip the `vite build` step, Caddy
starts fine but serves nothing (an empty or missing directory) — build the SPA
before bringing the stack up, not after.

`podman-compose` needs a `.env` (copy `.env.example` and set real secrets):

    cp .env.example .env
    sed -i "s/^TOTP_ENC_KEY=.*/TOTP_ENC_KEY=$(openssl rand -hex 32)/" .env
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env

### Bootstrapping the first admin

`PATCH /admin/users/:username` (Task 10) lets an existing admin grant
`setter` or `admin` to another user, but it is admin-only — enforced inside
`AdminUsersService`, not by the route decorator — so it has no path to
create the *first* admin on a fresh database. `scripts/seed-problem.ts`'s
locked `system` account is not usable for this either: it gets no explicit
`globalRole` on insert, so it defaults to plain `user` like any other row
(it exists to attribute seeded problems, not to hold privilege, and its
`passwordHash: '!'` makes it unloggable by construction regardless).

Use `scripts/bootstrap-admin.ts`, against `DATABASE_URL`:

    DATABASE_URL=postgres://duckoj:...@localhost:5432/duckoj \
      corepack pnpm bootstrap:admin yourname --email you@example.com

    # created yourname <you@example.com> as global_role=admin, email verified
    # generated password: 3Qk1r_9xW2vJ8pLc0aTnZbYs
    # This is printed once. Store it now — nothing can recover it later.

It creates the account if it does not exist — hashing the password through
`apps/api/src/authn/password.hash.ts`, the same argon2id parameters
`POST /auth/register` uses, and marking the address verified so a fresh
install with no SMTP server configured is not locked out — and **only
promotes** if it does, leaving that account's password and address alone.
Pass `--password` to choose one (at least 10 characters, matching the
`Password` contract); omit it and one is generated and printed once, as
above. `--email` defaults to `<username>@bootstrap.local`, which the admin
can change from their own profile afterwards.

`postgres` publishes no host port under compose (see "Local development"), so
against a running stack this runs as a one-off container the same way the
seed script does:

    podman run --rm --network <project>_default --env-file .env \
      localhost/<project>_migrate:latest \
      sh -c 'DATABASE_URL="postgres://duckoj:$POSTGRES_PASSWORD@postgres:5432/duckoj" \
             packages/db/node_modules/.bin/tsx scripts/bootstrap-admin.ts yourname'

From then on, that admin can grant `setter` (or further `admin`) to anyone
else through `PATCH /admin/users/:username` — this one bootstrap step only
has to happen once per database.

**Recovery fallback.** If the script cannot be run at all — no worktree on
the host, no image to run it from, only a `psql` prompt — the single
statement it replaces still works, and remains the documented last resort
for an account that already exists:

    UPDATE users SET global_role = 'admin' WHERE lower(username) = lower('yourname');

This is also the recovery path if every admin is ever demoted out of the
role. `AdminUsersService` refuses to let an admin demote *themselves*
(`admin_self_demotion`), which blocks the realistic accident, but it does not
close the exotic case of two admins demoting each other in a race — see the
comment in `admin-users.service.ts` for why that race is left unclosed. If a
database is ever somehow left with zero admins, either `bootstrap:admin` on
the existing username or the `UPDATE` above is the way back in.

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

What the script does, in order, as of Phase 2b (it grew a redis dependency and
two more services since this section was first written — read the current
`scripts/compose-up.sh`, not just this summary, if the two ever disagree):
`podman-compose build`; `up -d postgres redis`; poll both healthy; `up migrate`
in the foreground (bounded by `MIGRATE_TIMEOUT`, blocking until it exits) and
check its container's real exit code, not just podman-compose's own return
code; `up -d --no-deps --force-recreate api judged caddy`; poll `api` then
`judged` healthy; `up -d --no-deps --force-recreate judge` (started only after
`judged` is confirmed healthy, purely so the bring-up log shows a clean
first-attempt handshake rather than a retry backoff); poll `judge` healthy.
`--no-deps` is required on every one of those `up` calls — without it,
podman-compose restarts `migrate` as part of bringing a dependent service up
and reintroduces the race, even though migrations already applied cleanly.
(Re-running `migrate` itself is harmless — drizzle's migrator is idempotent,
confirmed by the "already exists, skipping" Postgres notices on a second run
— the danger is only a dependent service starting before that repeat run
finishes.)

**`--force-recreate` is load-bearing, not belt-and-braces — fixed at `f0c72e5`
after it bit a real run.** `podman-compose up -d --no-deps` under
podman-compose 1.5 *starts* a stopped container but does **not** recreate a
running one whose image has changed. Before this fix, re-running
`compose-up.sh` after `podman-compose build` picked up new source left the old
container running the old image — and the script's own `wait_healthy` then
polled *that* container's still-green healthcheck and reported success. Found
during Task 7b, when a freshly built `/api/v1/docs` route kept 404ing from a
container the script had just called healthy: the script did not fail, it
lied, and every check made after it was against the wrong binary — the exact
same hazard class as the "stale image silently seeds the wrong thing" entry
below, this time living in the bring-up script itself rather than a one-off
`podman run`. An operator who hit this before the fix had no signal to go on:
`compose-up.sh` exited 0, `podman-compose ps` showed the service "running,"
and the only symptom was a change that provably shipped behaving as if it
had not. If a rebuild ever again seems to have no effect, confirm the
container's actual age (`podman inspect <cid> --format '{{.State.StartedAt}}'`)
before doubting the change itself.

`--no-deps` on the `api`/`judged`/`caddy` step also removes `caddy`'s own
`depends_on: api: service_healthy` gate, since it's the same flag applied to
the same command — which is exactly why the script polls `api` itself before
moving on, restoring that guarantee instead of leaving it to the (broken,
under podman-compose) `depends_on`.

Override `COMPOSE`, `POSTGRES_TIMEOUT`, `REDIS_TIMEOUT`, `API_TIMEOUT`,
`JUDGED_TIMEOUT`, `JUDGE_TIMEOUT`, or `MIGRATE_TIMEOUT` (seconds) as
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
  the real `password authentication failed for user "duckoj"` error from
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
      -v <project>_package_store:/var/lib/duckoj/packages \
      -e PACKAGE_STORE_DIR=/var/lib/duckoj/packages \
      localhost/<project>_migrate:latest \
      sh -c 'DATABASE_URL="postgres://duckoj:$POSTGRES_PASSWORD@postgres:5432/duckoj" packages/db/node_modules/.bin/tsx scripts/seed-problem.ts'

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
`aplusb` (correct, wrong, and uncompilable) plus a correct solution against
`hello` (Task 14's second problem, seeded separately — see below) against
`https://localhost:8443` by default (`E2E_BASE_URL` overrides), and asserts
verdict *and* points on each. It exits non-zero and prints a `FAILED:` list
if anything doesn't match — see task-15-report.md for a real run's output of
the original three-path version.

### A second problem: building, uploading, and diagnosing a package

`problems/hello/` (`task-14-brief.md`) is the second problem this stack
grades — read a name, print `Hello, <name>!`, genuinely different from
`aplusb`'s arithmetic, not a copy of it. It exists to prove the package
pipeline *fetches* a problem the judge has never seen, not just that the one
problem the stack was built around still grades.

**Building and uploading a package.**

    corepack pnpm run package:build problems/hello /tmp/hello.tar.zst

`scripts/package-build.ts` packs a problem directory (`packDirectory` in
`packages/package-format`) into a deterministic, zstd-compressed tar and
prints `{ hash, files, bytes }`. On its own this does not register anything
— it is a standalone CLI, useful for inspecting a build or for uploading
through the real HTTP endpoint directly: `POST /api/v1/packages?hash=<hash>`
with the raw archive bytes as the body, callable by any authenticated
session. `PackagesService.upload` re-derives the hash from the files it
actually unpacks and rejects a mismatch, so a stale or hand-edited archive
is caught there, not silently accepted.

The one-off seed script does both build and upload in a single step, plus
the database rows a raw upload alone does not create (`problems`,
`problem_revisions`) — this is what actually seeded `hello` against the
running stack:

    podman run --rm --network <project>_default --env-file .env \
      -v <project>_package_store:/var/lib/duckoj/packages \
      -e PACKAGE_STORE_DIR=/var/lib/duckoj/packages \
      localhost/<project>_migrate:latest \
      sh -c 'DATABASE_URL="postgres://duckoj:$POSTGRES_PASSWORD@postgres:5432/duckoj" packages/db/node_modules/.bin/tsx scripts/seed-problem.ts hello'

Identical to "Seed the problem before submitting" above, with one added
argument: the directory name under `problems/` to seed (defaults to
`aplusb` when omitted, so every existing zero-arg invocation — including
`packages/db/test/seed-script.spec.ts`'s — is unaffected). **If you changed
`scripts/seed-problem.ts` or added a new problem directory, rebuild the
`migrate`/`api` image first** (`podman-compose build migrate`): this
one-off container runs whatever `COPY . .` baked into the image at its last
build, not the live worktree. Passing `hello` against a stale image seeds
`aplusb` again instead, silently — no error, no hint anything was ignored,
just a `problemCode: "aplusb"` in the printed summary where you expected
`"hello"`.

A problem's display name and statement (`problems/<code>.meta.json`, e.g.
`problems/hello.meta.json` — `{ code, name, statement }`) live *outside*
`problems/<code>/` deliberately; see hash stability below for why.

**What the hash means, and why it's stable.**

`packageHash` (`packages/package-format/src/hash.ts`) hashes the sorted list
of `{ path, size, sha256 }` for every file under the problem directory — not
the compressed archive's own bytes. Two independently-built archives of the
same file tree (different zstd settings, a different build machine, rebuilt
a year later) hash identically; only a file's contents, its path, or the set
of files present changes the hash. That is why `scripts/seed-problem.ts`
overwrites the store unconditionally on every run
(`scripts/lib/package-store.ts`'s `putPackageArchive` doc comment) — the
bytes it writes are always the same for the same tree — and why
`problems/aplusb/` was not touched while adding `hello`: touching it would
change the hash Task 13 already seeded
(`73d40a7e62d7019346f137048ee1f251e07cad9e4e34b8593f28a2f42f12e406`),
which would have made "the e2e result is unchanged" evidence of nothing.
It is also why `<code>.meta.json` sits *outside* the package directory: a
problem's statement is not test data a judge grades against, and editing a
typo in it must never change the hash a submission is graded against —
i.e. must never silently regrade every existing submission against what
the system would otherwise treat as a "new" problem.

**Diagnosing a package that will not materialise**, in order:

1. **judge-agent's own logs.** Its stdout is interleaved with `judged`'s
   dmoj process inside the same `judge` container (Task 13's Controller
   addendum C2: judge-agent runs alongside `dmoj judged`, not in a separate
   container):

       podman logs <project>_judge_1

   Look for the materialiser's own errors — a non-2xx fetching
   `GET /api/v1/internal/packages/<hash>/archive`, an unpack failure, or a
   hash mismatch.
2. **`/problems` on the judge.** Confirm whether the hash directory exists
   at all, and if it does, whether it's complete:

       podman exec <project>_judge_1 sh -c 'ls -la /problems/<hash>/'

   `init.yml`, `manifest.json`, and `tests/` should all be present.
   Materialisation is atomic (`apps/judge-agent/src/materializer.ts` writes
   to a temp directory and renames it into place), so a directory that
   exists but is missing pieces means something wrote outside that atomic
   path — treat it as a bug to fix, not a race to wait out.
3. **The store on the API side.** Confirms the archive bytes actually exist
   where `FilesystemPackageStore` expects them, which distinguishes "the API
   never had the bytes" from "the judge failed to fetch what the API did
   have":

       podman exec <project>_api_1 sh -c 'ls -la /var/lib/duckoj/packages/<hash prefix>/<hash>'

   (shard directory is the hash's first two hex characters) or, without a
   container shell, `GET /api/v1/packages/<hash>` (any authenticated
   session) returns the DB-recorded `sizeBytes`/`fileCount` — a `404
   package_not_found` here means the `packages` row was never inserted at
   all (a seed run against the wrong `PACKAGE_STORE_DIR`, or against a
   different `DATABASE_URL`, than the one the running stack actually uses).

**Judges now authenticate — a wrong token looks exactly like a network
problem, and is not.** Every judge presents `JUDGE_TOKEN`
(task-13-brief.md's Controller addendum C1) at two points that must both
agree with the `judge_nodes` row `scripts/seed-problem.ts` writes: `judged`'s
bridge handshake, and judge-agent's archive fetch from the API. If the token
is wrong — a typo in `.env`, a `judge/judge.yml` rendered from a stale
environment, or a `judge_nodes` row seeded with a different token than what
`judge.yml` actually has — the handshake is rejected. `judged` logs the
rejection, by design, without the key itself:

    {"msg":"judge handshake rejected","id":"judge-1","reason":"credential rejected"}

but the judge's own client does not fail loudly and stop. Real DMOJ's
`dmoj/packet.py` (vendored inside the judge image, not code in this repo)
catches `JudgeAuthenticationFailed`, logs `Authentication as "<name>"
failed`, and reconnects with **exponential backoff — starting at 4 seconds,
capped at 60** (`packet.py`'s `_reconnect`/`_do_reconnect`, confirmed by
reading the installed source: `self.fallback = min(self.fallback * 1.5,
60)`) — forever. From the operator's side this looks exactly like a network
or DNS problem: a judge container that is up, "trying," never crashing, and
submissions that simply never leave `queued`. It is not a network problem.
Check `judged`'s logs for the `judge handshake rejected` line before
chasing connectivity theories; if it's there, the fix is aligning
`JUDGE_TOKEN` (env), `judge/judge.yml`'s rendered `key`, and the
`judge_nodes.tokenHash` row — not the network.

### A compile error is `CE` — fixed in Phase 2b, and `IE` now means `IE`

**This section previously documented the opposite, as expected behaviour.**
For all of Phase 1 and 2a, `EventWriter` (`apps/judged/src/event-writer.ts`)
wrote `verdict: 'IE'` for every `compileError` event, because `case_verdict`
(`packages/db/src/schema/guarded.ts`) had no `CE` member — so an ordinary
syntax error came back labelled an *internal* error, reading as "our judge
broke" rather than "your code doesn't compile."

Phase 2b fixed it at the data model: migration `0005` added `CE` to
`case_verdict`, and `EventWriter`'s `compileError` branch writes `CE`.
Confirmed end to end against a real judge on a fresh stack by both
`scripts/e2e-submit.ts` and `scripts/e2e-problem.ts`, which now **assert**
`verdict === 'CE'` rather than inferring a compile failure from a non-empty
`compileOutput`.

So, reading a verdict today:

- `CE` — the submission did not compile. `compileOutput` carries the
  compiler's message.
- `IE` — a genuine judge-side internal error, finishing in `state:
  'errored'`. Nothing to do with the user's code.

If a compile error ever comes back as `IE` again, that is a regression in
`event-writer.ts`, **not** an expected wart to work around. Note that
`compileOutput` on its own is still not a compile-failure flag: a
non-fatal `compileMessage` (compiler *warnings*) writes it too, on a
submission that goes on to grade normally.

### Diagnosing a submission stuck in `queued`/`compiling`

A worker is never "dead", only "out of lease" — `apps/judged/src/worker.ts`
renews (`heartbeat`s) the lease on `grading_jobs` every 20s while a job is in
flight, and a job whose lease has lapsed is eligible for another worker to
reclaim. Check, in order:

1. **`grading_jobs.state` and `lease_until` vs. `now()`:**

       podman exec <project>_postgres_1 psql -U duckoj -d duckoj \
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
judge after the fix (both `AC 3/3`, `WA 1/3`, `IE` with real compiler output —
this predates Phase 2b's `CE` fix, see "A compile error is `CE`" below — and
no hangs). The real 300s-idle boundary against a live judge container was
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

## Phase 2b: authoring a problem

The whole path from a fresh database to a public, gradeable problem, by hand,
over real HTTP against the running stack — no test harness, no script. Every
command below was run against this repo's own live Compose stack (`podman ps`
showing all five services healthy) while writing this section; actual output
is shown, trimmed where noted. `scripts/e2e-problem.ts` (below) automates this
exact sequence, plus grading a correct and an uncompilable submission at the
end — read it if you want the same thing scripted and repeatable, or to see
the role-refusal and visibility checks this walkthrough skips for brevity.

    BASE=https://localhost:8443/api/v1
    PROJECT=duckoj   # your podman-compose project name; `podman-compose ps` if unsure

**1. Register the setter's account** (whoever will actually author the
problem — see step 3 for why this is a separate account from the admin):

    curl -sk -c setter.cookies -X POST "$BASE/auth/register" \
      -H 'content-type: application/json' \
      -d '{"username":"alice","email":"alice@example.com","password":"a-long-enough-password","displayName":"Alice"}'

**2. Bootstrap the first admin with SQL.** There is no HTTP route that can
mint the *first* admin — see "Bootstrapping the first admin" above for why —
so register the admin's own account the same way, then reach into the
database directly. `postgres` publishes no host port (see "Local
development"), so this runs as a `podman exec` into the container:

    curl -sk -c admin.cookies -X POST "$BASE/auth/register" \
      -H 'content-type: application/json' \
      -d '{"username":"admin1","email":"admin1@example.com","password":"a-long-enough-password","displayName":"Admin"}'

    podman exec "${PROJECT}_postgres_1" psql -U duckoj -d duckoj -v ON_ERROR_STOP=1 \
      -c "UPDATE users SET global_role = 'admin' WHERE lower(username) = lower('admin1')"
    # UPDATE 1

*(Transcribed as it was actually run, before `scripts/bootstrap-admin.ts`
existed. Today the two steps above are one `corepack pnpm bootstrap:admin
admin1` — see "Bootstrapping the first admin"; the SQL is kept here because
this section is a record of a real run, and it remains the fallback.)*

    curl -sk -c admin.cookies -X POST "$BASE/auth/login" \
      -H 'content-type: application/json' \
      -d '{"usernameOrEmail":"admin1","password":"a-long-enough-password"}'
    # {"user":{...,"globalRole":"admin",...}}

**3. Grant `setter` through the HTTP route the bootstrap unlocks.** This is
the one-time-per-database manual step; every promotion after this one goes
through this route, run by an existing admin:

    curl -sk -b admin.cookies -X PATCH "$BASE/admin/users/alice" \
      -H 'content-type: application/json' \
      -d '{"globalRole":"setter"}'
    # {"id":13,"username":"alice","globalRole":"setter"}

    curl -sk -c setter.cookies -b setter.cookies -X POST "$BASE/auth/login" \
      -H 'content-type: application/json' \
      -d '{"usernameOrEmail":"alice","password":"a-long-enough-password"}'

**4. Create the problem, private,** as the setter. `POST /problems` needs
`setter` or `admin` standing; the response records the caller as an `author`
member of it:

    curl -sk -b setter.cookies -X POST "$BASE/problems" \
      -H 'content-type: application/json' \
      -d '{"code":"aplusb-copy","name":"A plus B (copy)","statement":"# A plus B\n\nRead a and b, print a+b.\n","visibility":"private"}'
    # {"id":6,"code":"aplusb-copy",...,"visibility":"private","hasPublishedRevision":false,
    #  "members":[{"username":"alice","role":"author"}],"orgSlugs":[]}

**5. Build a package, and upload it over HTTP.** `scripts/package-build.ts`
packs a problem directory (`packages/package-format`'s `packDirectory`) into a
deterministic, zstd-compressed archive and prints its content-addressed hash —
this repo's own `problems/aplusb/` is a ready-made directory to point it at:

    corepack pnpm run package:build problems/aplusb /tmp/aplusb.tar.zst
    # {"hash":"73d40a7e62d7019346f137048ee1f251e07cad9e4e34b8593f28a2f42f12e406","files":7,"bytes":389}

    HASH=73d40a7e62d7019346f137048ee1f251e07cad9e4e34b8593f28a2f42f12e406
    curl -sk -b setter.cookies -X POST "$BASE/packages?hash=$HASH" \
      -H 'content-type: application/octet-stream' \
      --data-binary @/tmp/aplusb.tar.zst
    # {"hash":"73d40a7e62d7019346f137048ee1f251e07cad9e4e34b8593f28a2f42f12e406"}

`PackagesService.upload` re-derives the hash from the files it actually
unpacks and rejects a mismatch (422), so a stale or hand-edited archive is
caught here, not silently accepted. Any authenticated session can upload —
uploading a package and having standing to attach it to a *problem* are
separate permissions.

**6. Attach it as a draft revision, then publish.** Attach denormalises the
package manifest's limits onto the revision row (visible immediately, no need
to open the archive again); publish archives whatever was previously
published for this problem and promotes the new one, atomically:

    curl -sk -b setter.cookies -X POST "$BASE/problems/aplusb-copy/revisions" \
      -H 'content-type: application/json' \
      -d "{\"packageHash\":\"$HASH\",\"notes\":\"first cut\"}"
    # {"version":1}

    curl -sk -b setter.cookies -X POST "$BASE/problems/aplusb-copy/revisions/1/publish"
    # {"version":1}

A submission against `aplusb-copy` would still be refused right now
(`404 problem_not_found`, not a distinct code — see
`SubmissionAccessService.create`'s comment on why): publishing a revision
makes it *gradeable*, but the problem itself is still `private`, and
visibility governs submissions the same way it governs reads.

**7. Make it public.** Any editor (author, curator, admin) can `PATCH` a
problem's visibility; the response's `hasPublishedRevision`/`testCount`/
`totalPoints` fields are now populated, read straight from the published
revision:

    curl -sk -b setter.cookies -X PATCH "$BASE/problems/aplusb-copy" \
      -H 'content-type: application/json' \
      -d '{"visibility":"public"}'
    # {..."visibility":"public","hasPublishedRevision":true,"testCount":3,"totalPoints":3,...}

From here it behaves exactly like any other public problem: it shows up in
an anonymous `GET /problems` list and detail page, and `POST /submissions`
against `aplusb-copy` grades against the revision just published.

## The problems path end to end — `scripts/e2e-problem.ts`

`scripts/e2e-submit.ts` proves the *judging* path. This proves the
**authoring** path Phase 2b added, which no unit suite can reach: role
grants, problem creation, package upload over real HTTP, revision attach,
publish, visibility change, and grading against a package that did not exist
before the run. Same shape as its sibling — real HTTP against
`https://localhost:8443`, `E2E_BASE_URL` to override, non-zero exit and a
`FAILED at step N:` line on the first thing that does not hold.

    corepack pnpm exec tsx scripts/e2e-problem.ts

**It needs the stack up and `podman` on `PATH`.** `postgres` publishes no
host port, so the one step that cannot go over HTTP — the bootstrap
`UPDATE users SET global_role = 'admin'` from "Bootstrapping the first
admin" above — runs as a `podman exec` into the postgres container, found by
the compose labels (`COMPOSE_PROJECT` overrides the project name, which
otherwise comes from the repo directory's basename, exactly as
`scripts/compose-up.sh` derives it).

What each run does, in order — all names and the problem code carry a
`Date.now()` nonce, so the script is safe to run repeatedly against the same
database:

1. Registers three users: an admin-to-be, a setter-to-be, and a plain
   viewer.
2. Promotes the first with the **bootstrap SQL** — the documented manual
   step that had no test running it anywhere.
3. Promotes the second with **`PATCH /admin/users/:username`**, the route
   the first promotion unlocks. Both promotion paths, one run.
4. Checks the plain viewer is refused `POST /problems` (403
   `problem_forbidden`) — so step 3 is what unlocks step 5, not
   permissiveness.
5. Creates a **private** problem as the setter.
6. Checks the viewer gets **404 `problem_not_found`**, not 403, for it.
7. Builds a per-run package (a temp directory whose test data carries the
   nonce, so its hash is one the stack has never seen) and uploads it
   through `POST /packages`.
8. Attaches it (`POST /problems/:code/revisions`) and asserts the
   **denormalised** revision metadata — `timeMs`, `memoryKb`, `testCount`,
   `totalPoints`, `checkerKind` — matches the manifest. The fixture uses
   limits deliberately unlike `aplusb`'s (2000ms/128MiB, four tests worth
   1+2+3+4) so a stale row cannot pass by coincidence.
9. Checks a **draft** revision is not gradeable, not even for its author
   (404 `problem_not_found` — see `SubmissionAccessService.create`'s comment
   on why that, and not a distinct code).
10. Publishes it, then `PATCH`es the problem to `public`, then checks an
    **anonymous** caller now sees it in both the list and the detail.
11. Submits a correct solution as the plain viewer and asserts `AC 10/10`
    — against a package that reached the judge only because it was uploaded
    over HTTP this run.
12. Submits uncompilable source and asserts the verdict is **`CE`**.

## What Phase 2b's acceptance run found — two defects a green suite could not see

Both were in `apps/web/src/routes/submit.tsx`, both invisible to 391 passing
tests, and both found by browsing the live stack rather than by reasoning
about the code. They are fixed, with tests; recorded here because the
*shape* recurs.

**1. "Submit a solution" submitted against the wrong problem.** Task 11's
problem page links to `/submit?problem=<code>` for every problem, but
`SubmitPage` still carried Phase 1's hardcoded `const PROBLEM_CODE =
'aplusb'` and never read the URL. Clicking Submit on `hello` — or on
anything authored through the new forms — produced a perfectly valid
submission against `aplusb`. Nothing failed anywhere: the API was asked for
a real problem and answered correctly, and every test in `apps/web/test`
renders `SubmitForm`/`VerdictPanel` directly, so no test has ever read the
page's URL. Fixed by `problemCodeFromSearch`, which reads `?problem=` and
falls back to `aplusb`.

**2. The compile-error wording became unreachable.** `VerdictPanel` decided
"Compile error" with `state === 'done' && verdict === 'IE' &&
compileOutput` — correct before Task 9 changed the mapping to `CE`, and
impossible to satisfy after it. A compile error rendered as a bare `CE`
instead. No test covered the branch at all, so nothing noticed when it went
dead. Fixed to key off `verdict === 'CE'`.

The pattern behind both: **a change on one side of a seam, with the other
side's only tests below the seam.** Task 9 changed a verdict the web decides
wording from; Task 11 added a link the web never taught the target to read.
Neither is detectable without either an integration test that spans the seam
or someone loading the page.

### How the web was verified, and what was not verified

There is no browser on the development machine and none was installed. The
SPA was checked by fetching every route through Caddy (all served
`index.html`, so deep links work — the `/ws` bug's shape has not recurred),
fetching every asset `index.html` and the built CSS reference (all 200,
including all 59 KaTeX font files), and then **executing the real,
Caddy-served bundle in jsdom against the live stack** to confirm each page
actually loads its data rather than merely returning HTML: `/problems`
listed all three seeded problems with correct deep-link hrefs,
`/problems/:code` rendered its statement with three KaTeX nodes for `$a$`,
`$b$` and `$a + b$`, `/problems/new` rendered the create form, and
`/problems/:code/edit` and `/problems/:code/revisions` rendered real data
for a signed-in author (and the API's own 404 for an anonymous one).

What that does **not** cover: real layout, CSS as a browser applies it,
fonts as a browser renders them, and any behaviour that depends on a real
event loop or user input. A jsdom run proves the data path, not the visual
one.

## Known issues carried into Phase 3

Six things worth a new maintainer's attention: two residual risks from
Phase 2a's Docker/deploy work (one of them since substantially closed, not
just carried), and four found during Phase 2b itself. Recorded here so none
of them are lost or, worse, silently believed fixed when they are not.

### The Dockerfile COPY manifest is hand-maintained, but no longer silent

**This section previously said nothing catches a missing `COPY` line.**
That stopped being true between Phase 2a and Phase 2b:
`apps/api/test/dockerfile-manifest.spec.ts` (commit `5b7865b`) now derives
each Dockerfile's required `COPY <pkg>/package.json` lines from the real
workspace dependency graph (`pnpm-workspace.yaml` plus every `package.json`'s
`workspace:` edges) and asserts every line is present — Global Constraint 8
of Phase 2b's spec required it stay green, and it did throughout. A package
left off the list now fails `pnpm -r test`, not just a real image build.

**What's still true:** the `COPY` lines themselves are still **hand-written**
— the test verifies completeness, it does not generate the list or glob the
directory. Adding a workspace package still means remembering to add its
`COPY` line by hand; the difference Phase 2a-era failures didn't have is that
forgetting it now fails loudly in the same `pnpm -r test` run that a
green-suite-but-broken-build symptom used to survive completely. This had
already caused the exact silent-build-break symptom twice (Phase 1, fixed in
`0d5e326`; Phase 2a's Task 13, fixed in `df56c95`) before the test existed. If
a third instance ever reaches an actual image build rather than failing this
test, that is itself a bug in the test, not a gap it was never meant to cover.

### A stale image silently seeds the wrong thing

**Symptom:** you edit `scripts/seed-problem.ts` (or any script the seed
step runs), re-run the seed against the running stack, and it silently
re-runs the **previous** version of the script — no error, no warning, just
the old behaviour. This happened in Task 14: editing the seed script to
seed `hello` and re-running it re-seeded `aplusb` instead, with nothing on
screen to say so.

**Cause:** the `migrate`/`api` image is built as a `COPY . .` snapshot of
the repo at build time. Editing a script on the host does not touch the
running container's filesystem — it is still running whatever was baked in
at the last `podman-compose build`.

**Fix:** rebuild and force-recreate before re-running anything that depends
on a script or source change reaching a container:

    podman-compose build <service>
    podman stop <project>_<service>_1
    podman rm <project>_<service>_1
    podman-compose up -d --no-deps <service>

(the same sequence documented above for `judged`/`caddy`). If a seed or
migration step ran and did something unexpected, check the image's build
timestamp against your last edit before chasing the script's logic — the
script may be correct and simply not the one that ran.

This is the same hazard class as `scripts/compose-up.sh`'s own stale-image bug
fixed at `f0c72e5` (see "Bringing the stack up under podman-compose" above) —
a container that keeps running old code after a rebuild, with nothing
distinguishing it on the surface from the fresh one. That fix covers `api`,
`judged`, `caddy`, and `judge`, the services `compose-up.sh` itself manages.
It does **not** cover this one-off `podman run` seed invocation, which sits
outside the script entirely — hence this entry stays open.

### `dist/`-resolution can make a mutation test lie mid-session

**Symptom:** you deliberately break `src/` to confirm a test fails (a
mutation check — see Global Constraint 7), the test passes anyway, and you
conclude the test cannot fail — when actually `apps/api` resolved the
workspace package you edited through its already-built `dist/`, not the
`src/` you just changed.

**Cause:** `pretest` hooks (Global Constraint 8) guarantee every package is
freshly built before *its own* `test` script runs, but they do nothing for a
manual, mid-session check against a `dist/` built earlier in the same
session — which is precisely when someone is deliberately breaking source to
watch a test fail. This has already produced a spurious pass once, in Task
7a: the implementer hand-edited `@duckoj/contracts`' source and ran a
mutation demo against `apps/api`, which resolves `@duckoj/contracts` through
its built `dist/`, not live `src/` — the demo passed spuriously against the
stale `dist/`, and was caught only because the implementer rebuilt and
re-ran before trusting it. The user caught the first instance of this exact
class, independently, before Phase 2b began.

**Not fixed.** The honest fix is a change to the mutation-checking workflow
itself — something that forces a rebuild of the mutated package before the
dependent test runs, or makes a stale `dist/` visibly detectable (a build
timestamp check, for instance) — not a code change to any one package. Until
that exists: **rebuild the workspace package you just mutated before trusting
a "this test cannot fail" conclusion**, every time, even when it feels
redundant.

### No router library is adopted, and the cost of that is now measured

`apps/web`'s five routes (`/`, `/problems`, `/problems/:code`,
`/problems/new`, `/problems/:code/edit`, `/problems/:code/revisions`) are
matched by a hand-rolled `parseRoute` against `window.location.pathname`, with
plain `<a href>` links and no History API listener. `@tanstack/react-router`
has been a declared dependency since Phase 0 and is imported by nowhere in
the codebase.

Phase 2b measured what that costs, rather than continuing to guess: taking
`parseRoute` from two routes to five required an explicit
static-before-dynamic match order (`/problems/new` must be tried before the
generic `/problems/:code` capture, or the literal segment `new` parses as a
problem code) plus three hand-written regexes. Correctness now depends on a
human reading the file top to bottom in the right order, rather than a router
resolving path specificity structurally. That is a concrete, measured cost,
not a hypothetical one, and it is the argument for adopting the already-
installed router in Phase 3 rather than continuing to hand-extend
`parseRoute`. If Phase 3 adds routes before that decision is made,
**extend `parseRoute` — do not invent a second routing mechanism
alongside it.** Two half-routers would be worse than one hand-rolled one.

### A timing side-channel in org-slug resolution, left open on purpose

`ProblemAccessService.resolveOrgIds` (`apps/api/src/authz/problem.access.ts`)
fails fast, after one query, when a named organization slug does not exist at
all — but costs a second, membership-checking query when the slug exists and
the actor simply isn't allowed to see it. In a request naming several slugs,
the query count before the first failure scales with *which* slug fails and
*why*, which is in principle enough for a very patient, very quiet attacker
to binary-search which private organization slugs exist, by timing alone.

**Left unfixed, deliberately**, for two reasons: it needs many precise timing
samples to distinguish one extra indexed Postgres query over a network, and it
is no worse than the `<resource>_not_found`-vs-403 pattern this codebase
already uses everywhere a 404 stands in for "exists but you can't see it" —
that path also costs an existence query plus a visibility load. Fixing the
org-resolution instance alone would buy nothing while the identical shape
stands in at least three other services. If timing resistance is ever wanted,
it is a project-wide decision applied consistently, not a one-file patch.

### A recurring test flake in `apps/judged` — unreproduced and unexplained

`apps/judged`'s suite has flaked three times across two phases, always
under full-workspace `pnpm -r test` parallelism, always passing in
isolation immediately after, and always on a diff touching nothing in
`apps/judged`:

1. Phase 1: `worker.spec.ts`.
2. Phase 2a, Task 6: `job-store.spec.ts`.
3. Phase 2a, Task 14: `dmoj-driver.spec.ts` (a `vi.waitFor` timing
   assertion, under heavy concurrent load).

**The count still stands at three.** Phase 2b watched for it explicitly —
Task 9's ledger entry records two full-workspace parallel runs immediately
after touching `apps/judged` (the `CE` verdict fix) with no sighting — and it
did not recur.

Testcontainer/Podman contention under full-workspace parallelism is the
leading **hypothesis** for the pattern — not a diagnosis. It has not been
reproduced deliberately, root-caused, or fixed, and **no attempt has been made
to fix it, on purpose**: a speculative fix for an unreproduced flake would
change the exact conditions under which it has appeared three times, and if
it then stopped recurring, there would be no way to tell whether it was fixed
or merely destroyed the evidence that could have diagnosed it. Leave it
alone until it can be reproduced on demand. If it recurs, the useful first
move is confirming it is this same pattern (full-workspace run, fails once,
green in isolation, unrelated diff) rather than a real regression, and — if
it needs a real fix eventually — explicit per-test timeouts rather than
inherited defaults is the direction Phase 1's notes already point at, though
that has not been tried.

## Statement PDFs (optional)

`GET /problems/:code/statement.pdf` renders the statement with
[typst](https://typst.app). It is **off by default** — the route answers
501 until the `api` process has `TYPST_BIN` pointing at a typst binary
(v0.15 verified). To enable under compose, add the binary to
`apps/api/Dockerfile` (a ~15 MB musl download from typst's GitHub
releases) and set `TYPST_BIN` in the `api` service environment.

Statements containing math additionally fetch the `mitex` package from
`packages.typst.org` on the machine's **first** math compile (cached in
`~/.cache/typst` afterwards); a mathless statement never touches the
network. If the deployment is fully offline, pre-seed that cache or
accept a 500 on math statements.
