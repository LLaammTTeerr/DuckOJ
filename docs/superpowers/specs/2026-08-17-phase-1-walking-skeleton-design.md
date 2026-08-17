# Phase 1 — Walking Skeleton Design

**Date:** 2026-08-17
**Status:** Draft, pending review
**Depends on:** `docs/superpowers/specs/2026-08-17-foundation-design.md` (the foundation spec). Where the two disagree, the deviation is stated explicitly below.

---

## 1. Purpose

Phase 0 built the platform's floor: monorepo, schema, authentication, authorization, SDK, CI, deployment shape. It deliberately contains no judging.

Phase 1 builds the **spine**: a signed-in user pastes C++ into a browser and watches a verdict arrive from a real `judge-server` grading it in a container.

This is the riskiest integration in the project — wire protocol, package distribution, job dispatch, and live verdict streaming have to work *together* or the product does not exist. Everything else in the system is forms over a database. That is why it comes first, and why this phase is deliberately ugly: anything that is not the spine belongs to a later phase.

### Success criterion

Not "the tests pass." **A real submission of real C++ produces a real verdict in a browser**, demonstrated end to end against a containerized `judge-server`, for three cases: accepted, wrong answer, and compile error. The same three paths are covered by automated tests against an in-process fake driver.

### Non-goals

Problem management UI · packages and revisions · contests · organizations · scoreboards · rating · the native pull-based judge driver · scheduling policy of any kind.

---

## 2. Environment constraints

These are facts about the machine this is built on, and they shaped the design.

- **`judge-server` declares support for Python 3.7–3.11. This host runs Python 3.14**, with no `pip` and no `Python.h`. `cptbox`, the sandbox core, is a Cython C extension compiled against CPython internals.
- Building it three minor versions past anything it has been tested on risks a judge that compiles and then misbehaves under seccomp — failures that present as bugs in *our* code.
- **Therefore the judge runs in a container**, from `judge-server`'s own `.docker/tier1` image, under Podman. No local Python, no `cptbox` build.
- The host has Podman 5.7 and `podman-compose` 1.5, no Docker. `libseccomp` headers, `gcc`, `g++`, `make`, `cmake` and Node are present.

---

## 3. Scope

### Built

| Component | Contents |
|---|---|
| `packages/judge-protocol` | wire codec, packet types, `GradingJob`/`GradingEvent` contract, in-process fake driver |
| `apps/judged` | leased-job claimer, driver host, `dmoj-bridge` driver, event writer |
| `apps/api` | `POST /submissions`, `GET /submissions/:id`, WebSocket gateway |
| `apps/web` | one submit page with a live verdict panel |
| schema | `submission`, `submission_case`, `grading_job`, `language`, `judge_node`, plus the minimum of `problem`/`problem_revision` needed to reference a hash |
| seed | a script that installs one A+B problem and its content hash |

**"Minimum of `problem`/`problem_revision`" means precisely:** `problem` gets `id`, `code`, `name`, `statement` (plain text), `current_revision_id`; `problem_revision` gets `id`, `problem_id`, `version`, `package_hash`, `state`. No `package` table, no `statement` table, no `test_group`, no `language_limit` — those arrive with the package system in Phase 2. The columns here exist so a `GradingJob` can carry a real content hash instead of a placeholder.

### Built from the foundation spec's judging design

Leasing · fencing · at-least-once idempotency · the `GradingJob`/`GradingEvent` contract · the driver abstraction with two implementations.

### Deliberately deferred

Priority classes · per-user round-robin fairness · the invocation capacity reservation · the native pull-based driver · `judge-agent`.

**Rationale.** The deferred items are all *scheduling policy*, and scheduling policy is meaningless without contention: no contests until Phase 4, no invocations until Phase 6. Designing a fairness algorithm against one judge and one user is designing against imagination. Leasing and fencing are the opposite case — cheap now, and retrofitting them onto a working push-based pipeline means reasoning about every in-flight job, which is exactly the pain the foundation spec warned about.

---

## 4. Architecture

