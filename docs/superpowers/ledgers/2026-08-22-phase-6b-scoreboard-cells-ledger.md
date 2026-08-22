# Phase 6b — scoreboard cell detail: ledger

## What shipped

Pure UI — the data was already on the wire. `format_data` has carried
per-problem `points`/`time` (all formats) and `tries` (icpc) since 4c;
the screen showed points only. One `cell()` renderer now shows:

- icpc: attempt-ledger convention — `100 (+2, 55m)` solved on the third
  try, `−2` two failed tries unsolved, `—` untouched.
- other formats: `points · minutes` beside a nonzero score.

## Ruling

- **R1 — tries discriminates icpc, not the format name.** The renderer
  keys off `tries === undefined`, which the contract documents as
  "icpc only", so the screen needs no knowledge of format names and a
  future format that emits tries gets the ledger for free.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| `+tries` off by one | 1 fail |
| unsolved tries rendered as `—` | 1 fail |
| seconds shown instead of minutes | 2 fail |
