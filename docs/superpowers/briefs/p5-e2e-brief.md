# Task P5 — Playwright journey against the live stack

Read `docs/superpowers/briefs/conventions.md` first. Work on main. The live
stack at http://localhost:8080 has just been redeployed with every Phase
1–4 feature (read `git log -15` and the reports in `docs/superpowers/briefs/*-report.md`).
Existing harness: `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`
(reuse `watchForBrokenRequests`). Run with
`corepack pnpm --filter @duckoj/web test:e2e`. Chromium is already in
`~/.cache/ms-playwright`.

## Journeys (`apps/web/e2e/journey.spec.ts`, serial, unique usernames per run)
1. Register → (no SMTP: skip verify) → login → nav shows display name in
   Vietnamese UI → toggle EN → English.
2. Open a demo problem (`tong-hai-so`, imported by P4 — if missing, import it
   using `content/README.md` and note that) → submit a C++ AC solution →
   verdict page reaches `AC` via WebSocket within 60s → "My submissions"
   link filters correctly.
3. Submit a WA solution → `WA`.
4. Admin (bootstrap one with `corepack pnpm bootstrap:admin e2eadmin …`
   against the live DATABASE_URL from `.env`; see runbook) → create a
   contest with `frozenLastMinutes` and the demo problem → student joins →
   submits → scoreboard shows the row → admin disqualifies → row `[DQ]` →
   admin rejudges the submission → verdict re-reaches `AC`.
5. Security page: enable TOTP (use `otpauth` package or `otplib` in devDeps
   to compute a code from the shown secret) → logout → login requires code
   → succeeds → disable.
6. Phone viewport (390×844): nav does not overflow horizontally on
   problems, contest, scoreboard pages (`document.documentElement.scrollWidth <= innerWidth`).

Every journey asserts zero console errors / broken subresources. Any
product bug you find: fix it (TDD, on main, small commits), or if out of
reach, record it in the report with a repro. Screenshots of each journey's
final state into `apps/web/e2e/screenshots/` (gitignored — add to .gitignore).

## Done means
`test:e2e` green against the live stack, evidence pasted in
`docs/superpowers/briefs/p5-e2e-report.md`, committed on main.