```
   browser ──WS (cookie | Bearer header)──► api ◄─── Redis pub/sub ───┐
      │                                      │                        │
      └──── POST /submissions ───────────────┤                        │
      └──── GET  /submissions/:id ───────────┤                        │
                                             ▼                        │
                                    ┌─────────────────┐               │
                                    │   PostgreSQL    │               │
                                    │  submissions    │               │
                                    │  submission_case│               │
                                    │  grading_job    │               │
                                    └────────▲────────┘               │
                                             │                        │
                                    ┌────────┴────────┐               │
                                    │     judged      │───────────────┘
                                    │  claims leases  │  publish AFTER commit
                                    │  hosts drivers  │
                                    └────────▲────────┘
                                             │ TCP: 4-byte BE length
                                             │      + zlib + JSON
                                    ┌────────┴────────┐
                                    │  judge-server   │  podman, tier1 image
                                    │   (container)   │  problem dir bind-mounted ro
                                    └─────────────────┘
```

Stack: `postgres` · `redis` · `api` · `judged` · `caddy` · `judge`.

### Redis, and the ordering hazard it introduces

The foundation spec specifies Redis pub/sub for `judged` → `api`. Phase 1 could have used PostgreSQL `LISTEN/NOTIFY` and shipped one fewer service, since nothing else needs Redis until Phase 2's BullMQ work. Redis is adopted now because building `LISTEN/NOTIFY` and then replacing it is two implementations and a migration, to save one container that costs almost nothing to run.

That decision carries a real cost that must be paid explicitly:

**`NOTIFY` is transactional — it fires only after the enclosing transaction commits, enforced by the database. Redis pub/sub is not.** `judged` can publish before its transaction commits, or publish and then roll back, and `api` will read submission state that does not exist. On a verdict pipeline this is a genuine and intermittent race.

**Mitigation, structural rather than remembered:** a single `SubmissionEvents` module is the only code that publishes, and its interface accepts an already-committed result. Publishing from inside an open transaction is not a mistake to avoid; it is a call that cannot be made. Verified by a test asserting that a rolled-back transaction publishes nothing.

This is the same principle as the foundation's explicit-`@Inject` rule and deny-by-default guard: put the safe thing where forgetting it is impossible.

---

## 5. The judging contract

### Shapes

```ts
GradingJob {
  id, attempt, kind: 'submission',
  packageHash, revisionId,
  language, source,
  limits: { timeMs, memoryKb }
}

GradingEvent =
  | { type: 'queued' }
  | { type: 'dispatched' }
  | { type: 'compiling' }
  | { type: 'compileError',   message }
  | { type: 'compileMessage', message }
  | { type: 'caseResult', groupIndex, caseIndex, verdict, timeMs, memoryKb, points, feedback, skipped }
  | { type: 'finished',       verdict, points, maxPoints, timeMs, memoryKb }
  | { type: 'internalError',  message }
  | { type: 'terminated' }
```

Absent by design: problem codes, executor names, `init.yml`, TCP. Those are driver concerns.

### Problem delivery, and why the job carries a hash

`judge-server` reads problems from disk **by directory code**. The foundation spec's anti-leak table explicitly refuses to let that reach our contract: jobs reference a **content hash**.

So the job carries a content hash and the **DMOJ driver** translates it to an on-disk code. In Phase 1 the translation is trivial — one seeded problem, a bind-mounted directory. In Phase 2, `judge-agent` replaces the trivial translation with real fetch-by-hash.

The seam therefore holds from the first submission, and `judge-agent` is not built against a hardcoded problem only to be rewritten once packages exist.

### Leasing

`grading_job` rows are claimed with `FOR UPDATE SKIP LOCKED`, taking a `leaseUntil` and incrementing `attempt`. `judged` heartbeats to extend. A missed heartbeat expires the lease and returns the job with `attempt + 1`.

A worker is never assumed dead — only ever **out of lease**.

- **Lease: 60 seconds. Heartbeat: every 20 seconds.** Long enough that a slow test case does not expire a live job; short enough that a `judged` crash recovers within a minute.

### Fencing

Every claim returns an `attempt`. **Events carrying a stale `attempt` are rejected, not merged.**

