# f30 — team polish (two B-23 residuals + a header countdown)

Status: DONE_WITH_CONCERNS (item 2 cannot fully close web-only — see below).
Three staged commits, main, nothing pushed. Web-only + i18n (append) + docs.

## 1. Team dates through `formatDateTime` (D57), not raw `toLocaleString()`
`teams.tsx TeamPage` renders the contest start via
`formatDateTime(entry.startTime, locale, timeZone)` (`useLocale()`), the account
zone. **Whole-app sweep for user-facing raw `.toLocale*`:** `teams.tsx:427` was
the ONLY offender. The rest (`i18n/index.tsx` 291/292/306/315/320) are the
shared helpers' own implementations — correct, they take the zone.
Test: `team-page.spec` "…account's own zone" — 01:00Z in Asia/Ho_Chi_Minh →
`08:00`. Red→green confirmed (raw line fails it).

## 2. Team picker disambiguates two same-slug teams
Picker `<option>` value is now composite `orgSlug/slug` (was bare `slug`); the
`<select>` value/default derive from it, so a member on two same-slug teams from
different schools can pick which. Label was already `name · orgName` — left as is.
**Concern / missing field:** `JoinContestRequest` is `.strict({ teamSlug })`
with no org, so only the slug reaches the server, which applies B-23's
lowest-id-the-caller-is-on tiebreak. Honouring the reader's org choice at the
gun needs an `orgSlug`/team-id added to that contract — an API change, out of
web-only scope. Noted in a code comment. Existing `body:{teamSlug:'doi-1'}` green.
Test: `contest-teams.spec` "…choose between them" — options
`['thpt/doi-1','khac/doi-1']`, select flips to `khac/doi-1`. Red→green.

## 3. Live header countdown (D118)
`ContestCountdown` leaf in `contests.tsx`: "Bắt đầu sau …" upcoming, "Kết thúc
sau …" running, null once finished. Ticks each second in its own state (parent
never re-renders), `role="timer"` (no `aria-live`), no animation (reduced-motion
safe), interval cleared on unmount. Duration via new locale-neutral
`formatCountdown(ms)` in `format.ts` (`HH:MM:SS`, uncapped hours, past/NaN →
`00:00:00`). Keys `contest.startsIn`/`endsIn` appended to en.ts + vi.ts.
Tests: `contest-countdown.spec` (5) — format table, down-then-flip, en label,
finished→nothing, unmount clears (`getTimerCount()===0`). Red→green confirmed.

## Verification
Web typecheck ✓, lint ✓, `vitest run --no-file-parallelism` 570/570 (56 files,
incl. every ContestPage test with the countdown mounted) ✓, `vite build` ✓.
Files: `apps/web/src/routes/{teams,contests}.tsx`, `src/format.ts`,
`src/i18n/{en,vi}.ts`, three test specs, `docs/DECISIONS.md` (D118).
