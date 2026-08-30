# C-2 — docs sweep: guides, /help test, readiness. DONE

Committed on `main`, not pushed. Staged by explicit path (never `-A`;
`docs/DECISIONS.md` was already dirty from another agent and left untouched).

## Ruling: the brief's premise was stale
"Guides stopped at F-14" was false — they already covered F3/F4/F8/F9/F12 and
the D76 tab-bar nav. I left those alone and added only the missing material,
verified against real routes and i18n labels.

## Guides (`docs/guide/{hoc-sinh,giao-vien,quan-tri}.md`, vi + en)
- **Student**: §4 rewritten for the CodeMirror editor + per-(problem, language)
  drafts (D84); new **§12 Tiến độ** (`/me/progress`) — tiles, current/longest
  streak (12-mo caveat), rating, 365-day heatmap, topic/difficulty bars with the
  closed-contest-only caveat, homework, recent verdicts; public profile =
  heatmap+bars only (D83). Old §12 → §13.
- **Teacher**: new §12 live monitor (D95), §13 duplicate-source check (D77),
  §14 ICPC team contests (D99 + F25); §11 live-watch pointer names the monitor.
- **Admin**: §8 `judge:node add/list/revoke` (D68) replaces hand-typed SQL; §9
  `scripts/deploy.sh <service>` (clean HEAD export, migrate-first, Caddy health
  poll, `:previous` rollback) vs whole-stack `compose-up.sh`; new §11 points to
  the MCP + prepare guides (not on `/help`).

## /help + test (`apps/web/test/help.spec.tsx`)
Raw import confirmed; nav already current. Added 4 per-tab assertions (one
distinctive rendered phrase per new feature). Trap fixed: the renderer turns
soft line breaks into `<br>`, so an asserted phrase must sit on one source
line — reflowed the drafts sentence.

## Readiness (`docs/PROVINCE-READINESS.md`)
D16→D105; loop summary extended with an F15–F25 one-line-per-area paragraph;
both capacity blocks now defer to `load/RESULTS.md` (2026-08-30 tables); gaps
rebuilt — recovery-codes/tags/editorials/rank-names and the similarity+team
races moved to a "closed since" line; progress cold-aggregates, no-Playwright,
live-roster teams added.

## Verification (web only per brief; api's ~40 min suite not run)
typecheck ✓ · lint ✓ · `vitest run --no-file-parallelism` **53 files / 530**
✓ (help 19/19) · `vite build` ✓.

## Probe-account lock (ops, live stack, not committed)
`UPDATE 23`. `duckadmin` (admin) and `hocsinh1` untouched (`locked=f`); 0
unlocked probes remain.

## Concerns
None blocking. Monitor/similarity/teams routes still lack Playwright coverage
— recorded as an open gap in the readiness doc.
