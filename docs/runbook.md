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

**`PUBLIC_ORIGIN` + `WS_EXTRA_ORIGINS` is a security boundary, not just a CORS
setting.** The two together are the browser-origin allow-list, and it now gates
**three** things: CORS, the WebSocket upgrade (D70), and — since D82 — every
cookie-authenticated `POST`/`PATCH`/`DELETE`, which is refused `403 csrf_origin`
if its `Origin` (or `Referer`) is not on the list, or if it sends neither. So:

- A browser client served from an origin that is not on this list can read the
  API but cannot write to it. If a new front end, a staging host or a tunnel
  starts getting 403s on every save, this list is the first thing to check.
- **Anything scripted that carries a session cookie must send `Origin`
  itself** — Node's `fetch` and Playwright's `context.request` send none. The
  three `scripts/e2e-*.ts` do this, naming `E2E_BASE_URL`'s origin, so
  `E2E_BASE_URL` has to be a value on this list (on this host,
  `http://localhost:8080` — one of the two entries `WS_EXTRA_ORIGINS` carries;
  see the `vite preview` note below for the other).
- Anything using a **bearer token** — `oj`, the judge agent, CI — is
  unaffected and needs no origin.
- **Vetting a candidate bundle before you deploy it** (D150). Caddy serves
  `apps/web/dist` by bind mount, so a `vite build` in the main clone IS the
  deploy; the way to run the browser suites against code you have not shipped
  is `vite preview`, which serves the candidate on `:4321` and proxies `/api`
  to the composed stack. That origin has to be on this list too, or the
  candidate cannot even sign in — so a developer host sets
  `WS_EXTRA_ORIGINS=http://localhost:8080,http://localhost:4321` and the port
  is pinned in `apps/web/vite.config.ts` (`strictPort`) so the entry stays
  true. Then, from a worktree:

  ```sh
  corepack pnpm --filter @duckoj/web exec vite build     # into the worktree's own dist
  corepack pnpm --filter @duckoj/web exec vite preview &  # :4321
  E2E_BASE_URL=http://localhost:4321 \
  E2E_SECRETS_FILE=$PWD/.secrets/duckadmin.txt \
    corepack pnpm --filter @duckoj/web test:e2e
  ```

  Changing `.env` needs the API to pick it up: `podman-compose up -d --no-deps
  api`, then wait for `podman ps` to say `healthy`. A province's production
  host should leave `WS_EXTRA_ORIGINS` empty, and
  `docs/guide/truoc-khi-trien-khai.md` §3 makes that a done-condition — but
  **this rehearsal host is not that host**: it runs
  `WS_EXTRA_ORIGINS=http://localhost:8080,http://localhost:4321`, which is
  precisely the origin hole that checklist step exists to close.

This exact sequence (container run, `migrate`, `api dev`, `curl /healthz`) was run
end-to-end while writing this runbook: the container started, `migrate` printed
`migrations applied`, the API mapped all routes and logged
`Nest application successfully started`, and `curl -fsS http://localhost:3000/healthz`
returned `{"status":"ok"}`. *(Transcribed before D86 and D155. The body today
is `{"status":"ok","workers":4}`, and `/readyz` answers
`{"status":"ok","database":"ok","mail":"log"}` — `workers` is the live worker
count the compose healthcheck asserts on, and `mail` is `"log"` on a stack
with no `SMTP_HOST`.)*

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
   dispatch with a per-job ceiling so a hung collaborator can't wedge the whole
   worker loop silently. `MAX_GRADING_MS` (300 s) is that ceiling's **floor**,
   not its value: `gradingCeilingMs` gives a job
   `max(300 s, testCount × timeMs × 3 + 60 s)`, capped at
   `ABSOLUTE_MAX_GRADING_MS` (30 min), because a 350-test problem legitimately
   needs longer than 300 s and a fixed cap starved the queue behind it.
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
token stops ending the compromise. This is *not* step-up re-authentication, and
it is not a scope check either — the two are separate mechanisms that happen to
refuse the same callers here.

**Scopes are read, and they constrain tokens only.** `ScopeGuard`
(`apps/api/src/authn/scope.guard.ts`) is the second global `APP_GUARD`, and it
reads `Actor.scopes` via `hasScope`. It denies by default: a token reaching a
route with no `@RequireScope` is refused with `403 scope_required`, so
forgetting the decorator fails closed exactly as forgetting `@Public()` does.
Read `@RequireScope('x:y')` as *"tokens declaring `x:y` may also come here"*,
never as *"this route is protected by `x:y`"* — a **session bypasses the check
entirely** (`actor.via === 'session'` returns before any metadata is consulted),
because scopes narrow a machine credential down from its owner's authority and
there is nothing to narrow a present, interactive owner down from. So
`GET /packages/{hash}` answers 200 to a signed-in user with no token and no
scopes at all, and that is correct; see **D50**. A route that must refuse some
*sessions* needs a role or visibility check in its service — a scope will never
do it — and a route that must refuse tokens outright takes `@SessionOnly()`.

Every route therefore carries exactly one of four markers — `@Public()`,
`@RequireScope()`, `@NoScopeRequired()`, `@SessionOnly()` — which
`test/route-marker-coverage.spec.ts` enforces.

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

*(This host has since moved to `SITE_ADDRESS=:80` and the `8443` URL no longer
answers; re-run the pair over `http://localhost:8080`. The catch-all behaviour
the transcript is evidence for is unchanged.)*

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

### Redeploying a service after a code change: `scripts/deploy.sh`

**This is the command.** Do not hand-type a build/stop/rm/up sequence, and do
not use `scripts/compose-up.sh` for it — that brings the WHOLE stack up from
nothing, which is a different job.

    scripts/deploy.sh api
    scripts/deploy.sh api judged caddy      # several at once

It does five things, each of which was learned the hard way (see D85, D86 and
the OUTAGE entry in `docs/superpowers/ledgers/2026-08-29-feature-bug-loop-ledger.md`):

1. **Builds from `git archive HEAD`**, exported to a scratch directory —
   never the working tree. Anyone's uncommitted edit, in any file the
   Dockerfile copies, cannot reach a container. The loop's ledger records
   "rebuilt from a clean HEAD export" three separate times, done by hand each
   time; this makes it the only path.
2. **Keeps the running image as `:previous`** before the build overwrites
   `:latest`.
3. **Runs `migrate` first, when `packages/db/migrations` moved** since the sha
   in `.deploy/last-deploy` (gitignored, written only after a deploy that
   passed its poll). No marker, or a marker this repo no longer has, means run
   them. It rebuilds the `migrate` image too — that image carries the
   migration files, and deploying a schema change without it re-runs the
   PREVIOUS build's migrations and exits 0.
4. **Recreates, then watches for 45 s** and requires all three at the end:
   every deployed container healthy, `GET /api/v1/languages` answering **200
   through Caddy** (the path a browser takes, not `localhost:3000`), and no
   worker re-fork or `cannot boot` lines in the last 30 s of the api
   container's log.
5. **Rolls back automatically** if any of that fails: prints the logs, retags
   `:previous` over `:latest`, recreates again, and exits non-zero. The marker
   is not advanced, so the next attempt still knows the migrations are owed.

