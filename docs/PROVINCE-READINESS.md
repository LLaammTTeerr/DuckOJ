# DuckOJ — province readiness (2026-08-29)

What a province IT team gets, what it must supply, and what is still open.
Campaign record: `docs/superpowers/ledgers/2026-08-29-province-ready-ledger.md`;
review: `docs/superpowers/briefs/final-review.md`; decisions D16–D105 in
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

The load-test numbers — the 2000-VU contest-day profile, per-route p95, the
soak run and CPU by container — live in **`load/RESULTS.md`** (latest tables
dated 2026-08-30); read them there rather than a figure copied here that can go
stale. Contest-day reality (~2000 students, one refresh per 5 s ≈ 400 req/s)
sits well inside the measured throughput. Grading throughput is one DMOJ judge
container (≈35 submissions/min); add judges with `corepack pnpm judge:node add`
and compose's `scale` profile before a province-wide contest (runbook, "Judging
throughput").

## What the province must supply

1. **SMTP** (`SMTP_*` in `.env`, D1) — without it, verification and
   password-reset mails silently no-op.
2. **A public hostname + TLS** (`SITE_ADDRESS`, `PUBLIC_ORIGIN`; Caddy
   issues certificates itself).
3. **Off-host backup copies** — the timer keeps 14 nightly dumps on this
   host only (D17).
4. **A second judge container** before a province-scale contest
   (runbook, "Judging throughput").
5. **A decision about `REGISTRATION`** (D200) — but only if the answer is
   `open`. Left empty, this judge takes no sign-ups and its accounts come
   from `corepack pnpm org:import` (D61) and `bootstrap:admin` (D19), which
   is what a school district wants. Set `REGISTRATION=open` for a public
   practice site. Same for `NAME_DISCLOSURE` (D197): empty is the protective
   rung. Both are reported on the admin operations dashboard, so you can see
   which one the process is actually on.

## Deploy from a clean host

```
cp .env.example .env && edit          # secrets, SITE_ADDRESS, SMTP
scripts/compose-up.sh                 # builds, migrates, starts, waits healthy
corepack pnpm bootstrap:admin <you>   # first admin (D19)
# install deploy/duckoj.service + duckoj-backup.timer per runbook "Boot and reboot"
# import problems: content/README.md
```

**Turning THIS host over to a province is a different list.** It has been the
rehearsal ground since 22 Aug: every secret on it has been seen, and it carries
393 generated accounts, 132 generated contests and 52 generated problems
alongside the demo content. `docs/guide/truoc-khi-trien-khai.md` is the
one-time checklist — rotate the seeded secrets, point SMTP at a real relay,
clear `localhost` out of `WS_EXTRA_ORIGINS`, run `scripts/cleanup-test-data.ts`
(D153), prove a restore (D130), mint the real admin, import real problems, and
the "you are live" smoke checks.

## Added by the feature/bug loop (2026-08-29 → 2026-08-31)

Features: contest clarifications + announcements (D31) · problem tags,
difficulty and filters (D35) · TOTP recovery codes (D39) · editorials (D43)
· admin operations dashboard + lease reclaim (D47) · real rank names (D46)
· contest PDF booklet (D48) · problem statistics (D49) · org-restricted
contests (D56) · account settings + localised mails (D57) · bulk student
accounts with forced password change (D61) · classroom problem sets (D66)
· Liquid Glass UI (D67) + phone tab bar (D76) · multi-judge scaling and
`judge:node` (D68) · results CSV/PDF + certificates (D71) · Vietnamese
guides at `/help` · contest source-similarity report (D77).

Later (F15–F25, → 2026-08-31), one line per area: student progress dashboard —
heatmap, streak, rating (D83) · a real CodeMirror editor with per-(problem,
language) drafts (D84) · browser-authored test data + problem/contest cloning
(D87, D88) · read-only-by-default MCP server (D89) · one-command
`prepare:problem` publish with editorial (D90, D97) · revision-aware problem
reads and package-sourced samples (D92, D94) · organiser live monitor,
counter-backed (D95, D100, D105) · ICPC-style team contests (D99, amended F25)
with a DB-enforced one-seat-per-contest rule (D101, D104) · submission metering
(D80) · CSRF origin checks (D82) · a safe per-service `scripts/deploy.sh` with a
two-boot crash-loop breaker (D85, D103) · must-change-password token lockout
(D102).

