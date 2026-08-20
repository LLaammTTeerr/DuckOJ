# DuckOJ — Foundation Design

**Date:** 2026-08-17
**Status:** Draft, pending review
**Scope:** Cross-cutting decisions for the ground-up rewrite. Every later spec depends on this one.

---

## 1. Context

DuckOJ currently runs a fork of DMOJ (`qhhoj/online-judge`), roughly 60k LOC of Python in a single Django app, with 232 Jinja2 templates and 737 lines of URL routing.

The dependency tree is not old — it pins Django 5.1, Celery 5.4, and current auth libraries. **The architecture is what is old.** Views carry business logic (`views/contests.py` is 1964 lines, `views/problem.py` 1356), models are equally fat (`models/contest.py` 1240 lines), and the JSON API is a single file bolted alongside the HTML views.

This project is therefore not a stack migration. It is a **boundary extraction**: a separate frontend, a real backend API, and an SDK, with a data model designed for problem revisions and a judging layer that is not welded to one judge implementation.

The existing repositories are a **functionality reference only**. No code is carried over.

### Constraints

- **Greenfield.** Production data lives elsewhere and does not need to survive. No schema compatibility, no password-hash compatibility, no uptime pressure. Migration, if any, happens later as a separate exercise.
- **Team of two.** One human, one agent. Fluent in TypeScript, Python, C++.
- **1–3 VPS.** Peak scale assumed at 1000 concurrent users.
- **The sandbox is out of scope.** `qhhoj/judge-server` is used as-is and is not modified.

### Goals

1. Reproduce the core functionality of the existing judge — problems, submissions, judging, contests, organizations — on an architecture that separates frontend, backend, and SDK.
2. Make problem test data **versioned and content-addressed**, so a submission can always be traced to the exact tests that judged it.
3. Put a real seam between the platform and the judge implementation, so a future in-house judge is a driver, not a rewrite.
4. Leave room for a Polygon-style problem preparation system without redesigning problems, packages, or judging when it arrives.

### Non-goals

- Migrating existing production data (deferred, separate project).
- Replacing or modifying `judge-server`.
- Building the preparation system (Phase 6, its own spec).
- Building the virtual/external judge (explicitly deferred).

---

## 2. Scope decisions

### Kept

Users, profiles, registration, TOTP two-factor · problems, statements, test data · submissions and the judging pipeline · contests with `default`, `icpc`, `ioi16`, `ioi` (legacy) formats · scoreboards · ratings · **organizations** (load-bearing for DuckOJ) · tags · judge and runtime status · PDF statements.

### Dropped

Blog and posts · comments · tickets · MOSS plagiarism detection · social authentication (GitHub, Facebook) · WebAuthn · camo image proxy · URL shortener · newsletter · magazine · license pages · flatpages · Discord webhooks · user activity tracking · **performance points**.

### Dropped contest formats

`atcoder`, `ecoo`, `Ultimate`, `final_submission`, `vnoj`. Formats are pluggable; any of these can return later as an isolated addition.

### Deferred

Virtual/external judge · problem preparation system (Polygon) · data migration from the existing production instance.

**Rationale.** The dropped set is roughly 40% of the old codebase and close to 0% of what an online judge is for. Most of it is accumulated DMOJ inheritance. The community features it removes are already served by Discord and Facebook for this audience.

---

## 3. Technology

| Layer | Choice |
|---|---|
| Language | TypeScript, everywhere |
| Runtime | Node 22 LTS |
| Backend framework | NestJS |
| Database | PostgreSQL 16 |
| Query layer / migrations | Drizzle ORM + drizzle-kit |
| Internal job queue | BullMQ on Redis |
| Grading job queue | PostgreSQL table with explicit leases (see §6) |
| Frontend | React + Vite SPA, TanStack Router + TanStack Query |
| PDF rendering | Typst |
| Blob storage | S3-compatible API, backed by MinIO on VPS-1 |
| Monorepo | pnpm workspaces + TypeScript project references |
| CI | GitHub Actions |

### Why one language

The frontend is TypeScript regardless. A Python backend means every model exists twice — Pydantic and TypeScript — kept in sync by codegen discipline. TypeScript end-to-end means the SDK types *are* the backend types. For a two-person team that is not a style preference; it halves the surface that has to be debugged under pressure.

