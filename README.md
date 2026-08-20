# DuckOJ

A ground-up rewrite of DuckOJ: a TypeScript monorepo with a NestJS
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
surfaced as verdict ~~`IE` with the real compiler's error text — see
`docs/runbook.md` for why `IE` and not `CE` is expected here~~ **fixed in
Phase 2b:** a compile failure now surfaces as verdict `CE`, with the real
compiler's error text in `compileOutput` — see "Phase 2b delivers" below and
`docs/runbook.md`'s "A compile error is `CE`" section).

Phase 1 also ships three deliberate, deferred limitations — recorded in
`docs/runbook.md` so they don't cost the next person an afternoon:
~~a compile error is reported as verdict `IE`~~ **fixed in Phase 2b:** migration
`0005` added `CE` to `case_verdict` and `EventWriter` now writes it, so a
compile failure reads as a compile failure instead of an internal error — see
"Phase 2b delivers" below; ~~the judge-bridge handshake never checks
the configured key, so network isolation (never publishing `judged`'s port)
is the only real control~~ **closed in Phase 2a:** the handshake now verifies
a real `(name, token)` credential against `judge_nodes`, fails closed, and is
enforced on both the bridge and the package-fetch endpoint — see "Phase 2a
delivers" below; and there is no scheduling policy or attempt cap, so a job
that keeps failing to dispatch keeps re-leasing forever instead of being
parked.

## Phase 1 does not deliver

Problem management (authoring or versioning problems beyond the one problem
`scripts/seed-problem.ts` seeds), problem packages, contests, organizations
as a judging surface, scoreboards, ratings, or any scheduling policy —
priority, fairness, and bounded retries all arrive in later phases.

## Phase 2a delivers

Problems as real, content-addressed **packages** rather than a single
directory the judge image happened to ship with. A package (manifest, test
data, checker) is built into a deterministic, zstd-compressed archive and
hashed (`@duckoj/package-format`); the hash *is* the package's identity and
the DMOJ `problem-id`, so two builds of the same directory always produce
the same hash and no code anywhere maps a hash back to a directory name. The
API gains a filesystem content-addressed store behind two endpoints — a
public, integrity-checked upload (`POST /packages`, 422 if the archive's
contents don't hash to the claimed value) and a judge-credential-only
archive fetch, refused to any user session including an admin. A new
`apps/judge-agent` runs beside the real DMOJ judge process and materialises
a package to `/problems/<hash>/` **on demand, atomically** — `judged` asks
the agent to ensure a package before every dispatch, and a failed or corrupt
fetch leaves no partial directory behind. Judges now authenticate at the
bridge handshake with a real credential (closing Phase 1's known gap, above)
and announce their supported problems, which `judged` records per
connection instead of discarding.

Verified against the real containerized judge with **two** genuinely
different problems — `aplusb` (arithmetic) and `hello` (string I/O, seeded
separately, never present in the judge's `/problems/` until fetched on
demand): correct, wrong, and uncompilable C++ against `aplusb`
(`AC 3/3`, `WA 1/3`, `IE` with real compiler output — this predates Phase 2b's
`CE` fix; see "Phase 2b delivers" below) and a correct solution against
`hello` (`AC 3/3`), with `/problems/<hello-hash>/` shown absent before the run
and present, correctly materialised, after. See `docs/runbook.md`'s
"End-to-end acceptance against the real judge" section for how to reproduce
this and its "Known issues carried into Phase 3" section for what remains
outstanding.

## Phase 2a does not deliver

Problem *authoring* as a user-facing feature (packages are still built and
uploaded via a script or a raw HTTP call, not a UI), package versioning
beyond "first write wins" on a given hash, package deletion or garbage
collection in the store, and any scheduling, priority, or attempt-cap policy
around dispatch — all still arrive in later phases.

## Phase 2b delivers

Problems as a real, authored resource rather than a script-seeded fixture.
Full CRUD over HTTP (`POST /problems`, `GET /problems`, `GET /problems/:code`,
`PATCH /problems/:code`) sits behind a permission model of `problem_members`
(`author` / `curator` / `tester` roles per problem) and `problem_orgs`
(sharing a problem with an organization), enforced by **one** visibility
predicate — `apps/api/src/authz/problem.visibility.ts` — consumed by both the
problems path and `SubmissionAccessService`, so a problem visible in the list
is gradeable and a problem gradeable is visible; the two never diverge because
there is only one rule to diverge from. Reads a caller may not see return
`404 problem_not_found`, never `403`, so existence itself is not leaked.

Revisions turn a problem into something versioned: `POST
/problems/:code/revisions` attaches an already-uploaded package as a draft,
denormalising its manifest (`timeMs`, `memoryKb`, `testCount`, `totalPoints`,
`checkerKind`) onto the revision row so the problem page never has to open the
archive to show its own limits, and rejecting a path collision inside the
package a second time at attach (the first gate is Phase 2a's `POST
/packages`; this one exists because a `packages` row can be seeded directly
without going through upload). `POST
/problems/:code/revisions/:version/publish` archives whatever was previously
published and promotes the new one inside one locked transaction, backed by a
partial unique index (`problem_revisions_one_published_idx`) that makes "at
most one published revision per problem" true by construction, not by
convention — a submission is only ever graded against a published revision.

An admin-only route, `PATCH /admin/users/:username`, grants `setter` or
`admin`; it requires a real session (a leaked access token cannot mint its own
replacement admin) and refuses to let the last admin demote themselves out of
the role — the documented SQL bootstrap is the recovery path if that ever
happens anyway.

A compile error now reports as verdict `CE`, not `IE` — `case_verdict` gained
a `CE` member and `EventWriter` writes it on a `compileError` event, with the
compiler's output in `compileOutput`. `IE` again means what it says: a
genuine judge-side internal error.

On the web: a problem list, a problem page rendering its Markdown statement
(client-side, sanitized before it reaches the DOM), and authoring screens —
create, edit, and a revisions/publish view — for anyone with `author`,
`curator`, or `admin` standing on that problem.

The API's own OpenAPI document is served live (regenerated from the
registry on every request, not read from the committed build artifact) with
an interactive viewer, both at `/api/v1/docs` — see `docs/runbook.md` for why
it lives under the API prefix rather than at the root.

Verified against the real containerized judge and the full Compose stack,
not against mocks: `scripts/e2e-problem.ts` registers three users over real
HTTP, bootstraps the first admin with the documented SQL, grants a second
user `setter` through the new route, creates a private problem, builds and
uploads a package, attaches and publishes it, flips it public, and grades a
correct and an uncompilable submission against it — landing `AC 10/10` and
`CE` with real compiler output, from a package that reached the judge only
because this run uploaded it. See `docs/runbook.md`'s "Phase 2b: authoring a
problem" section to reproduce the walkthrough by hand.

## Phase 2b does not deliver

A member-management UI (adding or removing an `author`/`curator`/`tester` is
API-only — `POST /problems` and the revisions screen are the only authoring
surfaces the web app has), package upload from the browser (the revisions
screen accepts an already-uploaded package's hash by paste, not a file input —
uploading bytes is still `scripts/package-build.ts` plus a raw
`POST /packages` call), tags, contests, problem deletion, any scheduling or
priority policy around dispatch, and no router library — `apps/web`'s five
routes are still matched by a hand-rolled `parseRoute` against
`window.location.pathname`, not `@tanstack/react-router` (declared as a
dependency since Phase 0, imported nowhere). All arrive, or get decided, in
later phases.