Useful overrides: `SKIP_MIGRATE=1` / `FORCE_MIGRATE=1`, `PROBE_URL=...` (a
different route or origin), `HEALTH_POLL_SECONDS=90` for a slow host. Run
`scripts/test/deploy.test.sh` after editing it — the whole script is covered
against stub `podman`/`podman-compose`/`curl` binaries.

`deploy/duckoj.service` is unaffected: the boot unit still runs
`scripts/compose-up.sh` with `SKIP_BUILD=1`, and still never picks up a code
change — see "Boot and reboot".

### Bringing the whole stack up

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

**Since D200 this is the only way onto a default stack at all**, not merely
the tidy one: `REGISTRATION` is unset in a fresh `.env`, which means `closed`,
and `POST /auth/register` refuses everybody who is not already a global admin.
This command has always been a CLI against `DATABASE_URL` rather than a route
— an HTTP endpoint that mints admins only has to be reachable once to be a
breach (D19) — and that is exactly why the closed rung has no bootstrapping
problem.

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

### Bulk student accounts for a school — `scripts/org-import.ts` (D61)

A province seats thousands of pupils who will never self-register. An owner
of the organization does this from the web ("Nhập danh sách học sinh" on the
organization page); an admin with no browser does it here:

    DATABASE_URL=postgres://duckoj:...@localhost:5432/duckoj \
      corepack pnpm org:import thpt-chuyen-a roster.csv > accounts.csv

`roster.csv` is one line per pupil — `username,displayName,email` — with an
optional header row (`username`/`tên đăng nhập`, `name`/`họ tên`, `email` are
recognised, in any column order) and an optional third column; comma,
semicolon and tab all separate. At most 500 rows per run (D61 as amended):
split a larger roster into several files, or use the web panel, which splits
it for you.

    username,họ tên
    hs2026001,Nguyễn Văn A
    hs2026002,Trần Thị B

Everything is validated first and the run is **all or nothing**: one bad row
prints every bad row to stderr, exits 2, and creates nothing. Otherwise each
account is created with a generated twelve-character password, flagged
`must_change_password`, and added to the organization as a `member`; the
credential sheet goes to **stdout** (so `>` works) and the warning to stderr.
Those passwords are argon2id-hashed on the way in and exist nowhere else —
there is no second chance to read them.

`--dry-run` validates and creates nothing. `--out accounts.csv` writes the
sheet to a file instead of stdout.

The command reaches `DATABASE_URL` directly rather than calling the API,
because `POST /orgs/{slug}/members/import` is `@SessionOnly` and a personal
access token is refused before the handler runs (D61). It is not a second
implementation: the validation, the password alphabet, the transaction and
the owners' notification all come from
`apps/api/src/authz/org-import.core.ts`, the module the API itself runs —
the same arrangement `bootstrap-admin.ts` has with `password.hash.ts`.
Reaching the database IS the authority here, so there is no owner check and
no rate limit, exactly as for `bootstrap:admin`.

Against a running stack, the one-off-container form above applies unchanged
with `scripts/org-import.ts` in place of `scripts/bootstrap-admin.ts`.

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

### Bài tập về nhà — a school's homework sets (D66)

Homework belongs to an organization, not to the site: `problem_sets` +
`problem_set_items` (migration 0026) and six routes under `/orgs/{slug}/sets`.
There is no CLI and no operator step — this is a thing a school's **owner**
does in the web, and this section exists so the person supporting them knows
what the screens are doing.

**Who sees what.** Three questions, in order: may you see the school
(`OrgAccessService`'s ordinary visibility gate — a school you may not see
404s with no mention of sets), do you belong to it, do you run it. A
**member-less viewer of a visible school gets an EMPTY LIST**, and every
individual set answers `problem_set_not_found`. That is deliberate and not a
bug report: an item may name an `org`-visibility problem shared with this
school alone, so a readable set is a readable list of problem codes. "This
school has assigned nothing" and "you are not in this class" must look the
same. Creating, editing and withdrawing a set is **owner or global admin**;
an org `admin` may not.

**Assigning.** "Giao bài tập" on the organization page: a slug (unique per
org, case-folded), a name, an optional description, an optional deadline, and
an ordered list of problems with per-item points. A problem the school's
members could not open is refused **422** with the row named
(`problems[<n>].code`): `problem_set_problem_private` for a private problem or
another school's, `problem_set_problem_unknown` for a code that does not
exist, `problem_set_problem_duplicate` for a code twice. A problem NARROWED
after it was assigned keeps its row, marked `visible: false` — the page just
stops offering a link that would 404.

**Deadlines.** Inclusive: a submission at the stroke of the deadline is on
time. A late solve is its own entry beside the on-time one (`onTime` and
`late` per cell), never instead of it — an on-time `WA` and an `AC` two days
later are both shown, which is the case homework is actually about. With no
deadline `late` is always null. `solvedAt` is non-null only for an `AC`.

**The class grid and its CSV.** The JSON grid is a keyset page with a "Tải
thêm" button. `?format=csv` is the **whole roster** — a deliberate exception
to the paging rule, because a file that stops after twenty-five pupils is a
file somebody would mark a class from — walked in cursor pages of 500 and
**capped at 20 000 rows** (`DEFAULT_PROGRESS_EXPORT_BOUNDS`). A file that hit
the cap ends with a final `truncated,<rows>` line rather than stopping
silently; if a school ever reaches it, raise the bound at that constant
rather than teaching anyone to trust a short file. A dated set gets a second
`<code> (late)` column per problem. The grid excludes submissions inside a
still-open contest window (D49) while the pupil's own page does not (D23), so
a pupil sees their score before their teacher's grid does.

**Two operational edges.** `problem_set_items` has **no `ON DELETE` on
`problem_id`**, so deleting a problem that is assigned to a set is now
refused by the foreign key — deliberate (a set must not lose an item
silently), but a new way for a delete to fail: withdraw the sets first.
And **nothing meters set creation**; an owner minting thousands of sets is
not rate-limited, only bounded by their being an owner.

    -- what a school has assigned, and how big each set is
    select s.slug, s.name, s.deadline, count(i.problem_id) as items
      from problem_sets s
      left join problem_set_items i on i.set_id = s.id
      join organizations o on o.id = s.org_id
     where o.slug = '<school>'
     group by s.id order by s.created_at desc;

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

**That is the `SITE_ADDRESS=localhost` case, and it is not what this host
runs.** This deployment sets `SITE_ADDRESS=:80`, which is a port-only site
address: Caddy binds `:80` inside the container and provisions no certificate
at all, so nothing listens behind the published `8443`, and every
`https://localhost:8443` line in this document — including the transcripts
below — answers `000`, "Recv failure: Connection reset by peer". **On this
host the entry point is plain `http://localhost:8080`**:

    curl -s http://localhost:8080/healthz
    {"status":"ok","workers":4}

`scripts/deploy.sh` already says so in its own comments, and its `PROBE_URL`
defaults to `http://localhost:8080/api/v1/languages` for exactly this reason.
Check `SITE_ADDRESS` in `.env` before copying any `8443` line from this page.

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
  *(Transcribed under `SITE_ADDRESS=localhost`, and before D86 and D155. This
  host now runs `SITE_ADDRESS=:80`, so the `8443` URL resets the connection;
  the same two probes over `http://localhost:8080` answer
  `{"status":"ok","workers":4}` and
  `{"status":"ok","database":"ok","mail":"log"}`.)*