The argument for a Python backend was the ability to port DMOJ's contest formats, ratings, and performance points directly. On inspection that argument fails: those ~2000 lines reach into `django.db.connection` raw cursors, ORM aggregates, and `format_html`/`gettext` for scoreboard rendering. The algorithm is reusable as a specification; the code is not portable in any language.

### Why PostgreSQL, not MySQL

Greenfield removes the constraint. We want window functions for scoreboards, JSONB for package manifests and per-format configuration, partial indexes for visibility filtering, and `LISTEN/NOTIFY`. DMOJ works around the absence of all four.

### Why NestJS, not Fastify

The design commits to a modular monolith with an enforced seam between problem preparation and problem serving (§5). NestJS modules make that seam structural rather than a convention we promise to honour. The verbosity is the price of the boundary being real.

### Why no Turborepo or Nx

Ceremony without payoff at this team size. Added only if build times become a problem.

### Deferred within this section

Frontend component library, and the i18n library. UI locales are **Vietnamese and English**; statements carry a locale field from the start.

---

## 4. Repository layout

```
duckoj/
  apps/
    api/          NestJS — HTTP + WebSocket
    judged/       judge gateway — hosts judge drivers
    worker/       BullMQ consumers
    web/          React + Vite SPA
    judge-agent/  sidecar for DMOJ judge machines
  packages/
    db/               Drizzle schema + migrations (single source of truth)
    contracts/        Zod schemas → OpenAPI → shared BE/FE/SDK types
    judge-protocol/   wire codec, packet types, in-process fake driver
    package-format/   package model, hashing, Polygon importer
    sdk/              public TypeScript client
    cli/              `oj` command-line tool
  docs/
```

---

## 5. System architecture

### Processes

```
                    ┌──────────┐
   browser ◄──WS───►│   api    │◄──┐
   browser ◄─HTTP──►│ (NestJS) │   │ Redis pub/sub
                    └────┬─────┘   │  + BullMQ
                         │         │
                    ┌────▼─────────┴──┐        ┌──────────┐
                    │   PostgreSQL    │◄───────┤  worker  │
                    └────▲────────────┘        └──────────┘
                         │
                    ┌────┴─────┐
                    │  judged  │  TCP :9999 (DMOJ driver)
                    └────▲─────┘  HTTP        (native driver)
                         │
        ┌────────────────┴────────────────┐
   ┌────┴─────┐                      ┌────┴─────┐
   │  VPS-2   │                      │  VPS-3   │
   │ judge-   │ ◄── judge-agent ───► │ judge-   │
   │ server   │      (package sync)  │ server   │
   └──────────┘                      └──────────┘
```

**`judged` is a separate process deliberately.** Judges hold long-lived connections and grade for minutes at a time. If the gateway lived inside `api`, every deploy would disconnect the fleet mid-submission. Separated, we can ship API changes during a contest.

**`judged` and `api` never call each other.** `judged` writes to PostgreSQL and publishes to Redis; `api` subscribes and fans out over WebSocket. This replaces DMOJ's separate Node event daemon and its custom post-socket protocol — one fewer moving part.

### Deployment

- **VPS-1** — `api`, `judged`, `worker`, PostgreSQL, Redis, MinIO, Caddy (TLS + static `web` bundle), via Docker Compose.
- **VPS-2/3** — `judge-server` + `judge-agent`. Judges require privileged seccomp, so isolating them serves security as well as capacity.

The `web` SPA is a static bundle served by Caddy — no server-side rendering, no sixth process. Public problem and contest pages get a lightweight prerender for link previews if that becomes a need.

### Module boundaries in `api`

Modules: `identity`, `orgs`, `problems`, `packages`, `submissions`, `judging`, `contests`, `rating`, and later `preparation`.

**The seam rule:** `preparation` may write package revisions. `problems` and `contests` may read **published revisions only**, never a setter's working state. Enforced by NestJS module exports plus an ESLint import-boundary rule, so a violation fails CI rather than depending on review.

This is what makes the preparation system extractable into its own service later as a deployment change rather than a rewrite.

---

## 6. Judging

### The seam is a job queue, not a connection

The rest of the system knows only our contract:

