# Feature/bug loop ledger — spec: docs/superpowers/specs/2026-08-29-feature-bug-loop.md

## Iteration 1
- F-1: contest clarifications + announcements (main, opus).
- B-1: bug hunt — auth + accounts (worktree, opus).
- F-1 DONE_WITH_CONCERNS (e4172ee..792e9d2): clarifications/announcements, D31, migration 0017; deployed + pushed. Concern carried: answers not freeze-governed (organiser discipline).
- F-2 dispatched (main, opus): problem tags + difficulty + filters, migration 0018, D35.
- B-1 DONE, merged (09d0290): 8 auth bugs fixed (D32 reset revokes PATs, D33 TOTP begin cannot un-enrol, D34 single-use codes, session IP, expired-row sweeper, /users/me validation, register retry, oj chmod). api redeployed, pushed.
- B-2 dispatched (worktree, opus): contests area, D36–D38 reserved.
- F-2 DONE (8989cdc..0aee729): tags/difficulty/filters, D35, migration 0018; deployed + pushed. Tags not yet applied to live demo problems (F-3 does it).
- F-3 dispatched (main, opus): apply tags to live demo set; TOTP recovery codes, migration 0019, D39.
- B-2 DONE, merged (9deec85): 9 contest bugs (D36 double-join bricked boards, D37 rejoin cleared DQ, D38 startTime guard, clarification pre-start leak, edit-form drift…). api rebuilt from a clean HEAD export (F-3 has a dirty tree on main); web rebuilt; pushed.
- B-3 dispatched (worktree, opus): judging pipeline, D40–D42, migration 0020 reserved.