- `POST https://localhost:8443/api/v1/auth/register` through Caddy returned
  `201` with the created user profile (`id`, `username`, `email`, etc.), proving
  the reverse proxy, the API, and a migrated database all work together.
  *(Transcribed before D200. On a stack that leaves `REGISTRATION` unset this
  now answers `403 registration_closed`, which is the correct result — a 403
  through Caddy proves the same three things a 201 did. Use
  `GET /api/v1/auth/registration` for a 200 that needs no account at all.)*
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

## Boot and reboot

Podman has no daemon. `docker-compose.yml`'s `restart: unless-stopped` is
therefore worth nothing across a power cycle: on 2026-08-25 this host rebooted
and every container sat in `Exited` for **four days** while the tailscale URL
served nothing at all. Two systemd **user** units close that hole —
`deploy/duckoj.service` (the stack) and `deploy/duckoj-backup.timer` (the
nightly backup). Both are user units, so both need lingering.

### Installing both units

    loginctl enable-linger "$USER"
    mkdir -p ~/.config/systemd/user

    # the stack
    sed "s|__REPO__|$PWD|" deploy/duckoj.service > ~/.config/systemd/user/duckoj.service

    # the nightly backup (service + timer; the service has no [Install] — it
    # exists to be fired by the timer, never enabled on its own)
    sed "s|__REPO__|$PWD|" deploy/duckoj-backup.service > ~/.config/systemd/user/duckoj-backup.service
    sed "s|__REPO__|$PWD|" deploy/duckoj-backup.timer   > ~/.config/systemd/user/duckoj-backup.timer

    systemctl --user daemon-reload
    systemctl --user enable --now duckoj
    systemctl --user enable --now duckoj-backup.timer

`loginctl enable-linger` is the load-bearing line. Without it a *user* manager
only exists while that user has a login session, so nothing starts at boot and
everything is torn down at logout — which is exactly the four-day outage
above, with extra steps. Run it once; it survives reboots.

`__REPO__` is substituted with `$PWD`, so run these from the real checkout
(`/home/lamter/Projects/duckoj`), not from a worktree.

### `SKIP_BUILD=1`: what the boot unit does *not* do

`deploy/duckoj.service` sets `SKIP_BUILD=1`, which makes `scripts/compose-up.sh`
skip `podman-compose build` and bring the stack up from the images already on
disk. That is deliberate: rebuilding every image on every power cycle would
delay availability by minutes, on a machine whose only job at that moment is
to be reachable again.

**The consequence, stated plainly: this unit never picks up a code change.**
It recreates containers from whatever images exist. If someone ran `git pull`
since the last manual build, a reboot brings the stack up reporting fully
healthy while serving the *previous* build, and the checkout on disk says
otherwise. `compose-up.sh`'s own comments argue at length that a bring-up
which reports healthy while running old code "does not fail, it lies" — that
hazard is not eliminated here, it is *scheduled*, and this is where you find
out about it.

**So: after any code change, redeploy by hand.**

    cd ~/Projects/duckoj && git pull
    scripts/compose-up.sh            # no SKIP_BUILD — this one rebuilds

That is the whole redeploy procedure. `systemctl --user restart duckoj` is
*not* a redeploy: it re-runs the same script with `SKIP_BUILD=1` still set and
gives you the old images back.

### Checking status and logs

    systemctl --user status duckoj              # active (exited) is correct — Type=oneshot + RemainAfterExit
    journalctl --user -u duckoj -n 100          # the last bring-up, i.e. compose-up.sh's own output
    journalctl --user -u duckoj -b              # this boot only
    podman ps                                   # what is actually running now

`Type=oneshot` with `RemainAfterExit=yes` means a healthy unit shows **`active
(exited)`**, not `active (running)`. That is not a fault. The containers are
supervised by podman, not by this unit; the unit's job is to have run
`compose-up.sh` successfully once. If it says `failed`, the journal holds
`compose-up.sh`'s `FATAL:` line and the failing service's logs — the script
prints both before exiting non-zero.

`ExecStop` is `podman-compose stop`, so `systemctl --user stop duckoj` stops
the stack. That is also how you take the site down deliberately; the backup
timer will **not** bring it back up (see below).

### Verifying the nightly backup actually ran

    systemctl --user list-timers duckoj-backup.timer
    journalctl --user -u duckoj-backup -n 50

`list-timers` shows `NEXT`/`LEFT` and `LAST`/`PASSED`. A `LAST` of `n/a` on a
host that has been up for more than a day means it has never fired — check
that the timer is `enabled` and that lingering is on. The journal holds
`backup.sh`'s own output, including the `==> Wrote:` sizes, so a backup that
"ran" but produced a suspiciously small dump is visible there.

Force one now, without waiting for 03:00:

    systemctl --user start duckoj-backup.service

Two properties worth knowing, both deliberate:

- The timer fires at `03:00:00 Asia/Ho_Chi_Minh` with the timezone written
  into the expression, because a bare `03:00` that silently means UTC is 10:00
  local — the middle of a contest morning, the one hour a `pg_dump` must not
  start. `Persistent=true` makes the first boot after a powered-off night take
  the backup it missed.
- The backup unit is ordered `After=duckoj.service` but no longer `Wants=` it.
  A stack you stopped on purpose stays stopped: 03:00 will not silently start
  it, and `backup.sh` will exit loudly instead, which is the intended
  behaviour.

**Nothing alerts you when a backup fails.** `Type=oneshot` with no
`OnFailure=` means a nightly `pg_dump` that starts failing is visible only in
`journalctl`. D17 accepts that; it is a known cost, not an oversight. Someone
has to look.

## Backups

Two things on this host are irreplaceable: the Postgres database, and the
`package_store` volume holding the content-addressed problem-package bytes.
Everything else — images, `caddydata`, `/problems` inside the judge — is
rebuilt or re-fetched on demand. `scripts/backup.sh` captures exactly those
two; `scripts/restore.sh` puts them back.

`pgdata` is deliberately NOT copied as a volume: `pg_dump -Fc` is consistent
and version-portable, where tarring a live data directory is neither.

### Taking a backup

    scripts/backup.sh                # -> ~/duckoj-backups
    scripts/backup.sh /mnt/usb/duckoj

Each run writes `duckoj-<stamp>.dump` (custom-format `pg_dump`) and
`duckoj-<stamp>.package_store.tar`, prints their sizes, then prunes to the
newest `KEEP` (default 14 — see D17 in `docs/DECISIONS.md`). Both artefacts
are written to `.partial` and renamed only after the producing command exits
0, so the directory never holds a truncated file under a name that looks
restorable.

Env: `KEEP`, `COMPOSE_PROJECT_NAME`, `PG_CONTAINER`, `STORE_VOLUME`,
`PG_USER`, `PG_DB`, `SKIP_STORE=1`. `KEEP` must be a non-negative integer and
is validated before any work is done, so a typo cannot fail the run *after* a
good backup is already on disk.

**From a git worktree, pass `COMPOSE_PROJECT_NAME=duckoj`.** The compose
project name is the repo *directory* name — exactly as `scripts/compose-up.sh`
computes it — so run from a worktree the container lookup finds nothing and
the script exits non-zero telling you this. (The older `COMPOSE_PROJECT` is
still accepted as a deprecated alias by both scripts. Use the new name: in
`restore.sh` the difference is load-bearing, and dangerous — see Restoring.)

