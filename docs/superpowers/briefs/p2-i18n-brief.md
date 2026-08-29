# Task P2 — Vietnamese UI (vi default, en toggle)

Read `docs/superpowers/briefs/conventions.md` first. Touch only `apps/web/**`
and `docs/DECISIONS.md` (add D18: i18n approach). Web-only test commands.

## Approach (ruled — do not re-open)
- No i18n library. `apps/web/src/i18n/` with `vi.ts`, `en.ts` (flat
  `Record<string,string>` keyed by stable English-ish ids, e.g.
  `nav.problems`), a typed `t(key, vars?)` with `{name}` interpolation, a
  `LocaleProvider` (React context) reading `localStorage['duckoj.locale']`
  (default `vi`, fallback `navigator.language` starting with `en` → `en`),
  and a nav toggle `VI | EN` (44px tap target) that persists.
- `en.ts` is the type authority (`satisfies`); `vi.ts` must have every key
  (a test asserts the key sets are equal).
- Every user-visible string in `apps/web/src/routes/*.tsx`, `router.tsx`,
  and shared components goes through `t()` — nav, headings, buttons,
  labels, empty states, error/toast text, table headers, verdict
  *labels* (keep the verdict codes `AC/WA/TLE…` untranslated as codes;
  translate their long names in tooltips/legend), relative dates
  (`Intl.RelativeTimeFormat` with the locale), numbers/dates via `Intl`
  with `vi-VN`/`en-US`. Problem statements and contest names are content —
  never translated.
- Vietnamese copy: natural, terse, olympiad-register (e.g. "Bài tập",
  "Bài nộp", "Kỳ thi", "Bảng điểm", "Nộp bài", "Đăng nhập", "Đăng ký",
  "Tổ chức", "Thông báo", "Tài khoản", "Mã truy cập", "Bảo mật",
  "Trang cá nhân", "Quản trị", "Chấm lại", "Hủy tư cách"). Diacritics must
  be correct (Unicode NFC).
- Fonts: check `apps/web/src/app.css` — the monospace stack must render
  Vietnamese diacritics (add a fallback such as `"JetBrains Mono", "Noto Sans Mono", ui-monospace, monospace`
  — do not add web-font downloads; system fallbacks only). Set
  `<html lang>` dynamically to the active locale.
- Tests: key-parity test; a Testing Library test that the nav renders
  Vietnamese by default and English after toggling; existing tests updated
  to query by role/testid or by the `t()` string rather than English literals.

## Done means
No English literal left in JSX outside `en.ts` (grep for common words:
`Submit`, `Login`, `Problems`, `Contests`, `Loading` — report the count
before/after), web typecheck/lint/test/build green, committed on your
worktree branch. Report to `docs/superpowers/briefs/p2-i18n-report.md`.
