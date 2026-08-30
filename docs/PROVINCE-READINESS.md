# DuckOJ — province readiness (2026-08-29)

What a province IT team gets, what it must supply, and what is still open.
Campaign record: `docs/superpowers/ledgers/2026-08-29-province-ready-ledger.md`;
review: `docs/superpowers/briefs/final-review.md`; decisions D16–D30 in
`docs/DECISIONS.md`.

## What works today (all proven on the live stack)

- **Accounts**: register page (vi/en), login with optional TOTP, password
  reset by mail, admin TOTP reset for a lost authenticator, login and
  registration rate limits (D16, D26).
- **Problems**: Polygon import → package → publish; statements in
  Vietnamese + English; PDF statements (typst); source-access policy per
  problem; rejudge one submission or a whole problem (D21).
- **Contests**: create/edit (diff-safe after start, D28), join, virtual
  participation, ICPC/IOI/default formats, scoreboard **freeze** with
  per-viewer masking on every route (D22, D23), disqualify, rating (manual,
  D5), five demo problems + a demo contest.
- **Judging**: DMOJ sandbox behind `judged`; batched points, dataset-aware
  ceilings, attempt fencing, targeted cancel (D29); 5×AC + WA verified live.
- **UI**: Vietnamese by default, English toggle (D18); every entity is a
  link; phone layout; 8 Playwright journeys green against the live stack.
- **Ops**: reboot-proof (`deploy/duckoj.service` + linger), nightly
  backups (`deploy/duckoj-backup.timer`, D17) with a hardened, tested
  restore (D30), API cluster (`API_WORKERS`, default 4), Redis scoreboard
  cache (D25), k6 profile + results (`load/RESULTS.md`).

## Measured capacity (one 16-core host)

2000 closed-loop virtual users, no think time: **2,391 req/s, p95 1.2 s,
0 errors**. Contest-day reality (~2000 students, one refresh per 5 s ≈ 400
req/s) sits well inside that. Grading throughput is one DMOJ judge
container; add judges per the runbook "Judging throughput".

## What the province must supply

1. **SMTP** (`SMTP_*` in `.env`, D1) — without it, verification and
   password-reset mails silently no-op.
2. **A public hostname + TLS** (`SITE_ADDRESS`, `PUBLIC_ORIGIN`; Caddy
   issues certificates itself).
3. **Off-host backup copies** — the timer keeps 14 nightly dumps on this
   host only (D17).
4. **A second judge container** before a province-scale contest
   (runbook, "Judging throughput").

## Deploy from a clean host

```
cp .env.example .env && edit          # secrets, SITE_ADDRESS, SMTP
scripts/compose-up.sh                 # builds, migrates, starts, waits healthy
corepack pnpm bootstrap:admin <you>   # first admin (D19)
# install deploy/duckoj.service + duckoj-backup.timer per runbook "Boot and reboot"
# import problems: content/README.md
```

## Added by the feature/bug loop (2026-08-29 → 2026-08-30)

Features: contest clarifications + announcements (D31) · problem tags,
difficulty and filters (D35) · TOTP recovery codes (D39) · editorials (D43)
· admin operations dashboard + lease reclaim (D47) · real rank names (D46)
· contest PDF booklet (D48) · problem statistics (D49) · org-restricted
contests (D56) · account settings + localised mails (D57) · bulk student
accounts with forced password change (D61) · classroom problem sets (D66)
· Liquid Glass UI (D67) + phone tab bar (D76) · multi-judge scaling and
`judge:node` (D68) · results CSV/PDF + certificates (D71) · Vietnamese
guides at `/help` · contest source-similarity report (D77).

Hardening: 13 bug-hunt passes (auth, contests, judging, web, API/ops,
orgs/import, rating/realtime, whole-diff review, perf, security, newest
features, soak), ~80 fixed defects incl. checker-based problems always
IE'ing (D40), a double-join bricking scoreboards (D36), a booklet statement
leak (D62), CSV injection in three exports, CSP/HSTS at the edge (D69).

Measured (B-12, one 16-core host): 500 VUs → **p95 428 ms, 1716 req/s, 0
errors**; 2000 VUs → 1557 req/s, 0 errors; **one judge grades ≈35
submissions/min** (TTV p95 39 s under a 40/min storm) — add judges via
`corepack pnpm judge:node add` + the `scale` compose profile before a
province-wide contest.

## Known gaps, in priority order

1. The first real `restore.sh` against the live stack has not been
   exercised (unit-tested against a stub compose) — watch it.
2. Registration hides a taken email behind a fake 201 (D26); full closure
   needs verify-before-create.
3. TOTP has no recovery codes — the admin reset (M9) is the fallback.
4. No problem tags, editorials, comments; rank names are placeholders (D6).
   Contest clarifications and announcements shipped (D31), untested against
   the live stack.
5. `judged.live` keyed by job id (not attempt) — narrow stale-packet window,
   documented in D29.