Hardening: 13 bug-hunt passes (auth, contests, judging, web, API/ops,
orgs/import, rating/realtime, whole-diff review, perf, security, newest
features, soak), ~80 fixed defects incl. checker-based problems always
IE'ing (D40), a double-join bricking scoreboards (D36), a booklet statement
leak (D62), CSV injection in three exports, CSP/HSTS at the edge (D69).

Measured: the current load and soak figures — read profile, judging, memory —
are in `load/RESULTS.md` (latest tables 2026-08-30). One judge grades ≈35
submissions/min; add judges with `corepack pnpm judge:node add` and the `scale`
compose profile before a province-wide contest.

## Known gaps, in priority order

1. The first real `restore.sh` against the live stack has not been
   exercised (unit-tested against a stub compose) — watch it (D30).
2. ~~Registration hides a taken email behind a fake 201 (D26); full closure
   needs verify-before-create.~~ — **closed on the default rung** (F-56,
   D200). `REGISTRATION` now decides who may create an account and defaults
   to `closed`: `POST /auth/register` answers 403 `registration_closed` to
   everyone but a global admin, before the meter and before the address is
   looked at, so the response is a function of the deployment and of nothing
   about the request body. There is no oracle left to narrow. **What remains
   open is scoped to one rung**: a deployment that sets `REGISTRATION=open`
   is back on D26's fake 201 and its one-extra-request residual, and full
   closure there still needs verify-before-create. The live `.env` sets
   nothing, so this province is on `closed` — **from the next deploy**; the
   edge at `2c8617e` still answers 201 to an anonymous registration.
3. ~~`/users/me/progress` … unmeasured at province size~~ — **measured**
   (F-44, `docs/superpowers/briefs/f44-report.md`). Seven aggregates, ≈16 ms of
   database time per cold miss at province scale; 2 000 pupils opening the page
   at 07:00 is ≈32 s of one core spread over that minute, so the per-user cache
   needs no stampede machinery. Two of the seven were indicted and fixed
   (migration 0044, D163/D164). What is **still open** from that pass, in cost
   order: the contest scoreboard's cold fold reads every subtask case row of
   the contest (146 ms and a temp-file spill at 2 000 pupils × 8 problems) with
   a bind list proportional to the contest's submissions; and D49's window
   exclusion (`contestWindowOpenWhere`) sequentially scans `contest_submissions`
   and `contest_participations` in full on the problem list, the problem read
   and the progress bars — a cost that grows with lifetime contest activity
   rather than with the page. **Both are now closed**: the fold's case read is
   gone rather than faster (F-45, migration 0045, D165/D166), and the window
   exclusion reads a materialised `contest_participations.ends_at` through its
   own index (F-54, migration 0048, D194), so its cost tracks the contests that
   are open rather than the ones there have ever been — 19 201 buffers to 480
   for one problem's statistics on a scratch copy holding 496 240 contest
   submissions. **Neither migration is applied to production**: 0045's backfill
   is a full pass over `submission_cases` and 0048's is a full pass over
   `contest_participations` plus two index builds (measured together at 0.5 s
   on that scratch copy), and both should run outside a contest window.
4. Two web fixes from F-42 are committed and **not deployed** — the teams
   panel goes on showing the roster it just replaced (and prefills the next
   edit from it, which drops a pupil), and the submit editor loses a draft
   across the mount that corrects an unofferable default. Until the edge
   ships them, `e2e/organiser.spec.ts` journey 2b is red on purpose.
   The coverage half of this gap is closed: the live monitor's numbers are
   asserted against the API and the teams form is driven end to end in
   `e2e/organiser.spec.ts`, the language picker and F-41's limits form in
   `e2e/language.spec.ts`, and similarity has had a browser walk since B-14
   (`features.spec.ts` feature 10).
5. A team's roster is read live, never frozen; only a banner warns the teacher,
   and same-instant edits rely on an advisory lock (D99, amended F25).
6. `judged.live` keyed by job id (not attempt) — narrow stale-packet window,
   documented in D29. Monitor `pending` and queue depth can honestly disagree
   (D100).

Closed since 2026-08-29: TOTP recovery codes (D39), problem tags (D35),
editorials (D43), real rank names (D46), and the similarity stuck-run and
team-name races (F15/F25).