- **Job** — `{ id, kind: submission|invocation|generation|rejudge, packageHash, revisionId, language, source, limits, priorityClass }`
- **Events** — `queued → dispatched → compiling → (compileError | compileMessage) → caseResult* → batchBegin/End* → finished{verdict, points, timeMs, memoryKb} | internalError | terminated`
- **Capabilities** — `{ languages[], concurrency, health }`

Absent by design: problem codes, executor names, `init.yml`, TCP. Those are driver concerns.

A queue-shaped contract accommodates both DMOJ's push-over-long-lived-socket model and the pull-based stateless workers the future in-house judge will use. A connection-shaped contract would accommodate only the first.

### Judge API — the contract the future judge speaks

```
POST /judge/claim              { capabilities, capacity }
                            → { jobId, attempt, leaseUntil, packageUrl, packageHash,
                                language, source, limits } | 204
POST /judge/{id}/heartbeat     { attempt }  → { leaseUntil, cancelled }
POST /judge/{id}/events        { attempt, events[] }
POST /judge/{id}/finish        { attempt, verdict, points, timeMs, memoryKb }
```

Long-poll on `claim`. Bearer token per judge machine. Packages fetched over HTTP by content hash and cached on local disk.

### Leasing, fencing, idempotency

**Leasing.** A claimed job carries `leaseUntil`; heartbeats extend it. A missed heartbeat expires the lease and returns the job to the queue with `attempt + 1`. A worker is never assumed dead — only ever out of lease.

**Fencing.** Every claim returns an `attempt` number. Events carrying a stale `attempt` are **rejected, not merged**. Without this, a worker that was partitioned and returned will overwrite the verdict of the retry that already completed — a silent wrong answer, and the hardest class of bug to detect after the fact.

**At-least-once, therefore idempotent.** A job may genuinely run twice. Case results are keyed `(jobId, attempt, caseIndex)`; `finish` is idempotent on `(jobId, attempt)`. We do not attempt exactly-once delivery; we make duplicates harmless.

### Why PostgreSQL leases rather than BullMQ for grading jobs

Exposing Redis to judge machines is a poor security boundary, and BullMQ's stalled-job recovery is not a lease that survives reasoning about network partitions. Grading jobs are low-throughput and long-duration — hundreds per minute at peak, each lasting seconds to minutes — which PostgreSQL handles trivially with `FOR UPDATE SKIP LOCKED`. In exchange we get an audit trail of which judge received which job, retry counts, and queryable queue state for the status page.

BullMQ remains, for internal background work only: PDF rendering, rating recomputation, email, package builds.

### Fairness

DMOJ's `judge_priority.py` is a bare integer priority. With preparation invocations in the picture — one "12 solutions × 300 tests" run is 3,600 jobs — a plain priority queue lets one setter freeze a live contest.

- **Priority classes:** contest submission > practice submission > rejudge > invocation > generation.
- **Round-robin within a class, keyed by user**, so one person's submission spree cannot starve others.
- **Capacity reservation:** invocations may never occupy more than a configured percentage of fleet capacity while any contest is live.

### DMOJ driver

The DMOJ wire protocol is a 4-byte big-endian length prefix wrapping zlib-compressed UTF-8 JSON, with optional TLS and PROXY-protocol support, and a handshake-then-stream exchange.

The driver claims jobs on behalf of whichever connected judge is idle, uses DMOJ's existing `ping`/`ping-response` as the heartbeat, and maps its `on_timeout` onto lease expiry. The legacy driver is a *consumer* of the new contract rather than a special case beside it.

**`judge-agent`** exists because `judge-server` reads problems from local disk (`judgeenv.py` walks `problem_dirs` for `init.yml`) and has no concept of fetching a package. The agent **long-polls the Judge API** for published revisions — the same HTTP boundary and bearer-token auth the workers use, never Redis or the database — then downloads packages by content hash, unpacks into the problem directory, and triggers a rescan. It belongs inside the DMOJ driver's boundary and disappears entirely with a native judge. No change to `judge-server` itself.

Consequence: a DMOJ judge box holds exactly one revision per problem code — the published one. Preparation invocations use a separate code namespace (`prep/<id>`) so preparation traffic cannot clobber a live problem.

### DMOJ concepts we refuse to leak