This is not theoretical under the push-based driver. If `judged` dies mid-grade, the lease expires and the job requeues — **but the DMOJ judge is still grading it**, and will send `grading-end` for the old attempt. Without fencing that stale verdict overwrites the retry's result. With fencing it is discarded and the retry is authoritative.

Two consequences, both implemented:

1. **On lease expiry, the driver sends DMOJ's `terminate-submission`** for the abandoned attempt, so judge capacity is not spent producing results that will be thrown away.
2. **On handshake, a reconnecting judge that reports a `current-submission-id` we hold no live lease for is told to terminate it.** DMOJ judges announce in-flight work on reconnect; without this, a `judged` restart leaves an orphan grading indefinitely.

### Idempotency

A job may genuinely run twice. Case results are keyed `(jobId, attempt, groupIndex, caseIndex)`; `finished` is idempotent on `(jobId, attempt)`. Exactly-once is not attempted; duplicates are made harmless.

### Verdict mapping

DMOJ transmits a **bitmask** — `WA|TLE` is a single value. Our `submission_case.verdict` is one enum value, resolved by DMOJ's own display precedence:

```
IE > TLE > MLE > OLE > RTE > IR > WA > SC      (AC when the mask is zero)
```

`SC` (short-circuit) is **not a verdict** — it sets `skipped: true` on the case.

The raw mask is retained in `flags[]` for diagnostics. **Nothing downstream may branch on it.** This is the foundation spec's anti-leak requirement made concrete, and it is the most expensive one to undo: every scoreboard in Phase 4 reads these verdicts.

### Driver interface

```ts
interface JudgeDriver {
  start(): Promise<void>
  capabilities(): { languages: string[]; concurrency: number }
  dispatch(job: GradingJob, emit: (e: GradingEvent) => Promise<void>): Promise<void>
  cancel(jobId: string, attempt: number): Promise<void>
  stop(): Promise<void>
}
```

Two implementations from day one: `DmojBridgeDriver` and `FakeDriver`. The fake is what keeps the interface honest — an abstraction with a single implementation is a guess, and the foundation spec already requires the fake for tests.

---

## 6. API and realtime

### HTTP

```
POST /api/v1/submissions       { problemCode, languageKey, source }  → 201 { id }
GET  /api/v1/submissions/:id   → { id, state, verdict, points, cases[], createdAt, judgedAt }
```

Both authenticated; neither is `@Public()`. Schemas live in `packages/contracts`, paths are registered, and `openapi.json` plus the SDK are regenerated — CI's drift check enforces it.

### WebSocket authentication — this does not come for free

**Phase 0's deny-by-default `APP_GUARD` covers HTTP routes. It does not automatically apply to a WebSocket gateway.** The most valuable property of the authorization model — that forgetting a marker fails closed — does not extend to WS by default. A naively wired gateway is an unauthenticated hole beside a carefully locked door.

Two requirements, both tested adversarially:

1. **Authenticate the upgrade.** Resolve a session cookie or an `Authorization: Bearer` header on the upgrade request; reject the handshake if neither resolves.
2. **Authorize the subscription, not merely the connection.** A user may subscribe to `submission:<id>` **only if they own it**. Otherwise any signed-in user watches anyone's grading in real time.

**Credentials travel in the `Authorization` header, never in a query string.** `?token=…` works everywhere and writes the credential into access logs, proxy logs and browser history — reintroducing precisely the defect Phase 0's final review closed as Critical. Browsers cannot set headers on a WebSocket, so they use the cookie; programmatic clients set the header. No third mechanism is admitted.

Bearer is accepted on WS because the CLI will need `oj submit --watch`, and admitting it now is cheaper than retrofitting it.

### Event flow

```
judged ── writes event rows ──► Postgres   (transaction commits)
             │
             └── SubmissionEvents.publish(id)   ← only callable post-commit
                        │
                     Redis pub/sub
                        │
   api ── subscribed ───┘── fans out to topic  submission:<id>
                                     │
   browser ── receives { id, state } ┘── re-fetches GET /submissions/:id
```

The topic carries a **wake-up signal, not data**. Two consequences, both deliberate:

