# F11 — multi-judge scaling, done properly (2026-08-29 feature/bug loop)

Three commits, migration **0027**, **D68**. 118 judged tests green, regen
no-diff, `vite build`; eight mutants run and eight killed.

- **`scripts/judge-node.ts`** — `corepack pnpm judge:node add|list|revoke` (root
  `package.json` gained the one script line). `add` generates the token (no
  `--token`: argv is shell history) and prints it once. `revoke` **keeps the
  row**, overwriting `token_hash` with `revoked:<old hash>`: not valid hex, so
  `verifyJudgeCredential`'s length check fails it closed, still unique under
  `judge_nodes_token_idx`, and the row survives so `judge_node_id` keeps naming
  the machine that graded each submission.
- **Compose `judge-2` behind `profiles: ['scale']`.** `JUDGE_TOKEN_2` gets a
  placeholder default, **not** `:?`: podman-compose 1.5 interpolates the whole
  file *before* `_resolve_profiles`, so a required marker fails every plain `up`.
  `podman-compose config` (read-only, throwaway project) shows it absent by
  default, present under `--profile scale`.
- **Capability-aware dispatch.** `BridgeServer` keeps each connection's
  announced executors and writes `judge_nodes.capabilities` on handshake (that
  column was written by nothing — F5's report). `DmojDriver` picks an idle
  *capable* connection, parks while every capable one is busy, rejects
  `NoCapableJudgeError` when judges are connected and none can run it, and still
  parks on an **empty** fleet — a restarting judge must not fail work in flight.
- **The claim loop filters instead of refusing.** `Worker` passes
  `driver.supportedLanguages()` to `JobStore.claim`, which filters inside the
  oldest-first pick (`for update of grading_jobs skip locked`); claiming then
  refusing would re-claim the same row forever and starve the queue.
  `blocked_reason` (nullable text, not a state) is reconciled both ways by
  `markBlocked` on an empty claim (one scan/5 s/loop, skipped when no judge is
  connected); `claim` clears it as it claims.
- **`grading_jobs.judge_node_id`** (0027, `on delete set null`) written from the
  `dispatched` event's new `node` field: the node↔job join D47 declined.
  **`last_seen`** now follows any packet, throttled to 15 s (a sixth of D47's
  90 s threshold); stale "handshake and ping-response only" comments fixed.
- **A real bug, caught by the existing affinity suite:** the handshake recorded
  `problemSets`/`executorSets` *before* displacing a same-id reconnect, so
  `retire` wiped them and a redialled judge looked incapable ever after.

**Tests.** New: `multi-judge.spec.ts` (8, real sockets — two jobs concurrent on
two nodes, terminate only on the right one, a CPP17-only node never receiving a
py3 job, union vocabulary, capabilities recorded), `job-language-routing.spec.ts`
(11, Postgres), `worker-language.spec.ts` (5), `judge-node-script.spec.ts` (5,
subprocess), plus `event-writer.spec.ts` +2 and a reworked `bridge-auth`. Mutants
killed: capability filter removed (4 red) · claim filter neutered (1) ·
`blocked_reason` not cleared on claim (2) · `recordJudgeNode` dropped (1) · scan
throttle dropped (1) · `supportedLanguages` unasked (2) · `recordCapabilities`
unwired (1) · `revoke` deleting the row (1).

**Ruled (D68):** blocked jobs stay `queued` with a text reason; revoke burns
rather than deletes; `concurrency: 1` is recorded, not read; an empty fleet
parks while an incapable one rejects. **Left open:** `tryAcquireSlot` counts judges, not per-language slots, so a claimed job
may be runnable only by a *busy* judge — a parked dispatch, safe post-D29, but
"claimed ⇒ immediately runnable" weakens to "runnable by some connected judge".
**Outside the touch list, documented instead:** `compose-up.sh` waits only on
`judge`; `.env.example` has no `JUDGE_TOKEN_2`; the dashboard does not yet join
`judge_node_id` or show `blocked_reason`.
**Flake, not a regression:** `pnpm -r test` reds 2–6 `apps/api` tests per run, a
different set each time (timeouts; a 30 s cache TTL read as `miss`) on a box
running several agents' containers; all pass in isolation and `apps/api` is
untouched. Nothing stopped or redeployed; not pushed.