### The backups contain the identity table — the file modes are the protection

A dump holds every `users` row: argon2id password hashes, the email addresses
and display names of students who are minors, session and token hashes, and
encrypted TOTP secrets. There is no encryption at rest and no access log on
these files, so the only thing between them and another account on this host
is the filesystem mode. `backup.sh` sets `umask 077` before it creates
anything and enforces:

    ~/duckoj-backups            drwx------   (700)
    ~/duckoj-backups/duckoj-*   -rw-------   (600)

Every pre-existing `duckoj-*` file in the destination is tightened on each
run, so a directory created before this was enforced gets fixed on the next
nightly rather than staying loose forever. **If `ls -l ~/duckoj-backups` ever
shows anything other than those modes, something outside these scripts wrote
there — investigate it.** The same applies to wherever the off-host copies
land: `scp` does not preserve a 700 directory into a world-readable parent.

### Restoring

    CONFIRM=yes scripts/restore.sh ~/duckoj-backups/duckoj-20260829-030000

It refuses to run without `CONFIRM=yes` — there is no interactive prompt, so
that it fails rather than hangs when run from an unattended shell. It also
refuses if the postgres container it resolved is not **running**, before it
touches anything.

The sequence, in order:

1. `podman-compose stop api judged` — both hold connections, and `judged` is
   actively `UPDATE`ing `grading_jobs`. `postgres` stays up; it is what we are
   restoring into.
2. `pg_restore -l` on the archive — the table of contents only, no database
   touched. A truncated or corrupt dump fails here, with every row still in
   place, instead of after step 3 has emptied the database.
3. **`DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA
   public;`** — the target is emptied before the reload. See "Step 3 is why an
   old backup loads at all" below; without it the newest nightly backup did
   not restore onto this stack (D130).
4. `pg_restore --clean --if-exists --no-owner` from `<prefix>.dump`.
5. **`podman-compose up --no-deps --force-recreate migrate`**, with the same
   exit-code check `scripts/compose-up.sh` does.
6. `podman volume import` of `<prefix>.package_store.tar`, if it exists.
7. `podman-compose start api judged`.

**Measured RTO, 2026-08-31 drill (D130): 15 s** — 12 s of `restore.sh` plus 3 s
before a real route answered 200, restoring the 03:01 nightly (248 kB dump, 333
users, 714 submissions) into a stack built from the current images. The backup
side is under a second; `journalctl --user -u duckoj-backup` shows the nightly
starting and finishing in the same second. **RPO is one night, and on this host
that is a lot**: that dump carried 228 of the 333 users and 376 of the 714
submissions that existed twelve hours later.

#### Step 3 is why an old backup loads at all

