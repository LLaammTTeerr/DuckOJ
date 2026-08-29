# P1-C — scoreboard freeze window

**DONE_WITH_CONCERNS.** `cb06591` contest-formats + D22 · `f646d40` API/contracts ·
`8e2e8ef` web freeze UI · `243b5f6` the D21 rejudge hint, plus this report.
The brief's D19 was taken (bootstrap-admin), so the freeze ruling is **D22**.

## Shipped
1. **`packages/contest-formats`** — `lower(input, semantics, now?)`. The freeze instant is
   `participation.end − F·60s`, per participation, so a virtual entrant's freeze is shifted
   by their own start; a row is frozen for `now ∈ [freeze, end)`. In-window submissions
   dated at or after it are dropped from scoring and counted into
   `LoweredParticipation.pending`. `isFrozen` is real, `frozenAt` is derived, and the four
   formats take `now` through `computeContestScoreboard`. **All 23 goldens byte-identical.**
2. **API** — `getScoreboard` passes `new Date()` unless `canRunContest`; the organiser's
   live board is "no clock", not a second code path. `scoreboardForSystem` passes nothing.
   `Scoreboard` gained `frozen`/`frozenAt` and per-row `pending`; `contest_freeze_unsupported`
   is gone from the service, the contracts and the two schema comments, replaced by
   `assertFreezeFits` (422 `contest_freeze_too_long`) on create and on the merged edit state.
3. **Web** — `role="status"` banner *"Bảng điểm đang đóng băng từ HH:MM"* keyed in both
   locales (`scoreboard.frozen`), a new `formatTime` beside the other Intl helpers, `?+n`
   cells, and a freeze field on both contest forms (`contestNew.freeze`).
4. **D21 hint** — `rejudge.reRate` on `submission.tsx` (its own status line) and
   `problem-edit.tsx` (appended to the queued line, so one live region speaks at a time).

## Tests
New `packages/contest-formats/test/freeze.spec.ts` (15), `apps/api/test/contest-freeze.spec.ts`
(10), `apps/web/test/contest-freeze.spec.tsx` (5), plus two D21 cases in `rejudge.spec.tsx`.
`contests.spec.ts`'s and `contest-edit.spec.ts`'s freeze refusals were retargeted at the new
rule. **29 mutants run, 29 killed** (11 formats, 6 API, 8 web freeze, 4 D21) — including
"contest end instead of participation end", "freeze stays on past the end", "organisers get
frozen too", "rating replay reads a frozen board" and "edit validates the patch, not the
merged state". Full ritual green: **1046 tests, 0 failures**; regen leaves no diff;
`vite build` clean.

## Rulings (all in D22)
- **Omitting `now` means no freeze.** One default serves the privileged viewer and the rating
  replay; a default that froze on a forgotten argument would fold a half-board into ratings.
- **Per-participation freeze instant**, which conflicts with the brief's own "unfreezes for
  everyone at `end_time`" for a virtual still running past it. The specific clause won.
- **`pending` is a row field, not a `format_data` field** — a problem whose only submissions
  are inside the window has no cell to hang a count on. An out-of-window submission is void,
  never pending.
- **Filtering is the whole of the freeze**, so `icpc`'s `frozen_*` mirror the served board
  instead of freezing an already-frozen one (that branch would have zeroed the published
  score). `is_frozen` on a cell now means "this cell hides attempts"; the dead DMOJ branch went.
- **`frozen`/`frozenAt` are camelCase** in a snake_case object: the snake_case fields are the
  goldens' shape, these two are ours. `frozen` is true iff a *ranked* row is frozen.
- 422 `contest_freeze_too_long` for `F ≥ duration` (the brief's number), beside 400 neighbours.

## Concerns
- **The freeze is computed, never enforced upstream.** Every submission row still reaches the
  API; only the scoreboard filters. Any future endpoint that reads contest submissions has to
  freeze itself. `GET /contests/{key}/me` and the submission list are already such holes: a
  competitor can watch their own late verdicts, and so can anyone reading `/submissions`.
- **`frozen` is a board-wide flag** while `pending` is per row, so a viewer whose own row is
  not frozen still sees the banner. Truthful ("this board hides something"), possibly confusing.
- Nothing extends a freeze past `end_time` for a contest still under review; D22's
  "unfreeze at the end" is unconditional.
- 400 vs 422 now split within one method: `contest_window_invalid` is 400 and
  `contest_freeze_too_long` is 422, both from the same brief, both verbatim.
