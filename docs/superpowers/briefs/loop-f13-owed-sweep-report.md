# F13 — the owed-items sweep (2026-08-30 feature/bug loop)

Sixteen commits, no migration. **D72** new; **D58/D61/D66** amended in place
(only D72 was reserved, so the rest ride as dated amendment paragraphs).
Ritual green: `-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`,
`-r test` (**api 868, web 398, db 48, contracts 28, judged 118**), regen
no-diff, `vite build`. Red first, then mutated: **17 mutants, 17 killed**.

## Shipped, by owed item
1. **Homework CSV bounded** (`ee92eae` api · `4306f93` web · `e002454` docs).
   Still the whole roster — a file stopping at 25 pupils gets a class
   mis-marked — but walked in cursor pages of 500, capped at 20,000 rows,
   with a final `truncated,<rows>` line when it cut. Bounds injected
   (`PROGRESS_EXPORT_BOUNDS`), so the cap is proved at three rows. Grid and
   export now share ONE page query; "Tải thêm" is a button, not a sentence
   describing one.
2. **Rating history paged** (`7cc6d8d` · `772b9bf` · `5a1d5b8`). 100/page,
   keyset on `(contests.end_time, contests.id)`, 422 `invalid_cursor`; the id
   breaks the tie two divisions of one round make by ending on the same bell.
   Profile appends with `useInfiniteQuery`.
3. **D72** (`e1705b2` · `c31fba5` · `41326c0`). Confirm: 10/user/15 min, 429 +
   `Retry-After`, meter read BEFORE the code — a limiter the winning guess
   walks past is not one. `DELETE /auth/totp` takes `{password}`, 401
   `invalid_credentials`; the check sits in `disableWithPassword`, so an
   admin's `resetTotp` (holding nobody's password) still works.
4. **Import capped at 500 rows** (`7a9938e` · `28a7186` · `7144c8e` ·
   `4566aec`). 2,000 argon2id hashes held a request ~20 s — F8's own concern.
   The web panel now splits the file (progress bar, merged credentials, an
   alert naming the part that stopped and keeping what it created), using the
   SERVER's record grammar, moved to `@duckoj/contracts/org-import-csv.ts` so
   the two cannot disagree about a quoted newline. Meter reshaped to `allow`
   10/org/min — the same rows a minute as before; `consumeOnce` is not
   missed, since the duplicate submission it guarded dies on
   `users.username` inside `runImport`'s transaction (F8's collision test
   already pins that).
5. **Freeze reminder** (`2b7d2db`). A `role="note"` line beside the organiser
   answer controls while the freeze window is open. No mechanism change: an
   organiser sometimes must say "you are failing test 3".
6. **Dashboard** (`6350d49` · `0354486`). `judgedConcurrency: null` is an em
   dash with the reason as a tooltip. The hidden-tab pause needed no code —
   TanStack's `refetchIntervalInBackground` defaults false and its focus
   manager reads `visibilityState` — so it is pinned by a regression test on
   the real `AdminPage` (mutant `refetchIntervalInBackground: true` → red).

## Mutants killed
Trailer always/never emitted · export loop cut to one page · cap not applied
per page · keyset without the tiebreaker · `nextCursor` always null · "load
more" replacing rather than appending (×2) · meter keyed globally · meter
after the code check · password check inverted · disable enabled empty ·
warning always/never on · chunking off · duplicate scan off · partial
credentials discarded · header lost after chunk 1 · username read positionally.

## Concerns
- **The 20,000 cap is proved at 3, never exercised at 20,000**; the export is
  bounded now, still one response rather than a stream.
- **Cross-chunk duplicate usernames are refused by the WEB only.** A raw API
  caller can still strand a half-created sequence — the server cannot see
  across requests. Accepted, not fixed.
- B-9 landed `poll-visibility.spec.tsx` mid-session covering the hidden-tab
  rule generically; mine pins it on `AdminPage` itself. Mild overlap, kept.
- Under `-r test` contention `packages/db` failed 13/13 once ("relation users
  does not exist" — the container race) and `contest-booklet` /
  `contest-scoreboard-cache` (both TTL-timed) once. All pass alone; none of
  mine.
- Live stack untouched, nothing pushed.
