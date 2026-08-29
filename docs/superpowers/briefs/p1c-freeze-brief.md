# Task P1-C — scoreboard freeze window

Read `docs/superpowers/briefs/conventions.md` first. Work on main
(no worktree). The contest edit route (`PATCH /contests/{key}`) and
disqualify landed just before you — read `git log -5` and the report
`docs/superpowers/briefs/p1a-ops-api-report.md`.

## Ruling (D19 — write it into DECISIONS.md)
`frozen_last_minutes = F > 0` means: for `now ∈ [end_time − F·60s, end_time)`
non-privileged viewers see the scoreboard computed from submissions with
`submission_time < end_time − F·60s` only, plus a per-cell "pending
attempts" count for submissions inside the window; the response carries
`frozen: true` and `frozenAt`. Contest creator + global admins always see
the live board (`frozen: false`). At `now ≥ end_time` the board unfreezes
for everyone. Virtual participants: their window is shifted by their own
start, apply the same rule relative to their own end.

## Work
1. `packages/contest-formats`: `lower()` takes an optional `now: Instant`
   (and `frozenLastMinutes` no longer throws). When frozen, filter
   submissions as above and expose `pending` per cell; `isFrozen` becomes
   real. Add goldens/tests with an injected clock: before window, inside
   window (hidden + pending count), after end (revealed), admin view.
   Existing 23 goldens must stay byte-identical (they pin `frozen_last_minutes: 0`).
2. API: `ContestAccess.getScoreboard` passes `now` + privilege; response
   schema gains `frozen`, `frozenAt`, and per-cell `pending`. Contest
   create/edit accept `frozenLastMinutes ≥ 0` (< duration in minutes, else
   422). Remove the "must be 0" write-time refusal and its doc comments in
   `packages/db/src/schema/guarded.ts`.
3. Web: scoreboard shows a banner "Bảng điểm đang đóng băng từ HH:MM"
   (English fallback string is fine — a later i18n task will key it; put
   the string in ONE place), pending cells as `?+n`. Contest new/edit forms
   get the freeze field.
4. Tests red→green for each layer.

## Done means
Full verify ritual green, committed on main, report to
`docs/superpowers/briefs/p1c-freeze-report.md`.
