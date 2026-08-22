# Phase 5b — rank bands (D6): ledger

**Spec:** D6 in `docs/DECISIONS.md`; roadmap item 1 in
`docs/superpowers/specs/2026-08-22-remaining-roadmap.md`.

## What shipped

- `packages/glicko2/src/bands.ts` — `RANK_BANDS` (ten Codeforces-shaped
  placeholder bands) and `rankBand(rating)`. Pure data behind one
  function; renaming is an edit to the table.
- Profile page shows `"<Title> · <rating>"`. Text only.

## Rulings

- **R1 — no coloured usernames.** The approved design reserves colour
  for verdicts (app.css structural rule 1), so the band's `color` field
  is carried but unrendered. Cost if wrong: a design pass later; nothing
  structural.
- **R2 — bands live in `packages/glicko2`.** Product config, not rating
  math — but it is pure, zero-dep, and both api and web can import it.
  A one-file move if a better home appears.
- **R3 — CF thresholds on a Glicko-2 scale are knowingly misaligned.**
  Glicko-2 starts everyone at 1500 ("Specialist"); Codeforces starts
  near 1400. D6 says placeholder, so the misalignment is accepted and
  documented rather than half-corrected.

## Mutation evidence

First attempt was **contaminated**: `git checkout --` cannot restore an
untracked file, so three seds stacked silently and later runs failed for
the wrong reason. Redone with `cp` backups, each in isolation:

| Mutation | Result |
| --- | --- |
| `>=` → `>` in `rankBand` | 2 tests fail |
| threshold 1200 → 1250 | 1 test fails |
| bottom band `-Infinity` → `0` | 1 test fails |
| profile renders bare number, no title | 1 test fails |

Pristine restored and re-run green after each.

## Hygiene

Removed a stale `eslint-disable-next-line no-unused-vars` in
`apps/api/test/config.spec.ts` (the only lint warning in the repo).
