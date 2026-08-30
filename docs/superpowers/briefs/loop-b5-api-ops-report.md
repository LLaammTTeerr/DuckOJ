# B5 — bug hunt: API contracts, guard, ops paths (2026-08-29 feature/bug loop)

Read the guard/contract/ops surface, probed the live stack with `bh5-20936`, and **mined Caddy's own access log** —
where B4's open 502 actually was. Six fixes, three cleared with evidence, D50 (D51–D52 reserved, unused). Every
behaviour test red first; five mutants run. Ritual green: **1378 tests**, regen with no diff, `vite build`.

## Fixed (repro → fix)

1. **`21d9c90` — B4's `GET /submissions/NaN` 502 was a DNS blip, not the API.** Caddy logged it verbatim: `dial tcp:
   lookup api on 10.89.0.1:53: server misbehaving`. `RestartCount 0`, no worker ever exited — `reverse_proxy
   api:3000` dials a *hostname*, so Go re-resolves against podman's aardvark-dns on every dial that cannot reuse a
   pooled connection. The log holds **896 more 502s**, all `connect: connection refused` across three container IPs:
   every redeploy turns healthy traffic into gateway errors. Both are dial failures — nothing was written upstream,
   so retrying is safe and re-resolves the name: `lb_try_duration 10s` + `lb_try_interval 250ms` on each of the
   three proxies, since the policy is per-directive.
2. **`7504842` — the keep-alive invariant, latent.** Node closes an idle connection at 5s, Caddy holds one for 2
   minutes: the proxy was structurally the last to know. **Not a live repro** — 560 probes across the boundary found
   nothing, Go retrying requests that die on a reused idle conn. Fixed both ends: server 185s, Caddy `keepalive 60s`.
3. **`363de1f` — B3's concern: a dead judge pinned its submission for 300s–30min.** `socket.on('close')` told the
   driver nothing, and `dispatch()` had resolved when the request went *on the wire*, so no promise was left to
   reject. New channel: `dispatch(job, emit, abandon?)` — deliberately **not** a `GradingEvent`, since an
   `internalError` there writes a permanent IE onto a student's submission (B2's shape from the other direction) ·
   `BridgeServer.onDisconnect` on FIN, `sweep()` reap and same-id displacement, never on `close()` · driver retires
   the job, frees the connection, wakes parked dispatches · worker rejects `JobAbandoned` and calls the new
   `JobStore.release`, which bumps `attempt` like `reclaimExpiredLeases`. Over a real socket and end to end with
   Postgres: `queued`, null lease, attempt 2, verdict still null — inside 15s of a 300s+60s baseline.
4. **`90183f5` — `readyz` did not answer 503 under a partition; it did not answer at all.** A rejecting DB and a
   dead port were always fine (RST in 7ms), but a DB that *accepts and says nothing* has no bound anywhere: the
   probe hung, which an orchestrator reads as the API being wedged, while each hung probe holds one of ten pool
   connections. `READY_TIMEOUT_MS` (3s, under the compose interval) now races it. Redis stays unchecked on purpose
   — the subscriber retries by design, and only live updates degrade, into polling.
5. **`e04d056` — three documented headers were unreadable by any cross-origin browser.** `fetch` exposes only the
   CORS-safelisted set and `enableCors` named none, so `Retry-After` (in the OpenAPI document for register/login),
   `X-Scoreboard-Cache` (D25's whole reason for a header) and `x-request-id` all returned `null` to the one client
   CORS exists for. Live: ACAO and `Vary: Origin` present, expose-headers absent.
6. **`ca64dc1` — F3 confirmed: the e2e scripts read the dead `COMPOSE_PROJECT` alias.** M4 fixed `backup.sh` and
   `restore.sh` and missed these two, so following the runbook's own worktree instruction (`export
   COMPOSE_PROJECT_NAME=duckoj`) kills both with "no postgres container found for compose project 'agent-…'".

## Cleared, with evidence

- **`0517c93` D50 — `GET /packages/{hash}` answering a plain session is the design.** `ScopeGuard` returns
  true for `via === 'session'` before reading metadata; scopes narrow a machine credential and there is nothing to
  narrow an interactive owner down from. Already pinned by `scope-matrix.spec.ts` (every scope × 4 credential
  kinds). The runbook still said "`Actor.scopes` is still read by nothing" — pre-`ScopeGuard`; corrected.
- **`6b5b6b5` F-4's `0020` gap is cosmetic.** Journal lists exactly the 21 `.sql` files, one snapshot each,
  `idx`/`when` strictly increasing, chain intact; drizzle-kit's next index is `lastEntry.idx + 1`, so it hands out
  `0022`. Proven from zero on its own throwaway Postgres.
- **`628a775` every route walked, and it is clean.** 72 operations × 6 malformed shapes (repeated query keys →
  arrays, bracket-notation objects, truncated JSON, unknown content-type, 4KB/astral values, `NaN`/`../..` params)
  against the real composition root: **no 5xx, no undocumented status, every 4xx `application/problem+json`**. A
  guard, not a finding; a vacuity check (>300 sent, ≥1 2xx, <50% 401) stops it passing on a dead session. And
  `X-Scoreboard-Cache` is correctly absent on error paths — the throw precedes `res.setHeader`.

## Concerns

- **The live stack runs none of this until merge** — redeploy-window 502s continue there. Nothing was stopped,
  rebuilt or redeployed; `bh5-20936` remains on it.
- Mutants: `onDisconnect` unwired (reds both judge tests) · `release` dropped (reds the DB one) · `withDeadline`
  removed (readyz hangs to the runner's timeout) · a journal entry deleted (reds 3 of 5) · a throwing controller.