| DMOJ concept | Our model | Why |
|---|---|---|
| `result_flag` bitmask (`WA\|TLE` simultaneously) | one `Verdict` enum plus a `flags[]` detail | a submission has one verdict; the mask is a judge implementation detail |
| `SC` short-circuit | `skipped: true` on the case | it is scheduling, not judging |
| executor keys (`CPP17`, `PY3`) | our `Language` entity, mapped driver-side | a new judge will name runtimes differently |
| problems keyed by directory code | jobs reference a content hash | revisions are the entire point |
| problem must be on judge disk | the driver's problem | disappears with a native judge |

Maintaining this table is the actual work of the abstraction. The interface is easy; refusing these five is what determines whether the second judge takes two weeks or a rewrite.

An abstraction designed against a single implementation is usually wrong. Two mitigations: the contract is derived from what we want and DMOJ is mapped onto it, not the reverse; and `packages/judge-protocol` ships an **in-process fake driver** used by tests, so there are two implementations from day one.

---

## 7. Data model

`bigserial` primary keys throughout — CP users expect `submission #12345` — except `package`, whose primary key is its content hash.

### Identity and organizations

```
user               id, username, email, password_hash(argon2id), status,
                   display_name, about, avatar_key, country, timezone, locale,
                   rating, max_rating, global_role
session            token_hash, user_id, expires_at, ip, user_agent
totp_credential    user_id, secret_enc, confirmed_at
access_token       id, user_id, name, token_hash, scopes, last_used_at, expires_at

organization       id, slug, name, about, visibility(public|private),
                   join_policy(open|request|invite)
org_member         org_id, user_id, role(owner|admin|member), joined_at
org_join_request   org_id, user_id, state, decided_by
```

DMOJ's `User`/`Profile` split exists only because Django's auth model is fixed. Merged here.

### Problems, revisions, packages

```
problem              id, code(unique), name, owner_id, org_id NULL,
                     visibility(private|org|public), current_revision_id,
                     source_visibility(always|after_solving|never)
problem_revision     id, problem_id, version, package_hash, state(draft|published|archived),
                     created_by, created_at, notes
package              content_hash PK, size_bytes, storage_key, manifest JSONB
problem_collaborator problem_id, user_id, role(editor|viewer)

statement            revision_id, locale, title, legend, input, output,
                     notes, scoring, samples JSONB,
                     pdf_key(generated), pdf_override_key(uploaded)
test_group           revision_id, index, name, points, policy(sum|min|all_or_nothing)
language_limit       revision_id, language_id, time_ms, memory_kb

tag                  id, slug, name, group_id NULL
tag_group            id, slug, name
problem_tag          problem_id, tag_id
```

A problem is **published** when `current_revision_id` is set and points to a revision in state `published`. This is the `published` predicate used in §8.

Test **data** lives in the package; test **structure** is mirrored in the database. Scoreboards and subtask displays must be queryable without unpacking an archive, but no test file is ever stored in PostgreSQL.

`package` is content-addressed and therefore deduplicated across revisions: fixing a statement typo does not re-upload 400MB of tests, and `judge-agent` skips downloads for hashes it already caches.

`org_id` is nullable — a problem may be global (public archive) or owned by an organization (private club set).

### Submissions

```
submission       id, user_id, problem_id, revision_id, language_id,
                 participation_id NULL, contest_id NULL,
                 source(text, compressed), state, verdict, points, max_points,
                 time_ms, memory_kb, created_at, judged_at
submission_case  submission_id, attempt, group_index, case_index, verdict,
                 time_ms, memory_kb, points, feedback, skipped
grading_job      id, kind, submission_id NULL, revision_id, package_hash,
                 priority_class, state, attempt, lease_until, worker_id, created_at
```

`revision_id` is pinned on every submission. DMOJ cannot say which version of the tests judged a submission, which makes "why did my AC become WA" unanswerable. One column fixes that permanently.

`participation_id`, not `contest_id`, is what contest scoring joins on. A user may hold several participations in one contest — one live and any number of virtual — so `contest_id` alone is ambiguous. `contest_id` is retained denormalised for cheap filtering only.

`state` is the lifecycle (`queued | compiling | grading | done | errored`); `verdict` is the outcome and is null until `state = done`.

### Contests

