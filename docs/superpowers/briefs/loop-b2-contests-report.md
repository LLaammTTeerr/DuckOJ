# B2 — bug hunt: contests (2026-08-29 feature/bug loop)

Read every contest route end to end (`authz/contest.*`, `participation`,
`scoreboard.cache`, `submission.freeze`, the formats, `rating.service`, the screens)
and probed the live stack with throwaway `bh2-*` accounts and contests. Nine findings,
all fixed, a commit each; D36–D38 used; each red first, then re-mutated. Ritual green
first try — 16 packages, 1192 tests, regen with no diff, `vite build`.

## Fixed (live repro → fix)

1. **`7a44d34` D36 — one competitor pressing "join" twice bricked a contest's
   scoreboard, for everyone, permanently.** `mapContest` refused two participations
   under one username (409 `contest_duplicate_participant`), calling that unreachable
   "because joining is out of scope" and leaving the input key to "the phase that adds
   joining" — 4d added joining and never widened it. Live: join, join again, board →
   **409, forever**; a live entrant replaying virtually does it too; and it poisons
   `scoreboardForSystem`, so one such contest flagged rated wedges `rate` for *every*
   contest. `ParticipantSpec`/`SubmissionSpec` gained an optional `participation_id`
   `lower()` keys on; all 27 goldens omit it, byte-identical.
2. **`ebe0612` — a pre-start contest's clarification feed named its problems.**
   `GET /contests/{key}` serves `problems: []` and the scoreboard 409s pre-start lest a
   private problem's code leak; the `@Public()` feed handed an anonymous caller a
   `problemCode` off an announcement. Text publishes, code waits.
3. **`361c856` — the submit refusal read that concealed list back.** The pairing check
   ran before the participation check, and pre-start nobody can join: 400
   `problem_not_in_contest` outside vs 403 `contest_not_joined` inside, one probe per
   code. Participation first now.
4. **`37ddd6b` D37 — a disqualification was undone by one more POST.** `join` minted a
   clean row that `resolveContestTarget` prefers, so the expelled competitor was back
   on the board, submitting. A join inherits the flag now.
5. **`a6d5f8b` D38 (m4) — a running contest's `startTime` was editable, silently.**
   Live: board reads `submission_count: 1`; `PATCH {startTime}` two hours forward
   answers 200 and it reads **0**, `lower()` having voided an out-of-window submission.
   Frozen once started; `endTime` still moves, the organiser's real lever.
6. **`e8c5d7c` m5/m6 + `4dd777d` m23/m17 — four web minors.** `datetime-local` shows
   minutes, so a stored `10:00:37Z` saved back `10:00:00Z` — `endTime` 59 s earlier,
   voiding a last-minute submission; an untouched field now sends its exact instant. An
   emptied freeze box silently PATCHed `frozenLastMinutes: 0`. The submit page never
   named its contest, and the freeze banner printed the *contest's* `frozenAt` bare.

## Cleared, with evidence

- **Rating fold under D36** (`5b23a62`): `rankedFieldFor` keeps only `virtual === 0` —
  new test, a rated 9-person contest plus the winner's virtual attempt still yields 9.
- **Freeze boundaries:** `freezeAtMs`/`isFrozenAt` are the one derivation behind
  `lower()`, the cache key and `isSubmissionFrozen`; `freeze.spec.ts` (15) and the
  millisecond deadline test pin closed-at-freeze/open-at-end — no off-by-one anywhere.
- **Scoreboard cache:** `publicBucket` names only the contest's phases (a shifted
  participation's ride the 2 s TTL, D25); invalidation covers disqualify, edit (old
  *and* merged keys), rejudge. **`?contest=`** only narrows a `visibleSubmissionsWhere`
  set (D24); `setRated`'s `key = lower(key)` is inert (`CONTEST_KEY` is lowercase-only);
  post-end and closed-window submits answer 403 `contest_window_closed`.

## Rulings / concerns

- D38's residual: shrinking a running `endTime` still voids later submissions,
  deliberately and unwarned; refusing only destructive shrinks needs a write-path query.
- **The live stack still runs the old code**, so `bh2-dq-aea089`'s scoreboard 409s
  there until this merges — finding 1, in production. `bh2-*` accounts, five contests
  and some submissions remain; nothing stopped or rebuilt, no migration needed.
