# Phase 5e — admin screens: ledger

## What shipped

- `apps/web/src/routes/admin.tsx` at `/admin` — grant a global role;
  rate/unrate any contest from the list. Nav shows `Admin` only to an
  admin (courtesy; both endpoints re-decide server-side).
- `ContestSummary.isRated` — new contract field threaded through
  `toSummary`. It existed only in the database; the admin screen is its
  first reader, and it is ordinary public information on every judge.

## Rulings

- **R1 — the replay count is shown back, verbatim.** `contestsRated: 7`
  after rating one contest is how an admin learns what "replay the
  whole history" means. The mutation pinning this (message invents "1")
  fails a test.
- **R2 — no contest-key free-text input.** Rating is per-row on the
  visible list; typing a key invites rating the wrong contest with no
  confirmation step.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| role gate dropped (setter sees panel) | 1 fail |
| Rate offered regardless of `isRated` | 1 fail |
| success message fakes the replay count | 1 fail |
