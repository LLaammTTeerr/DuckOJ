# P8 — the scoreboard now folds at most once per key per two seconds

**DONE_WITH_CONCERNS.** Cache, invalidation and tests shipped; ritual green.
**The k6 pass was not run** — compose publishes no host port for postgres or
redis, the brief's own skip condition. No before/after p95 here.

## Shipped

- `apps/api/src/authz/scoreboard.cache.ts` — key derivation, coalescing, and
  `RedisScoreboardCacheStore`: lazy connect, `enableOfflineQueue: false`,
  `SET … PX 2000`, one log line per outage — `RedisSubmissionPublisher`'s shape.
- `contest.access.ts` — `getScoreboardCached` wraps the fold, `getScoreboard`
  delegates. **One `new Date()` per request** now decides the 409, the key and
  the freeze, where there were two. `scoreboardForSystem` stays uncached, and
  `contests.controller.ts` sets `X-Scoreboard-Cache: hit|miss` — header only.
- Invalidation after the write commits: `setDisqualified`, `update` (old ∪
  merged key sets), `RejudgeService.announce` (a `selectDistinct` over the
  requeued submissions' contests — *not* rated-only, a different question).
  Providers in `authz.module.ts`; D25 in `docs/DECISIONS.md`.

**Key derivation is the whole safety argument.** `now` reaches the fold in one
place only (`isFrozenAt`, per participation), so the board is piecewise
constant in `now`. Key = `(contest id, privileged | public, phase-start
instant)`: privileged is folded with no clock, so it is one key; public carries
`0`, the freeze instant, or the end. Both comparisons come from `window.ts` —
D22 and D23 each record a bug from a second derivation of that predicate.
Per-participation boundaries (virtual, time-limited) ride the 2 s TTL.

## Tests — 27 new, each shown red before green

- `scoreboard-cache.spec.ts`, 23 tests, red first (module absent). Five
  mutations: drop the `set` → **2 red**; drop coalescing → **3 red**; `>=`→`>`
  at the end boundary → **2 red**; re-derive the freeze boundary by hand
  instead of `isFrozenAt` → **3 red**; drop log-once → **1 red**.
- `contest-scoreboard-cache.spec.ts`, 4 tests over HTTP against a real Redis
  (`flushall` per test — test DBs restart contest ids at 1 against one shared
  Redis). Mutations: no disqualify invalidation, no edit invalidation, and
  privileged sharing the public key → **1 red** each; hard-coded header →
  **3 red**. Restored green.
- `scoreboard.fixtures.ts` — `uncachedScoreboards()` for the 30 sites building
  the service by hand: the cache with a Redis-down store, as every other spec
  runs. Ritual green, `-r test` **1110 tests, 0 failures**, regen **no diff**
  (header-only, contract untouched), `vite build`.

## Rulings (nobody to ask; all in D25)

1. A verdict from `judged` rides the TTL: the event writer is a separate
   process with no path into the API's cache.
2. `ScoreboardCache` swallows a rejecting store, not just the store swallowing
   Redis: a cache may never fail a request. Coalescing survives an outage.
3. Skipping k6: `podman port duckoj_postgres_1` / `… _redis_1` print nothing,
   runbook L50–52 agrees, 10.89.0.2 is refused from the host (rootless netns).

## Concerns

- **Unmeasured.** A correctness argument, not a p95. The next load pass owns it.
- A fold in flight when a write commits can still store the pre-write board for
  one TTL. In D25, not closed: it needs a cross-worker epoch read per request.
- `update` deletes the old key set as well as the merged one; only the merged
  half is tested. The old-boundary half is defensive and unobserved.
