# Phase 5h — my/all submissions links, per problem and per contest: ledger

**Trigger:** the user: "I want for each problem to have my submission,
all submission as hyperlink, same for each contest."

## What shipped

- **`GET /submissions?contest=<key>`** — a new filter meaning
  *submissions made INTO the contest* (rows in `contest_submissions`),
  never practice submissions that merely target its problems.
  Case-insensitive key; unknown key is an empty page (the
  existence-oracle rule the user filter already follows).
- **Problem page**: `All submissions` (`?problem=`) and, signed in,
  `My submissions` (`?problem=&user=me`).
- **Contest page**: the same pair keyed by `?contest=` beside the
  scoreboard link.
- The submissions screen gained a contest filter input and an
  `initialContest` deep-link seed.

## The discriminating test

The golden-contest seeder builds real `contest_submissions`; the test
then inserts a **practice submission on one of the same problems**. A
filter implemented as "submissions to this contest's problems" — the
plausible wrong reading — passes everything else and fails on that row.
The mutation implementing exactly that wrong reading fails 1 test; the
filter dropped entirely fails 2.

## Mutation evidence (isolated, restored green after each)

| Mutation | Result |
| --- | --- |
| filter by contest's problems instead of contest_submissions | 1 fail |
| contest filter dropped (API) | 2 fail |
| My-submissions link shown signed-out | 3 fail |
| initialContest never sent (web) | 1 fail |
