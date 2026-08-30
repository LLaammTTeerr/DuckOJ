# B7 — bug hunt: rating, users/profiles, realtime + the three B-6 leftovers (2026-08-29 loop)

Read the area end to end, then attacked what nobody had bounded: **collections that
grow without a limit**, **retry loops with no evidence behind them**, and **validation
that looks like it means something and does not**. Six commits, each red-first and
re-mutated. Three rulings (D58, D59, D60); no migration, 0024 unused. Live stack probed
read-only apart from one throwaway `bh7-*` account; never restarted.

## Fixed (repro → fix)

1. **`73fd46c` — an organization's roster was unbounded (D58).** `listMembers`/`rosterOf`
   serialised every `org_members` row into one array, and so did the four writes that
   answer with the roster. Now a keyset page on `username` (the sort column, so it is
   stable under concurrent joins/departures), a 422 `invalid_cursor` for a cursor longer
   than a username, and the first page from a write. Red: `expected ['pg-e','pg-d'] to
   deeply equal ['pg-a','pg-b']` — members joined in descending order, so the physical
   scan order is the opposite of the answer and the `ORDER BY` cannot pass by luck.
   **Paginating exposed a second bug it would have shipped:** the org screen derived "am
   I a member?" by searching the roster, so a member sorted past page 1 read as an
   outsider and was offered "Join". `OrgSummary` now carries `myRole`, computed for a
   whole page in one extra query.
2. **`e7af90d` — the announcement cap was a lottery (D59).** `.limit(NOTIFY_CAP)` with no
   `ORDER BY`: an over-cap room notified whatever the plan reached first, a *different*
   arbitrary subset each time, and nothing said anybody had been left out. Ordered now,
   `cap + 1` fetched so truncation is detected, and a `warn` naming the contest and the
   clarification. Red on `expected false to be true` (truncation) and on the compiled SQL
   (`expected 'select distinct "user_id" from …' to match /order by/`) — the ordering has
   no black-box proof: at test scale the planner picks Sort+Unique and emits ascending
   order with the clause deleted.
3. **`c0eaf1d` — `POST /packages` stored a package that could never grade (D60).**
   `upload()` parsed the manifest and threw the result away; the archive's real file list
   and the manifest's promises were both in hand and never compared. A manifest naming
   `tests/01.out`, or a `checker: {kind:'source'}` whose source was never packed, was
   hashed and stored — refused only later at `attachRevision`. Red: `expected 201 to be
   422`, twice. Now 422 `package_manifest_incomplete`, through the same shared
   `findMissingPackageFiles`, before anything is written.
4. **`2e2cd46` — one WebSocket could hold unlimited subscriptions and release none.**
   `client.subscriptions` was append-only; nothing but closing the socket removed an id,
   and every `subscribe` frame ran a full `getVisible` — three queries, the source, the
   whole case grid — to answer a yes/no question, with no rate limit on that path. Now a
   256 cap (injected, so the bound is proved at 2), checked *before* `getVisible` so a
   flood past it costs nothing; an `unsubscribe` frame; a repeat re-acked without a
   database hit; and a non-integer/non-positive id dropped instead of parked in the set
   where it could never fire. Red on all three.
5. **`c286a60` — a reconnect storm, once a second, forever.** `useSubmissionSocket` reset
   its backoff on `open`, which proves nothing: an API restarting, a proxy draining and
   the gateway's own shutdown all accept the upgrade and close it at once, so every open
   tab hammered `/ws` at the first rung and the ladder past 1000 ms was unreachable in
   exactly the situation it exists for. Reset on the `subscribed` ack instead — the one
   frame that proves the connection did its job. Red: `expected [5 sockets] to have a
   length of 4`.
6. **`a5dbbfb` — `"   "` was a valid display name.** `z.string().min(1)` is satisfied by
   three spaces. Probed live: `PATCH /users/me {"displayName":"   "}` → 200, and the
   profile then renders an empty heading, an empty list cell, an empty clarification
   author. One shared trimmed `DisplayName` now, used by registration and the profile
   edit alike — which also settles the two rules disagreeing (64 vs 100) about a name the
   same account could hold but not have been created with. Red: `expected 200 to be 422`.

## Cleared, with evidence

Glicko-2 extremes: probed directly — the degenerate `v = ∞` branch needs a ~190,000-point
rating gap (`e` must round to exactly 1); at 9000 vs 1500 the fold stays finite and
correct, so there is no reachable NaN and nothing to fix. Ties, zero-game players,
DQ'd/virtual/non-submitting exclusion, replay determinism across runs, unrate-then-rate,
and `max_rating` after an unrate are all already pinned by `rating.spec.ts` and
`contest.spec.ts`. Rank-band boundaries are inclusive at every threshold (`bands.spec.ts`).
`likeEscape` escapes backslash before `%`/`_`, and `?q=%` returns an empty page against
the live stack; `ilike` folds Vietnamese case correctly (`Đặng`/`ĐẶNG`/`đặng` all match
one seeded account). `/users` cursors are id-keyed and stable; `limit=0` and `cursor=abc`
are 422. A frozen submission's realtime signal carries no data, and `state` already moves
under an ordinary poll, so the wake-up discloses nothing D23 withholds.

## Rulings and concerns

- **D58's `myRole` widens `OrgSummary` for the list too**, computed in one extra query
  per page rather than per row. It says only what the caller knows about themselves.
- **`DisplayName` widens registration from 64 to 100** to match the profile edit; the
  narrower direction would have made a stored name unsavable.
- **`/users/{u}/rating` is still unpaginated** — bounded by the number of rated contests,
  so it is small today, but it is the last list in the API with no cursor.
- **Editing a rated contest's `end_time` reorders the fold and nothing re-rates**, so
  `rating_events` and `users.rating` drift from what a replay would produce until an
  admin re-rates. Consistent with D5 (rating is manual), but there is no signal telling
  the admin to.
- **A signed-in caller may still open unlimited WebSocket connections**; the cap is
  per connection, not per account.