```
contest               id, slug, name, org_id NULL, visibility, access_code,
                      format(default|icpc|ioi16|ioi), format_config JSONB,
                      start_at, end_at, window_duration NULL, freeze_at NULL,
                      is_rated, hide_problems_until_end
contest_problem       contest_id, problem_id, revision_id, order, points,
                      partial, max_submissions
contest_participation id, contest_id, user_id, virtual(0 = live), start_at, end_at,
                      score, cumtime, tiebreaker, format_data JSONB, disqualified
contest_manager       contest_id, user_id
rating_event          contest_id, user_id, rating_before, rating_after,
                      rd_before, rd_after, volatility_before, volatility_after,
                      rank, created_at
```

`contest_problem.revision_id` is pinned: a setter editing a problem must not change the tests under a running contest. Fixing a broken test mid-contest is an explicit "bump revision and rejudge" action, never a silent one.

`format_data JSONB` carries per-format scoreboard state — ICPC attempt counts and penalty, IOI16 per-subtask maxima. Denormalized deliberately: recomputing a 1000-participant scoreboard from raw submissions on every page load is what makes DMOJ scoreboards slow.

### Runtimes

```
language           id, key, name, extension, ace_mode, is_active,
                   time_multiplier, memory_multiplier
judge_node         id, name, token_hash, driver(dmoj|native), capabilities JSONB, last_seen
language_judge_key language_id, driver, executor_key
```

`language_judge_key` is the table that keeps executor naming out of the domain.

---

## 8. Permissions

Three axes, kept deliberately small:

- **Global role** — `user | setter | admin`
- **Organization role** — `member | admin | owner`
- **Per-resource grant** — `problem_collaborator`, `contest_manager`

### Organization visibility

A `public` organization is listable and viewable by anyone; its member list follows the same rule. A `private` organization is visible only to its members and to admins — it does not appear in listings, and its slug returns 404 rather than 403, so existence is not disclosed.

`join_policy` is orthogonal: it governs how one *becomes* a member, not who can *see* the organization.

### Problem visibility

```
canView(problem, user) =
    user.is_admin
  ∨ collaborator(problem, user)
  ∨ org_admin(problem.org_id, user)
  ∨ in_active_participation(user, problem)
  ∨ (visibility = public ∧ published ∧ ¬hidden_by_running_contest)
  ∨ (visibility = org    ∧ member_of(problem.org_id, user))
```

The clause that always bites: **contest problems are visible during participation regardless of their own visibility, and must become invisible again when the contest ends.** This is the leak most rewrites reproduce.

### Submission visibility

Own submissions are always visible. Others' source follows the problem's `source_visibility` (`always | after_solving | never`; default `after_solving`). **During a contest, a participant sees only their own submissions, without exception.**

### Enforcement

**No handler filters visibility by hand.** All reads pass through scoped query builders — `visibleProblems(user)`, `visibleSubmissions(user)`, `visibleContests(user)` — in a single authorization module. Ad-hoc `where` clauses against these tables fail an ESLint rule, the same mechanism that enforces the §5 module seam.

---

## 9. Rating

**Glicko-2**, with a contest treated as one rating period and each other participant as one game, scored `1 / 0.5 / 0` by rank.

This is the system used as designed rather than bent: Glicko-2 is built around a rating period containing many games updated in batch, which is exactly a contest. Three consequences follow for free:

