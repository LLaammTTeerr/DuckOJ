# B33 — bug hunt: notifications & realtime (2026-08-31 loop)

**Status: DONE_WITH_CONCERNS.** Branch `worktree-agent-a0fed89f2ffe93be9`, not pushed. One ruling **D137**; D138/D139 unused, no migration. 4 fixed + 4 cleared, each fix red-first, re-mutated, one commit each.

## Fixed (repro → fix → mutation)

1. **MED-HIGH `c9dd851` — both WebSocket caps were checks on a value the burst had no time to change.** `subscribe` reads
   `subscriptions.size` synchronously and `add`s only after `await getVisible` (three queries, the source, the case grid); `ws` emits
   every frame from one read synchronously and each handler is `void this.onMessage(...)`, so N frames back to back **all** pass a cap
   of 2 and all reach the database — the flood B-7's cap exists to make free. `watch-contest` shared it. Now a
   `pending`/`pendingContests` reservation taken before the await, released in a `finally`. Red **`[1,2,3,4,5]` to have length 2** and
   **`['ct-a','ct-b','ct-c']` to have length 1**; the `finally` has its own test (else four unseeable ids spend the cap forever).
2. **MED `75195b0` — a team was never told its own clarification had been answered (D137).** D119 widened the *read* to the squad
   citing a notification set that "already unioned the whole squad" — true of the publish broadcast only. A private answer fires one
   `notify(row.askedBy)`, so the reply sat in a feed the teammates had no reason to open. New kind `clarification_answered_team` ("của
   bạn" is false told to someone who did not ask), recipients read on the answering `tx`; `broadcastRecipients` excludes a **list**
   now, so the later publish cannot tell them twice. Red ×2.
3. **LOW-MED `4febbfb` — `org_members_imported` rendered as its raw kind.** The API writes ten kinds; `line()` knew nine, so an org's
   owners got an untranslated snake_case identifier. Case + vi/en keys (`by` is a user *id*, so it stays out of the sentence); the
   test is a **census** of every kind, so the next one trips it.
4. **MED `c394782` — a failed join-request notification stranded the request forever.** `join` wrote the row then notified outside any
   transaction, and the ask is idempotent by a partial unique index — so a request outliving its notification can never be re-raised:
   the re-ask finds the row, answers `requested`, tells nobody. One transaction now (`decideRequest`'s shape), the owner/admin filter
   into the WHERE (it serialised the whole roster, D58's collection unbounded again on the write side), one `notifyMany` not N
   inserts. Red `[{id:1}]` vs `[]`; mutation red again.

## Cleared, with evidence

5. **`bb80e27` — bounded and indexed at 64 000 rows.** `EXPLAIN (analyze)`: feed = `Limit → Index Scan Backward using
   notifications_user_idx`, 50 rows, **0.039 ms**, no Sort, no Seq Scan. Unread count = `Aggregate → Bitmap Heap Scan` via the same
   index, 0.459 ms over that user's 4 000 rows — linear in one person's rows, never in the table. Noted, not optimised: a partial
   index is a migration for no known cost.
6. **`a9837d9` — cluster fan-out is exactly once per client.** Two apps, one DB, one Redis (faithful: the session is in the DB, so one
   cookie authenticates on either worker). One publish → one frame per worker's socket. Mutation (send twice) red.
7. **`31a8a02` — one broadcast at `NOTIFY_CAP` is one statement.** 10 000 × 3 bound values = 30 000 against Postgres' 65 535 — arithmetic
   nobody redoes when a column is added, so now a test, not a comment.
8. **Bell, frames, self-notify.** query-core 5.101.4 `queryObserver.js:215` refetches on an interval only when
   `focusManager.isFocused()`, and the bell sets no `refetchIntervalInBackground` — no background polling; `setQueryData` on the
   shared key clears the count with the rows. ioredis 6.0.0 defaults `autoResubscribe: true`, so a mid-session outage re-`SUBSCRIBE`s;
   publisher and presence swallow. A frame is a signal, never data (D23) — freeze/D117 re-decide on the re-fetch. Self-notify is
   pinned on every producer that can.

## Rulings

- **D137**: a teammate gets a distinct kind, and whoever was told is excluded from the later publish.
- **Mark-one and keyset pagination do not exist and were not built** (D14 is a 50-row feed with mark-all).
  `listFor`'s count and list are two statements with no shared snapshot, so a row landing between them can be
  counted and not listed for one render — accepted, one poll wide. And **a payload is a snapshot of what the
  reader was told then**: re-authorizing a row means re-reading every named resource on every poll of the bell.

## Concerns

1. A watch (and a subscription) is authorized once, at the frame: an organiser whose contest is transferred keeps receiving *signals*
   — a key they already know — for that socket's life. B-7's class.
2. #4's roster filter has no test of its own (behaviour identical to the `continue` it replaces, and `join` exposes no builder to
   compile-assert); and the cap is per broadcast, not per person, so eight rooms in one afternoon is eight notifications.

## Verify

`pnpm -r typecheck` + `:scripts`, `pnpm -r lint` + `:scripts`, contracts + SDK regenerated (no diff), `vite build` green. API alone, `--no-file-parallelism`: **1155/1155** (132 files, 737 s); web **618/618** (58); other packages **741** across 18 (db 62, judged 130 included). One casualty found by the ritual and fixed in `48c23de`: `notInArray` on its own line made the team-participation census attribute the hit to the operator, not to the allowlisted `broadcastRecipientsQuery` — `inArray` was already exempt for that reason.