- Authorization lives in exactly one place — the HTTP endpoint, where it already works.
- Reconnect is trivially correct: fetch current state, then subscribe. No event-sequence resumption to get wrong.

**Deviation from the foundation spec.** §11 specifies "reconnect with a last-seen event id so a dropped connection catches up." Phase 1 replaces that with state re-read on connect. It is idempotent, cannot drift, and removes a sequence-tracking mechanism that would have to be correct across restarts. Recorded here rather than left to be discovered.

The topic never carries submission source; a test asserts it.

---

## 7. The browser

One screen: problem statement as plain text, a `<textarea>`, a language `<select>`, a submit button, and a verdict panel progressing `queued → compiling → running 3/3 → Accepted`.

Plain elements and plain CSS. **No component library and no i18n library** — both remain open product questions from foundation spec §15, and a "minimal" page is exactly where one gets adopted by accident and becomes load-bearing.

This phase finally gives the Phase 0 login form a consumer; until now it had tests and no caller.

---

## 8. Testing

Four suites, each aimed at a distinct failure mode.

**Wire codec.** Round-trip the real framing (4-byte big-endian length + zlib + UTF-8 JSON) against captured fixtures, including a malformed frame and one exceeding the size cap. No judge required. Fast, and the one place where being wrong fails silently.

**Fake driver — all semantics.** Leasing, expiry and requeue, fenced stale attempts, duplicate delivery, cancellation mid-grade, terminate-on-expiry. In-process, no containers, runs on every commit. These are the safety properties, and they are testable *because* the driver is abstracted.

**WebSocket authorization — adversarial.** Non-owner refused, unauthenticated upgrade refused, bearer accepted via header, query-string credential rejected, and an assertion that the topic never carries source. Same exact-set discipline as the foundation's organization leakage matrix.

**Real judge, end to end.** A container grading accepted, wrong answer, and compile error. Slow, requires an image pull, and **not run on every commit** — a script plus a scheduled CI job, matching foundation spec §12's treatment of `judge-server` integration.

### Honesty requirement

The end-to-end suite is the one that proves the phase works, and it is the one that will not run in normal CI. **The acceptance task must run it and paste its real output.** Phase 0 established why this matters: building the Dockerfile for real caught two defects that reading it could not, and verifying the migration path under `--network none` proved something a code review could only assume.

---

## 9. Deployment

`docker-compose.yml` gains `redis`, `judged`, and a `judge` service. `judged` publishes no route through Caddy — it is reached by judges over the internal network, and reaches Postgres and Redis. Its `/healthz` endpoint is internal to the compose network, for the healthcheck only.

The `judge` service runs `judge-server`'s tier1 image with the seeded problem directory bind-mounted read-only.

**Phase 0's compose stack has never been run** — no compose provider existed on that machine. `podman-compose` is now installed, so **the first task of this phase is to run the existing stack, execute the smoke test Phase 0 specified, and fix whatever falls out.** Discovering a broken compose file before building on it is much cheaper than discovering it while debugging a judging bug.

---

## 10. Decisions that would otherwise be left open

**C++ only.** The tier1 image carries many runtimes; Phase 1 seeds exactly one `language` row (`cpp17`, mapped to the driver's executor key). Adding runtimes is configuration and belongs to whichever phase needs them. One language keeps the executor-key mapping table honest by exercising it without pretending it is general.

**`judged` exposes a minimal HTTP health endpoint** (`/healthz`, liveness only), so the compose healthcheck has something direct to probe. Inferring liveness from Postgres lease activity is indirect and would report a `judged` with a dead driver as healthy.

**Seeded problem limits: 1000 ms, 65536 KB.** Conventional defaults, generous for A+B, and small enough that a runaway submission fails fast during development.

## 11. Deferred to later phases, recorded so they are not rediscovered

- `judge-agent` and fetch-by-hash package distribution → Phase 2, with the package system.
- Priority classes, per-user round-robin, invocation capacity reservation → Phase 4, when contests create contention.
- The native pull-based driver and its Judge API → whenever the in-house judge is built.
- Multiple language runtimes → the phase that needs them.
- Redis Streams or any durable event log, should `api` ever run more than one replica.