`pg_restore --clean` emits `DROP TABLE IF EXISTS public.users;` — no `CASCADE`,
because pg_dump only knows the objects in its own archive. The stack you are
restoring into is at *today's* schema, and a backup is by definition older, so
the target holds tables the dump has never heard of whose foreign keys point at
tables the dump does carry. Every one of those drops fails, the old tables
survive with their old primary keys, and the dump's own `CREATE`/`ADD
CONSTRAINT` then fails on top of them. That is not a hypothetical: it is what
the newest `~/duckoj-backups` dump did on 2026-08-31 — 32 ignored errors, exit
1, writers left down — and it reproduces on an empty, freshly migrated
database. Emptying the schemas first is what makes a restore mean "this
database becomes that backup"; step 5 puts today's schema back on top.

The cost, stated plainly: **a table the dump does not carry does not survive a
restore.** Step 5 recreates it, empty (plus whatever that migration backfills).

**Step 5 is why a restore is not just a `pg_restore`.** The dump carries the
schema as of backup time, drizzle's migrations table included, and `--clean`
replaces the live schema with it. Restore a two-week-old backup onto today's
images without it and the database is behind the code: the stack comes up
healthy (no healthcheck touches a new column) and the first request that does
returns a 500. That is the "schema drift that announces success" `compose-up.sh`
exists to prevent, and it used to be reintroduced through this path.

#### Which project it talks to — read this before running from a worktree

Pass **`COMPOSE_PROJECT_NAME`**, not `COMPOSE_PROJECT`. `restore.sh` resolves
one project name (`COMPOSE_PROJECT_NAME`, else the deprecated
`COMPOSE_PROJECT`, else the repo directory name) and **exports** it, so the
container lookup and every `podman-compose` call mean the same stack.

Before, they could disagree, and the failure was silent and catastrophic:
`COMPOSE_PROJECT=duckoj scripts/restore.sh …` from a worktree found the *live*
postgres by label while `podman-compose stop api judged` targeted the
worktree's own empty project and printed nothing alarming — so `pg_restore
--clean` dropped every table underneath a live `api` and a `judged`
mid-`UPDATE`, which is the exact hazard step 1 exists to prevent. The alias is
still read so an old invocation now does the right thing, but write the new
name.

`SERVICES=""` means **data path only**: no `podman-compose` command is run at
all — no stop, no migrate, no start. That is how the restore path is exercised
against a throwaway container without going near a live stack
(`scripts/test/restore.test.sh`), and it is not a mode to use on this host
unless you are doing exactly that.

It is idempotent, and since D130 in the stronger sense: the database half is a
schema reset followed by a full reload, so the result does not depend on what
the target happened to hold first. The volume
half is *additive*: `podman volume import` untars over what is already there
without clearing it. That is correct here and only here — `package_store` is
content-addressed, so a filename IS its hash and re-importing writes
identical bytes. It also means a restore does not delete packages uploaded
since the backup, which is deliberate: an orphaned blob costs disk, a deleted
one costs a problem.

#### When a step fails

`pg_restore` is still run without `--exit-on-error`, because a `--clean`
reload into a fresh database emits harmless noise for objects the target never
had. Its output is judged **afterwards** instead: a non-zero exit, or any
error line outside the known-benign `already exists` class, is a hard failure.

Which failure it was decides what happens to `api` and `judged`:

- **The archive would not read (step 2).** Nothing has been dropped and the
  database is exactly as it was — but the restore the operator asked for did
  not happen, so `api` and `judged` are still left stopped and the message says
  so. Fix the file (an older prefix in `~/duckoj-backups` is right there) and
  re-run; or `podman-compose start api judged` to put the site back up on the
  data it already had.
- **`pg_restore` failed, or `migrate` failed.** The database is in a state
  nobody has verified — half the tables restored, or the right tables at the
  wrong schema version. The script prints the full log, exits non-zero, and
  **deliberately leaves `api` and `judged` stopped**, telling you so in
  capitals. A half-restored schema that `api` is serving and `judged` is
  grading against is worse than a stack that is honestly down. Investigate,
  fix, re-run the restore; only then `podman-compose start api judged`.
- **Anything else after the writers were stopped** — most realistically a
  failed `podman volume import` from a truncated tar. The database is already
  reloaded and migrated and only package bytes are missing, so a trap
  **restarts the writers**, loudly, and the script still exits non-zero. The
  site does not stay down while someone notices.

That split is D30.

**The full path has now been drilled — on a throwaway stack, not this one.**
On 2026-08-31 a `b32drill` compose project was built from the current images,
seeded, backed up, destroyed (`DROP DATABASE` + an emptied package volume) and
restored end to end: `podman-compose stop api judged` → reset → `pg_restore` →
`migrate` → `podman volume import` → `start`, with the seeded rows back, the
migrations counted against `packages/db/migrations`, and a real route
answering 200. Both failure branches were fault-injected against the real
containers, not a stub. **That drill is also what found the bug in the first
paragraph of "Step 3" above** — until it ran, the newest production backup
would not have restored. `scripts/test/restore.test.sh` (49 cases) still covers
the data path against a throwaway postgres and a stub compose binary.

What has *still* never run is a restore against **this live stack**. Do the
first one with a terminal open on `journalctl`, not from a script — and note
that a restore now empties the target's schemas before it reloads, so an
aborted attempt is not a no-op unless it aborted at step 2.

**Check the migrations after a restore; do not assume them.** `migrate` brings
the restored database to the schema *production* had, not to head: drizzle
applies only journal entries newer than the newest already applied, so a
migration production skipped stays skipped in the copy (D131 was a live
example — this database skipped `0025_dashboard_bounds`; migration
`0041_dashboard_bounds_repair` has since put its four indexes back
idempotently, so the journal is complete at 44 and all four
`grading_jobs_*_idx` / `submissions_*_idx` are present).
Compare `select count(*) from drizzle.__drizzle_migrations` against
`ls packages/db/migrations/*.sql | wc -l`; if they differ, the difference is
real and predates the restore.

### Nightly, unattended

`deploy/duckoj-backup.service` + `deploy/duckoj-backup.timer` are systemd
*user* units, same shape and same `__REPO__` substitution as
`deploy/duckoj.service`. **Install steps, how to verify the timer actually
fired, and how to force a run now are all in "Boot and reboot" above** — the
two units are installed together and share `loginctl enable-linger`, so they
are documented in one place rather than two that drift.

The one-line summary: the timer fires at `03:00:00 Asia/Ho_Chi_Minh` with the
timezone in the expression (a bare "03:00" meaning UTC is 10:00 local, the
middle of a contest morning), `Persistent=true` catches up a backup missed
while powered off, and `systemctl --user list-timers duckoj-backup.timer` plus
`journalctl --user -u duckoj-backup -n 50` are how you tell whether it ran.

**Off-host copies are not automated and are not this repo's job** (D17).
Fourteen nightly backups on the same disk as the database protect against
`DROP TABLE`, a bad migration, and a botched restore. They protect against
nothing that destroys the disk or the machine. Someone has to copy
`~/duckoj-backups` off this host on a schedule.

## Redis is unbounded on purpose

`redis` runs with **`maxmemory 0`** (no limit) and the default `noeviction`
policy, and that is deliberate rather than an oversight.

It is safe because of a property of the code, not of the configuration:
**every key this API writes carries a TTL.** There is exactly one write path,
`SET … PX` (the scoreboard/booklet/statistics cache, D25/D48/D49), and
realtime is pub/sub, which stores nothing. B12 scanned the live instance
*during* a 500-VU hold and found **zero keys without a TTL**, 1.30 MB used
against a 1.47 MB peak, 98.3% hit rate.

Setting `maxmemory` + `allkeys-lru` was considered and refused: it configures
an eviction policy for a workload that never needs one, and it would turn the
first non-expiring key anyone adds from a visible growth problem into a value
that silently disappears under memory pressure. Unbounded-with-a-TTL fails
loudly; bounded-with-LRU fails quietly.

**What keeps the ruling honest.** `api` reads `CONFIG GET maxmemory` once at
startup — one worker only, whichever cluster worker is `#1` — and logs

    WARN [RedisConfig] redis maxmemory is 0 (unbounded) with no eviction policy: …

That line is expected on this deployment. It exists so that whoever adds a
`SET` without an expiry meets the word `maxmemory` before the host's OOM
killer does. If you ever do add a non-expiring key, that is the moment to set
a limit and an eviction policy — and to come back and rewrite this section.

The check never blocks a boot and never fails one: a Redis that is not up
yet, or a managed Redis that forbids `CONFIG`, logs one `debug` line and
nothing else. Absence of the warning therefore means "bounded, **or** could
not ask" — check with `redis-cli config get maxmemory` if it matters.

**A related line you may see under load**, once a minute at most:

    WARN [RedisScoreboardCacheStore] scoreboard cache unavailable, folding every board until Redis returns: Stream isn't writeable…

That is a transient cache drop-out (`enableOfflineQueue: false`, so a command
that cannot be sent right now fails instead of queueing). It cannot fail a
request — the board is simply folded from Postgres — and it is throttled to
one line a minute per worker precisely because it used to arrive once per
failed request, in the middle of the load that caused it.

## API workers — `API_WORKERS`

`api` is a Node process, and Node runs JavaScript on one thread. Before this
existed the whole API was therefore capped at one core of this sixteen-core
host, and the cap was measured, not assumed: at 500 VUs of `load/k6-contest-day.js`
the `api` container burned ~120% of a single core (the JS thread pegged, plus
libuv and GC on the side) while `postgres` used ~110%, `caddy` ~30%, and
thirteen cores sat idle. No query was slow. There was one of the thing doing
the work.

`API_WORKERS` (`apps/api/src/cluster.ts`) forks that many worker processes;
the primary binds the port once and the kernel round-robins accepted
connections across them. Compose pins `API_WORKERS: ${API_WORKERS:-4}`.

- **`1` disables clustering entirely** — one process, `bootstrap()` called
  directly, byte-for-byte the old behaviour. Use it when bisecting whether a
  fault is clustering-related.
- **Unset** (i.e. running the image outside Compose) defaults to
  `os.availableParallelism()` capped at 8.
- **An explicit value is honoured as written, not clamped**, and an
  unparseable one throws at boot rather than silently falling back to one
  worker.

### Why the default is 4 and not 16

Each worker opens its **own** Postgres pool of 10 connections
(`packages/db/src/client.ts`, `max: 10`). The `postgres` service is stock
`postgres:16`, whose `max_connections` is 100. Four workers is 40 connections,
which leaves room for `judged`, a `migrate` run and a `psql` session. Eight is
80 and is close. **Raising `API_WORKERS` past 8 requires raising
`max_connections` first** — otherwise the symptom is `api` failing its
healthcheck at boot with `too many clients already`, which reads like a
database outage and is not one.

### What clustering does *not* break

Everything the API keeps across requests is already outside the process,
because the code was written for multiple instances before it ever ran as
several:

- **Sessions and access tokens** are rows (`SessionService.resolve` is a
  hashed-token lookup); nothing is cached in memory.
- **Rate limits** are counted in the database (`apps/api/src/common/rate-limiter.ts`,
  D13) precisely so they are "correct across several API instances".
- **The realtime WebSocket** fans out through Redis. A browser's `/ws`
  upgrade lands on exactly one worker, but `judged` (and the API's own
  rejudge path) publishes to `SUBMISSION_CHANNEL`, every worker's
  `RedisSubscriber` receives it, and each notifies its own sockets.
  `RedisSubmissionPublisher`'s header documents this as the reason it
  publishes rather than calling `SubmissionsGateway.notify` directly — a
  direct call "would work in a single-process deployment and silently drop
  half the notifications in any other". Verified with eight concurrent
  subscribers across four workers during a real grade.

### Putting a second proxy in front of Caddy changes who the rate limiter sees

The per-IP windows — login's 30 per fifteen minutes (D16) and registration's 30
per hour (D26) — key on `clientIp()` in
`apps/api/src/authn/auth.controller.ts`, which reads the **first** entry of
`X-Forwarded-For`.

That is correct today because **Caddy strips `X-Forwarded-*` from untrusted
clients** (Caddy ≥ 2.7; no `trusted_proxies` is configured, so every client is
untrusted) and writes the connecting address itself. Verified empirically
against `caddy:2-alpine` v2.11.4 with this repo's `reverse_proxy` shape: a
request carrying `X-Forwarded-For: 9.9.9.9` reaches the API as
`x-forwarded-for: 127.0.0.1`. There is exactly one entry and it is Caddy's.

**If province IT ever fronts Caddy with nginx, HAProxy or a cloud load
balancer, revisit `clientIp` before anything else.** Those proxies *append*
rather than strip, so the leftmost entry becomes whatever the client sent, and
both per-IP windows are bypassable with one header on every request. The fix
at that point is to configure `trusted_proxies` in the `Caddyfile` and take
the rightmost untrusted hop, not to keep reading `[0]`.

### If a worker crashes

The primary re-forks it with exponential backoff (1s, doubling to 30s), and
resets to 1s once a worker has stayed up 30 seconds — so a boot-crash loop
does not become a fork bomb and an unrelated crash tomorrow does not inherit
today's 30-second delay. `SIGTERM`/`SIGINT` in the primary stops re-forking
and kills the workers, so `--force-recreate` does not have to wait out
podman's SIGKILL timeout. Worker exits are logged to stderr as JSON with the
pid, exit code, signal and uptime.

Before/after numbers for the 2000-VU profile are in `load/RESULTS.md`.

### A student lost their authenticator

**Ask about recovery codes first.** D39 gave two-factor authentication eight
single-use recovery codes, issued once at enrolment and regenerable from
`/account/security` with a working authenticator code
(`POST /auth/totp/recovery/regenerate`). A student who kept theirs presses
**Use a recovery code** at the sign-in box and needs no admin at all; the
Security page shows how many are left.

Only when the codes are gone too is this an admin job. `DELETE /auth/totp` —
the self-service switch on `/account/security` — requires an interactive
session, which requires the code the student no longer has, and a password
reset does not clear TOTP. "Contest morning" is exactly when this gets
reported.

**The fix, from the admin panel:** sign in as an admin, open `/admin`, type the
student's username under "Reset two-factor authentication", press the button
and confirm. Their second factor is off immediately, they sign in with username
and password alone, and they can re-enrol from `/account/security` afterwards.
They get an in-app notification saying it happened.

**Verify who you are talking to first.** This route hands an account to whoever
asks for it, and the API cannot tell a student from someone claiming to be one.
For a provincial contest that means checking the person against the seating
list or the school's own contact, not accepting an email. The reset is logged
only as the student's notification, so an admin who resets the wrong account
leaves little trail.

**From the command line**, if the web is unavailable:

```sh
curl -sS -X DELETE https://<host>/api/v1/admin/users/<username>/totp \
  -b "duckoj_session=<an admin's session cookie>" -i
```

`204` means done — including for an account that had no TOTP, which is
deliberate: a different answer would make the route a "does this person use
2FA?" probe. `403 admin_forbidden` means the caller is not an admin; `403
session_required` means an access token was used, which this route never
accepts.

**The last-resort SQL fallback**, for a database the API cannot reach:

```sh
podman exec -i duckoj_postgres_1 psql -U duckoj -d duckoj \
  -c "delete from totp_credentials where user_id = (select id from users where lower(username) = lower('<username>'))"
```

That leaves no notification behind — prefer the route.

## Judging throughput

Two separate ceilings, and they are commonly confused.

**`judged` — how many jobs are claimed at once.** `JUDGED_CONCURRENCY`
(default **1**, max 16) runs that many independent claim loops in the one
`judged` process (`apps/judged/src/worker.ts`, `startWorkerPool`). Each loop's
`worker_id` is suffixed `#1`, `#2`, … so a stuck job in `grading_jobs` still
names exactly one loop. Set it in `.env` (`JUDGED_CONCURRENCY=`), which
`docker-compose.yml` passes through.

The claim path itself has always been concurrency-safe: `JobStore.claim` takes
its row under `FOR UPDATE SKIP LOCKED`, so two loops racing get two different
jobs, and `heartbeat`/`complete`/`isCurrentAttempt` fence on `(job id,
attempt)` rather than on the claimant, so no loop can renew or finish
another's attempt.

**The judge — how many grades actually run at once. This is the real
ceiling.** A DMOJ judge grades **one submission per connection** (D29), so the
fleet's capacity is the number of connected `judge` containers. A plain
`podman-compose up` starts one; "Adding a second judge" below starts the
second.

`judged` now enforces that rather than merely documenting it. Two mechanisms,
both in the B2 fix:

- **Targeted cancel.** `terminate-submission` carries no submission id, so
  `DmojDriver` tracks which connection is grading which submission and sends a
  terminate only to that one. A cancel for a job no judge is running sends
  nothing, logs `cancel for a submission no judge is running`, and emits no
  `terminated` event. Before this, one job's watchdog terminated whatever the
  judge was really running — a different student's submission, permanently
  `errored`/`IE` with no requeue.
- **Back-pressure.** A claim loop reserves a judge slot
  (`JudgeDriver.tryAcquireSlot`) *before* it claims, so `judged` never leases
  more jobs than the judges can run and a claimed job is always immediately
  runnable. A loop with no slot polls every 500 ms and claims nothing.

Two consequences an operator will actually see:

1. **Raising `JUDGED_CONCURRENCY` past the number of judges does nothing.** It
   is not a deeper queue any more — the extra loops never win a slot. Raise it
   *with* the fleet, one per judge.
2. **With no judge connected, nothing is claimed at all.** Submissions stay
   `queued` instead of being claimed, timing out on the 300 s watchdog and
   showing up as IE. If the queue is not moving, check the judge is connected
   (`podman logs duckoj_judged_1` for a handshake) before suspecting `judged`.
3. **A judge only takes work it can run.** Since D68 the dispatcher routes by
   language — a job goes to a connected judge whose handshake announced an
   executor for it, and a job no connected judge can run is not claimed at
   all. It stays `queued` and says why, in `grading_jobs.blocked_reason`; see
   "A queue that is not moving, with a judge connected" below.

**Read all of this off `/admin` before reaching for psql.** The operations
dashboard is where these two ceilings are visible side by side:

- The **Judges** table carries a row per registered node with **Grading now**
  and **Graded (1 h)** beside `online` — the per-machine counts, joined
  through `grading_jobs.judge_node_id` (migration 0027). A second judge that
  is online with `0` in both columns is a judge taking none of the work, which
  is what `JUDGED_CONCURRENCY=1` looks like from the outside: raise it to 2.
- **Jobs stuck in the queue** appears only when something is blocked, and
  prints `blocked_reason` verbatim with a count per reason — the same
  sentence the query below returns, without the psql. Those jobs are also
  counted in **Queued**: blocked is a reason on a queued job, not a state.
- **Grading workers** is the other ceiling, per claim loop rather than per
  machine: **Now grading**, **Graded (1 h)**, **Internal errors (1 h)**.

The two tables answer different questions and neither replaces the other — a
worker with no judge (an in-process driver) and a judge with no worker (its
claim loop has exited) both exist.

### Grep for the failure this replaced

    podman logs duckoj_judged_1 2>&1 | grep 'cancel for a submission no judge'

Each line is a job whose watchdog or lapsed lease fired while nothing was
grading it. Harmless in itself — that is the fix working — but a steady stream
means jobs are being cancelled before they reach a judge, which is worth
tracing to the packages or the agent, not the bridge.

### Adding a second judge

Built and tested now, not a sketch: `docker-compose.yml` carries a `judge-2`
service behind the **`scale` profile**, `scripts/judge-node.ts` registers the
node, and `apps/judged/test/multi-judge.spec.ts` proves two judges grading
concurrently over the real wire protocol (D68).

1. **Register the node.** This mints the token; do not invent one.

       corepack pnpm judge:node add judge-2

   It prints the token **once**. `judge_nodes` has a UNIQUE index on
   `token_hash`, so `judge-2` cannot reuse `JUDGE_TOKEN`. Put the printed
   value in `.env` as `JUDGE_TOKEN_2` (nothing else reads that variable; the
   compose service below passes it in as the container's `JUDGE_TOKEN`).

   `postgres` has no host port mapping, so run this the way every other
   database script is run against the live stack — as a one-off container on
   the Compose network, reusing the `migrate` image:

       podman run --rm --network <project>_default --env-file .env \
         localhost/<project>_migrate:latest \
         sh -c 'DATABASE_URL="postgres://duckoj:$POSTGRES_PASSWORD@postgres:5432/duckoj" \
                packages/db/node_modules/.bin/tsx scripts/judge-node.ts add judge-2'

2. **Start it** — the whole stack, second judge included:

       SCALE=1 scripts/compose-up.sh

   `SCALE=1` (or `COMPOSE_PROFILES=scale`, the spelling docker compose uses)
   makes the script pass `--profile scale` on every compose call and wait on
   `judge-2`'s healthcheck exactly as it waits on `judge`'s. Passing the flag
   is not optional: podman-compose 1.5 reads a profile ONLY from its own
   command line and ignores `COMPOSE_PROFILES` — measured with
   `podman-compose config` — so the script translates the variable rather
   than leaving a second judge that is never started.
   `scripts/test/compose-up.test.sh` pins both halves against stubbed
   binaries.

   To start just the one container against an already-running stack:

       podman-compose --profile scale up -d judge-2

   Without `--profile scale` the service is not started at all — podman-compose
   1.5 filters on `profiles`, which is why `judge-2` is safe to keep checked
   in. It does interpolate variables *before* filtering, so `JUDGE_TOKEN_2`
   has a harmless placeholder default rather than a `:?` marker that would
   break every plain `up`.

3. **Then, and only then, raise `JUDGED_CONCURRENCY` to 2** — one claim loop
   per judge. Until judge-2 is handshaking, the second loop cannot win a judge
   slot and the change is inert (D29).

4. **Check it.** `SCALE=1 scripts/compose-up.sh` already failed loudly if
   `judge-2` never turned healthy, so what is left to confirm is that it is
   ACCEPTED, not merely running — a rejected credential is a healthy
   container that grades nothing:

       corepack pnpm judge:node list        # judge-2 present, revoked:false
       podman logs <project>_judged_1 2>&1 | grep judge-2

   Then `/admin`: `judge-2` online, and **Grading now** / **Graded (1 h)**
   moving off zero once work arrives.

   A rejected credential prints exactly one line, `judge handshake rejected`
   with `id: judge-2`. `judge:node list` also shows each node's recorded
   `capabilities` — the languages it announced at handshake — which is the
   fastest way to tell a judge that connected from one that connected *and*
   can run C++.

`/problems` is a per-container runtime directory judge-agent materialises into
on demand, so judge-2 needs no shared volume and no seeding; it re-fetches what
it needs from the API.

### Rotating a judge's token

    corepack pnpm judge:node rotate judge-1

**This is the command, and `revoke` then `add` is not.** `add` refuses a name
it already holds — revoked or not — so the sequence
`revoke judge-1 && add judge-1` burns the credential and then fails, leaving a
dead judge and no way forward except SQL. `docs/guide/truoc-khi-trien-khai.md`
carried that sequence in its step 1 for months and it never worked (F-58).
`rotate` mints a new token for a node that exists, keeps the row — so
`grading_jobs.judge_node_id` goes on naming the machine that graded each
submission — and prints the token exactly once (D204).

It works on a node you have already revoked, and says so. That is the way out
if you followed the old instruction and are standing in the dead end now.

**The judge is disconnected within five seconds and cannot come back on its
own.** `judged` re-checks every connected judge against `judge_nodes` on a
five-second timer, matching the credential the connection authenticated with
(D81 as widened by D204), so the judge holding the old token is closed and
retired. It then redials with the token still in its container environment,
which is refused: expect a `judge handshake rejected` line per attempt in
`judged`'s log until you finish the sequence below. **That loop is the proof
the old token is dead**, not a fault.

**Nothing is failed. Work queues.** A submission mid-grade on that connection
is abandoned and requeued — no `GradingEvent` is written, so no student gets a
permanent IE (D29) — and with no judge connected the dispatcher parks rather
than rejecting (D68). The cost of a rotation is latency, for as long as the
fleet is empty.

**A `podman restart` is not enough.** A container's environment is fixed when
it is created, so the judge would come back with the same old token. The token
has to reach it through `.env` and a **recreate**.

The order, and it is the order:

1. **Have the rotation-aware images.** `rotate` lives in the `migrate` image
   and the credential-matching poll lives in `judged`; a stack deployed before
   D204 has neither, and rotating against it would leave the old judge
   connected on a credential that no longer exists — dispatched to, and 401'd
   by the API on every package fetch. `scripts/deploy.sh` first if `judge:node
   rotate` prints the usage line instead of running.

2. **Rotate, and keep the token.** `postgres` publishes no host port, so this
   runs as a one-off container the same way the bootstrap does:

       podman run --rm --network <project>_default --env-file .env \
         localhost/<project>_migrate:latest \
         sh -c 'DATABASE_URL="postgres://duckoj:$POSTGRES_PASSWORD@postgres:5432/duckoj" \
                packages/db/node_modules/.bin/tsx scripts/judge-node.ts rotate judge-1'

   The token is printed once. Nothing can recover it. From this second the old
   one is refused everywhere — the bridge handshake and the API's package
   guard both go through `verifyJudgeCredential`.

3. **Put it in `.env`.** Replace `JUDGE_TOKEN=`'s value. Nothing else reads it:
   `judge/judge.yml` is a template rendered at container start from
   `JUDGE_NAME`/`JUDGE_TOKEN` (`judge/entrypoint.sh`), and
   `scripts/seed-problem.ts` only ever seeds a row this rotation has now
   replaced.

4. **Recreate the judge**, do not restart it:

       podman-compose up -d judge

   Or `scripts/compose-up.sh`, which recreates everything and waits for
   health. Either way the container comes up, renders `judge.yml` from the new
   `JUDGE_TOKEN`, and handshakes — re-announcing its executors, which is how
   `judge_nodes.capabilities` is rewritten (D68; nothing manual).

5. **Confirm it took, in three places.**

       corepack pnpm judge:node list        # judge-1, revoked:false, a FRESH lastSeen
       podman logs <project>_judged_1 --since 2m 2>&1 | grep -i judge

   `lastSeen` moving is the one that matters: it is written on the handshake
   and on any packet after it, so a stale value means the new token has not
   been accepted. The log should show the rejection loop ENDING — no
   `judge handshake rejected` after the recreate. Then grade something:

       corepack pnpm exec tsx scripts/e2e-submit.ts

   An `AC` there is the whole verification: it goes through dispatch, the
   bridge, a package fetch authenticated with the new token, and the sandbox.

**How long the judge is down** is entirely steps 3 and 4 — the rotation itself
is instant and the recreate is a container start. Everything submitted in that
window is queued, not lost, and drains when the judge returns. Rotate outside
a contest anyway: a queue that drains is still a room full of pupils watching
a spinner.

### Retiring a judge

    corepack pnpm judge:node revoke judge-2

This burns the token hash and **keeps the row**. Do not `DELETE` it:
`grading_jobs.judge_node_id` references `judge_nodes` `on delete set null`, so
deleting the row erases which machine graded every submission it ever ran.
Revoking is idempotent.

**It takes effect within about five seconds, even on a judge that is already
connected** (D81). `judged` re-checks every connected judge against
`judge_nodes` on a five-second timer and closes the socket of anything that is
no longer admitted, logging one `dropping judge no longer admitted` line with
the id. (That line said `dropping revoked judge` before D204; it now fires for
a rotated judge too, whose row is neither gone nor burned.)
Before that timer existed, the credential was verified once, at the handshake,
so a revoked judge held its connection for as long as it stayed up and went on
being dispatched to. Stopping the container is still the tidy end of it, but it
is no longer what makes the revocation take effect.

If a revocation appears not to land, look for `judge revalidation failed` in
`judged`'s log: the poll fails **open** on purpose (a database blip must not
disconnect the whole fleet), so a broken poll leaves every judge connected.

### A queue that is not moving, with a judge connected

`judged` dispatches a job only to a judge whose handshake announced an executor
for that job's language, and its claim loop will not even claim a job no
connected judge can run — so such a job stays `queued` instead of being leased
and failing. `grading_jobs.blocked_reason` says why:

    select id, blocked_reason from grading_jobs
     where state = 'queued' and blocked_reason is not null;

The **Jobs stuck in the queue** panel on `/admin` is the same information
without the psql — reason and count, present only when something is blocked.

`no connected judge supports language <key>` means exactly that: bring up a
judge configured with that executor (the compose `judge` services pass
`--only-executors CPP14,CPP17,CPP20,C11,PY3,PAS,JAVA`, the seven live
languages), and the reason clears within about five seconds.
`NULL` on every queued row means the queue is waiting on capacity, not on
capability.

### Which judge graded a submission

    select s.id, j.name
      from submissions s
      join grading_jobs g on g.submission_id = s.id
      left join judge_nodes j on j.id = g.judge_node_id
     where s.id = <id>;

`judge_node_id` is written on dispatch, from the bridge connection the request
actually went to. `NULL` means the job has not been dispatched yet — or was
graded before this column existed.

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

> **Neither default works on this host** (checked 2026-09-02). The script's
> `E2E_BASE_URL` default is `https://localhost:8443`, which resets the
> connection under `SITE_ADDRESS=:80` — pass
> `E2E_BASE_URL=http://localhost:8080`, which is also the only value D82's
> origin list accepts. And its first act is an anonymous `POST /auth/register`,
> which D200's default rung answers `403 registration_closed`: the script has
> no admin-cookie path, so on a `closed` stack it cannot run at all. Set
> `REGISTRATION=open`, or use the Playwright suite, whose walks mint their
> pupils as the admin.

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
   submission's own `state` says. `apps/judged/src/worker.ts`'s watchdog
   eventually rejects a job that never reaches a terminal driver event, logs
   `job failed`, and lets it re-lease on the next `attempt`. Its deadline is
   `gradingCeilingMs`, not a flat 300 s: `MAX_GRADING_MS` (300 s) is the floor
   and a large dataset gets up to `ABSOLUTE_MAX_GRADING_MS` (30 min), so do not
   read a job still running at 400 s as stuck.
   **A job nothing has claimed has no deadline at all** — there is no sweeper
   over `queued`, so with no judge connected submissions sit queued
   indefinitely rather than turning `IE`.
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

**Prefer `scripts/deploy.sh <service>`** (see "Redeploying a service after a
code change" at the top of "Deploying"): it does everything below from a clean
`git archive HEAD` export, and then actually checks that what it started
answers a real route before it walks away. What follows is the manual sequence
it encodes, kept because knowing it is what lets you recover when the script
itself is what is broken.

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

> **On the default rung this walkthrough's step 1 answers 403** (D200). Since
> F-56 `REGISTRATION` decides who may create an account, and an unset variable
> means `closed`: only a global admin may register anybody. So on a default
> stack, do steps **2 and 1 in that order** — `corepack pnpm bootstrap:admin
> admin1` first, then run step 1's `curl` with the admin's cookie jar
> (`-b admin.cookies`) instead of anonymously. Setting `REGISTRATION=open` in
> `.env` restores the sequence exactly as transcribed below, which is what it
> was run under.

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

> **Same two blockers as `e2e-submit.ts`** (checked 2026-09-02): pass
> `E2E_BASE_URL=http://localhost:8080`, because nothing listens on `8443` under
> `SITE_ADDRESS=:80`; and step 1 below registers three users through the public
> route, which `REGISTRATION=closed` — the default since D200 — refuses `403`,
> a status this script calls `fail()` on. It needs `REGISTRATION=open` as it
> stands.

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

> **Closed — this section is Phase 2b history and its instruction is now
> wrong.** `401682f` adopted `@tanstack/react-router` and deleted `parseRoute`
> in Phase 2b itself. `apps/web/src/main.tsx` mounts `RouterProvider`,
> `apps/web/src/router.tsx` declares the routes, `apps/web/src/routes/` holds
> **thirty** modules, and `grep -rn 'function parseRoute' apps/web/src` finds
> nothing. **Do not "extend `parseRoute`"** — add a `createRoute` in
> `router.tsx`. The paragraphs below are kept because the cost they measure is
> the argument that won; nothing in them describes the code today.

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
[typst](https://typst.app). **It is on, and has been since the images were
built for it.** `apps/api/Dockerfile` downloads typst 0.15.1 (a ~15 MB musl
tarball), compiles a probe statement at build time so the `mitex` cache is
already seeded in the image, and `docker-compose.yml` sets
`TYPST_BIN: /usr/local/bin/typst`. `GET /api/v1/problems/aplusb/statement.pdf`
answers 200 with a `%PDF-1.7` body on the live edge.

The route falls back to **501** only if `TYPST_BIN` is unset — unset it to turn
PDFs off deliberately. Because the cache is baked in, a fully offline
deployment needs nothing further: the `packages.typst.org` fetch a math
statement used to make on its first compile has already happened, at build
time, on this image.
