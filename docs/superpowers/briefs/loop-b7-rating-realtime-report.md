# B7 — bug hunt: rating, users/profiles, realtime + the three B-6 leftovers (2026-08-29 loop)

Attacked what nobody had bounded: **collections with no limit**, **retry loops with no evidence behind them**,
**validation that looks like it means something and does not**. Seven commits, each red-first and re-mutated.
Three rulings, D58–D60 as reserved; no migration, 0024 unused. Ritual green: typecheck, lint, `pnpm -r test`
(apps/api **714 tests**), regen no-diff, `vite build`. Live stack probed read-only via one throwaway `bh7-*`
account; never restarted.

## Fixed (repro → fix)

1. **`73fd46c` — an organization's roster was unbounded (D58).** `listMembers`/`rosterOf` serialised every
   `org_members` row into one array, as did the four writes answering with the roster. Now a keyset page on
   `username` (the sort column, so it is stable under concurrent joins), a 422 `invalid_cursor`, and the first
   page from a write. Red: **`['pg-e','pg-d']` vs `['pg-a','pg-b']`** — members join in descending order, so scan
   order is the opposite of the answer and `ORDER BY` cannot pass by luck. **It also exposed a bug it would have
   shipped:** the screen derived "am I a member?" from the roster, so a member past page 1 read as an outsider
   and was offered "Join". `OrgSummary` carries `myRole` now, one query per page. Red on that too.
2. **`e7af90d` — the announcement cap was a lottery (D59).** `.limit(NOTIFY_CAP)` with no `ORDER BY`: an over-cap
   room notified whatever the plan reached first, a *different* arbitrary subset each time, and nothing said
   anybody had been left out. Ordered, `cap + 1` fetched so truncation is detected, plus a `warn` naming the
   contest. Red on `expected false to be true` and on the compiled SQL (`… to match /order by/`) — the clause has
   no black-box proof: at test scale the planner picks Sort+Unique and emits ascending order anyway.
3. **`c0eaf1d` — `POST /packages` stored a package that could never grade (D60).** `upload()` parsed the manifest
   and threw the result away; the real file list and the manifest's promises were both in hand, never compared. A
   manifest naming `tests/01.out`, or a `checker: {kind:'source'}` never packed, was hashed and stored — refused
   only later at `attachRevision`. Red: **`201 to be 422`**, twice. Now 422 `package_manifest_incomplete`, through
   the same shared `findMissingPackageFiles`, before anything is stored.
4. **`2e2cd46` — one WebSocket could hold unlimited subscriptions and release none.** The set was append-only, and
   every `subscribe` frame ran a full `getVisible` — three queries, the source, the whole case grid — to answer a
   yes/no question, unthrottled. Now a 256 cap (injected, so it is proved at 2) checked *before* `getVisible`, an
   `unsubscribe` frame, a repeat re-acked without a query, and a non-integer id dropped. Red ×3.
5. **`c286a60` — a reconnect storm, once a second, forever.** `useSubmissionSocket` reset its backoff on `open`,
   which proves nothing: an API restarting, a proxy draining and the gateway's own shutdown all accept the upgrade
   then close it at once, so every tab hammered `/ws` at the first rung and the ladder past 1000 ms was unreachable
   in the one case it exists for. Reset on the `subscribed` ack. Red: `[5 sockets] to have length 4`.
6. **`a5dbbfb` — `"   "` was a valid display name.** Probed live: `PATCH /users/me {"displayName":"   "}` → 200,
   and the profile then renders an empty heading, an empty list cell, an empty clarification author. One shared,
   trimmed `DisplayName` now — settling the two rules that disagreed (64 vs 100) too. Red: `200 to be 422`.
7. **`113ad5a` — a failed rating request read as "never rated".** `user.tsx` folded every error into `[]`, rendered
   as *Chưa được xếp hạng* — a claim about a person made from a 500. Throws now. Red: no `role="alert"`.

## Cleared, with evidence

Glicko-2 extremes: the degenerate `v = ∞` branch needs a ~190,000-point rating gap for `e` to round to exactly 1;
probed at 9000 vs 1500 the fold stays finite, so there is no reachable NaN. Ties, zero-game players,
DQ'd/virtual/non-submitting exclusion, replay determinism, unrate-then-rate and `max_rating` after an unrate are
pinned already; rank bands are inclusive at every threshold. `likeEscape` escapes backslash first and `?q=%` returns
an empty page live; `ilike` folds Vietnamese case (`Đặng`/`ĐẶNG`/`đặng` all match). `/users` cursors are id-keyed;
`limit=0`, `cursor=abc` → 422. A frozen wake-up carries no data and `state` already moves under an ordinary poll,
so it discloses nothing D23 withholds; display names are React text everywhere.

## Rulings and concerns

- **`DisplayName` widens registration 64 → 100** to match the profile edit (narrowing would have made a stored name
  unsavable). It and the 256-subscription cap were deliberately **not** D-numbered: both are operational bounds
  beside `HEARTBEAT_INTERVAL_MS` and the 64 KB `maxPayload`, not product rules.
- **`/users/{u}/rating` is still unpaginated**, and **a caller may open unlimited WebSocket *connections*** — the
  cap is per socket, not per account. Both left alone: no padding.
- **Editing a rated contest's `end_time` reorders the fold and nothing re-rates** — consistent with D5, but the
  admin is never told to.