1. **Rating deviation is first-class**, so a 20-person club contest moves ratings less than a 500-person round without any special-casing of field size.
2. **Inactivity is modelled** — RD grows over time, so a returning user's rating moves quickly again rather than remaining frozen at a stale value.
3. **Glickman published a worked numerical example**, giving us test vectors from the author for the numerically delicate part (the volatility iteration solved by Illinois' method). We can prove the implementation correct rather than believe it.

Cost is O(n²) pairs per contest: 10⁶ comparisons at n = 1000, milliseconds.

### Architectural constraint

**Rating consumes ranks and nothing else.** It never sees points, penalties, or subtasks. `rating` depends on `contests` only through `FinalRanking = [{ userId, rank }]`, which makes it format-agnostic — adding a contest format later never touches rating code, and rating is testable with no contest fixtures at all.

### Rules

| Rule | Value | Rationale |
|---|---|---|
| Initial rating / RD / volatility | 1500 / 350 / 0.06 | Glicko-2 defaults |
| Minimum participants for a rated contest | 8 | below this the signal is noise |
| Participants with zero submissions | excluded from the ranking | registered-but-absent users otherwise distort the field |
| Virtual participation | never rated | |
| Disqualified participants | excluded; rating recomputed | |
| Ties | 0.5 each | |
| Provisional display | until 3 rated contests or RD < 110 | honest about uncertainty rather than showing a confident wrong number |

### Recomputability

Rating is a fold over contests ordered by end time. `rating_event` rows are the materialized result, but **the entire history must be recomputable from scratch, deterministically.** Unrating a contest, disqualifying someone a week late, or correcting a broken scoreboard all require replaying forward from that contest. Systems that cannot do this accumulate permanently wrong ratings.

`POST /admin/contests/{id}/unrate` recomputes forward as a worker job, transactionally, retaining prior values for diffing.

### Open

Rank titles and colour bands are a product decision, not a mathematical one, and are left to the user.

---

## 10. Statements and PDF

Statements are **structured sections with LaTeX math**, which is the model Polygon itself uses: `title`, `legend`, `input`, `output`, `notes`, `scoring`, `constraints`, plus `samples` as structured data.

Body text is Markdown with LaTeX math. HTML is rendered with KaTeX; PDF is rendered with **Typst**.

The structure is what makes Polygon import a field mapping rather than a parse, and it makes samples real data — the judge can verify them and the frontend can render copy buttons.

Authors lose arbitrary LaTeX. This is mitigated by an **uploaded-PDF override**: any problem may carry a hand-authored PDF that supersedes the generated one. This is also the honest handling of Polygon-imported problems, whose compiled PDF we keep verbatim.

**Typst over LaTeX** for a single ~30MB binary and sub-second compiles, rather than TeX Live in the image. The cost is recreating the `olymp.sty` appearance rather than inheriting it. Reversible — the renderer sits behind the same structured source.

---

## 11. API and SDK conventions

*This section was not reviewed section-by-section during design and warrants extra scrutiny.*

### Shape

REST over HTTP, JSON. Resource-oriented, plural nouns, no RPC-style verbs except for genuine actions (`/contests/{id}/unrate`, `/submissions/{id}/rejudge`).

- **Versioning:** `/api/v1`. A new major version is a new prefix; nothing is removed from a live version.
- **Errors:** RFC 9457 `application/problem+json` — `type`, `title`, `status`, `detail`, plus a machine-readable `code` and a `fields` map for validation failures.
- **Pagination:** cursor-based (`?cursor=&limit=`) for submission and problem lists; offset pagination degrades badly on the tables that matter here.
- **Sorting/filtering:** explicit allowlists per endpoint, never free-form.
- **Idempotency:** mutating endpoints that a client may retry accept an `Idempotency-Key` header.
- **Time:** RFC 3339 UTC everywhere; the frontend localises.

### Contracts as the single source of truth

`packages/contracts` holds **Zod schemas**. The OpenAPI document is generated from them, and the SDK types are generated from the OpenAPI document. The backend validates requests with the same schemas at runtime.

Consequence: a backend change that breaks the frontend fails typechecking in CI rather than in production. This is the concrete payoff of the one-language decision, and it is worth protecting — no hand-written DTOs that duplicate a Zod schema.

### Authentication

- **Browser:** opaque session cookie, `HttpOnly`, `SameSite=Lax`, server-side session table. Not JWT — session revocation must be immediate, and refresh-token rotation is complexity we have no need for.
- **SDK / CLI:** personal access tokens, scoped, revocable, listed in user settings.
- **Judge machines:** per-node bearer tokens, scoped to the Judge API only.

### Realtime

One WebSocket endpoint with topic subscriptions: `submission:{id}`, `contest:{id}:scoreboard`, `judge:status`. Server pushes only; the client re-fetches over HTTP for anything requiring authorization beyond the subscription. Reconnect with a last-seen event id so a dropped connection catches up rather than losing verdict updates.

### SDK and CLI

`packages/sdk` is the generated TypeScript client plus thin ergonomics (auth, retries, pagination iterators). `packages/cli` is `oj`, whose first real consumers are the preparation workflows: `oj package build`, `oj package push`, `oj submit`, `oj test` for local runs.

---

## 12. Testing

*This section was not reviewed section-by-section during design and warrants extra scrutiny.*

Four suites, each targeting a distinct failure mode.

### Unit

Standard, colocated, Vitest. Pure logic: scoring, package manifest parsing, wire codec.

### The permission leakage suite

Adversarial by construction: for each of roughly eight actor types — anonymous, org member, non-member, setter, collaborator, org admin, active participant, admin — crossed with each resource state, assert the **exact** visible set, not merely that forbidden access is denied.

This is the one place where tests are written before the code without needing an argument, because the failure mode is silent disclosure of unpublished problems.

### The contest format oracle harness

The contest formats are the highest silent-failure risk in the system and they cannot be ported — DMOJ's implementations are entangled with raw SQL and Django template rendering.

So: stand the **old Django application up in a throwaway container**, feed it synthetic contest fixtures, and freeze the resulting scoreboards as golden JSON. The new implementation must reproduce them exactly.

This converts "the old repository is the functionality reference" from a reading exercise into an executable test suite. It covers `default`, `icpc`, `ioi16`, and `ioi` only. It is **not** needed for rating, since Glicko-2 is verified against Glickman's published example instead.

Built at the start of Phase 4, not before — it is a distraction during Phases 0 and 1.

### Judging integration

Driven by the in-process fake driver in `packages/judge-protocol`, covering lease expiry, fenced stale-attempt rejection, duplicate delivery, cancellation mid-grade, and priority/fairness under invocation load. Plus one end-to-end suite against a real `judge-server` in Docker, run in CI on a schedule rather than per-commit.

---

## 13. Operations

*This section was not reviewed section-by-section during design and warrants extra scrutiny.*

- **Deployment:** Docker Compose on VPS-1, images built in CI and pulled by tag. Caddy terminates TLS and serves the `web` bundle.
- **Migrations:** drizzle-kit, forward-only, applied by an init container before `api` starts. Expand-and-contract for anything destructive.
- **Configuration:** environment variables validated by a Zod schema at boot; the process refuses to start on invalid configuration rather than failing later.
- **Logging:** structured JSON via pino, with a request id propagated into job records so a submission can be traced from HTTP request through grading job to verdict.
- **Metrics:** Prometheus endpoint on each process. The ones that matter: queue depth by priority class, lease expiries, judge fleet capacity, grading latency percentiles.
- **Health:** `/healthz` (liveness) and `/readyz` (dependencies reachable) on every process.
- **Backups:** nightly `pg_dump` plus MinIO bucket replication, off VPS-1. Restore rehearsed once before the first real contest, not after the first real incident.
- **Secrets:** environment files outside the repository; TOTP secrets encrypted at rest with a key held outside the database.

---

## 14. Build order

Build the riskiest integration first. The risk is not CRUD — it is the judging pipeline: wire protocol, package distribution, job dispatch, and live verdict streaming, which must work together or the product does not exist.

| Phase | Contents |
|---|---|
| **0 — Foundation** | Monorepo, NestJS + Drizzle + PostgreSQL, migrations, auth, the permission model, API conventions, CI, deploy shape |
| **1 — Walking skeleton** | One hardcoded problem, uploaded package, submit source, `judged` + DMOJ driver, real `judge-server` grading, verdict streaming to the browser. Deliberately ugly: no styling, no contests, no organizations |
| **2 — Problems and packages** | Problem/revision/content-addressed packages, upload and Polygon import, structured statements and Typst PDF, languages, limits, test data management |
| **3 — Users and organizations** | Full profiles, membership and roles, org-scoped visibility enforced end to end |
| **4 — Contests and rating** | `default`/`icpc`/`ioi16`/`ioi`, scoreboards, participation, Glicko-2, oracle harness |
| **5 — SDK and CLI** | Generated client, `oj` CLI |
| **6 — Preparation (Polygon)** | Separate spec, separate frontend, same backend and judge fleet |
| **later** | Virtual/external judge |

Organizations are cross-cutting rather than a phase: the permission model is designed in Phase 0 and enforced from the first endpoint, while organization *management features* land in Phase 3. Bolting visibility on afterwards is how judges leak unpublished problems.

Each phase gets its own spec, plan, and implementation cycle.

---

## 15. Open questions

1. Rank titles and colour band thresholds.
2. Frontend component library.
3. i18n library, and whether statement locales beyond Vietnamese and English are expected.
4. Email provider for verification and password reset.
5. Whether public problem pages need prerendering for link previews and search indexing.
6. Retention policy for submission source and grading job history.
