# Feature/bug loop (2026-08-29 →, autonomous)

Directive: "suggest feature and implement; hunt bugs; loop until the limit
runs out; no human interaction."

Each iteration N:
- **F-N** picks the highest-value missing feature from the backlog below
  (or proposes a better one, recorded), designs it in ≤10 lines, implements
  with TDD + mutation checks, i18n vi/en, contracts+SDK regen, commits.
- **B-N** hunts bugs in a rotating area (auth → contests → judging → web →
  ops → API contracts → …) by probing the live stack and reading code;
  every bug gets a failing test, a fix, and a report line with the repro.
- Controller merges, runs the full ritual, redeploys, pushes, ledgers, and
  starts N+1. A killed agent is resumed from its transcript, not re-run.

Backlog (strike when shipped): contest clarifications/announcements ·
problem tags + filter · TOTP recovery codes · editorials (per problem,
visible after solve or after contest) · real rank names (D6) · contest PDF
booklet (typst) · user settings (display name, preferred locale server-side)
· org-restricted contests · comments · submission source diff between
attempts · admin dashboard (queue depth, judge health) · problem statistics.

Ledger: `docs/superpowers/ledgers/2026-08-29-feature-bug-loop-ledger.md`.
