# P2 — Vietnamese UI (vi default, en toggle) — report

**DONE.** Branch `worktree-agent-a2605d0dc2213f4ad`, on the P1-B merge (`6ae754c`).

## Shipped

- `apps/web/src/i18n/`: `en.ts` (type authority, `MsgKey = keyof typeof en`, 335
  keys), `vi.ts` (`satisfies Record<MsgKey, string>`), `index.tsx` — `translate`
  with `{name}` interpolation, `LocaleProvider` + `useT()`/`useLocale()`,
  `resolveInitialLocale()` (stored → `navigator.language` starting `en` → `vi`),
  `verdictName`/`globalRoleLabel`, `Intl` wrappers on `vi-VN`/`en-US`. Provider
  in `main.tsx`; `<html lang>` follows the locale.
- `VI | EN` toggle in the shell nav — 44×44px, `aria-pressed`, persisted to
  `localStorage['duckoj.locale']`, styled as `.shell-nav button` (no new
  className, per app.css's own contract).
- Every user-visible string in `router.tsx`, all 19 `routes/*.tsx` and `qr.tsx`
  goes through `t()` — headings, buttons, labels, placeholders, aria-labels,
  `title`s, empty states, errors, table headers, security.tsx's
  `window.confirm`, the notification sentences. `e2e/smoke.spec.ts` too (not in
  the vitest run, but in scope and otherwise a P5 time bomb).

## Grep + tests

`\b(Submit|Login|Problems|Contests|Loading)\b` over `router.tsx` +
`routes/*.tsx` + `qr.tsx`: **before 34 → after 2**, both survivors prose in code
comments (`submit.tsx:205`, `router.tsx:122`). **Zero in JSX.**

`--filter @duckoj/web test` → **21 files, 154 tests, green.** Typecheck, lint,
`vite build` green. New `test/i18n.spec.tsx` (19): key parity BOTH directions,
NFC diacritics, no blank messages, per-key placeholder-set match, interpolation,
`resolveInitialLocale`'s four branches, `formatRelative` in both locales,
provider default/toggle/persistence/`<html lang>`/bare-render, and the REAL
`ShellNav` (exported for it) rendering Vietnamese then English. `test/setup.ts`
seeds `localStorage` to `vi` so bare renders exercise the shipped default, not
jsdom's `en-US` navigator. Red→green: (1) orphan key + trailing space in
`time.justNow` → parity and relative-time tests red, restored → green; (2) EN
button's `setLocale('en')` → `('vi')` → toggle test red, restored → green.

## Rulings (D18 in docs/DECISIONS.md)

- **Never translated:** verdict CODES (long names moved into `title` tooltips),
  API enum values on the wire, the ICPC `+`/`−`/`m` notation, server
  `error.detail`/`code` (verbatim by design — five tests now say so),
  `formatPoints`' bare numbers, and content (statements, contest/org names,
  usernames, glicko2 band titles).
- **Fonts: no change.** Vendored IBM Plex Mono already carries a `vietnamese`
  unicode-range subset — stronger than the brief's Noto fallback, and adding one
  would fight app.css's "IBM Plex Mono only" rule.
- **`Intl.RelativeTimeFormat`** had no call site; rather than invent one it now
  backs the notification feed's date column, absolute instant in `title`.
- Sentences wrapping a `<Link>`/`<code>` split into prefix/suffix keys —
  Vietnamese reorders the halves. Plurals are two keys, not a rule engine.
  `ShellNav` was extracted from `RootComponent` so the real nav is testable, and
  `problemRole.*` is a separate key family from `role.*` (`tsc` caught that a
  problem member's role enum is not an org member's).

## Concerns

- `e2e/smoke.spec.ts` asserted `Signed in as <name>` **inside the nav**, which
  has never rendered that string; repaired to the display name alone. Playwright
  is not run here, so the e2e changes are unverified against a live stack.
- `routes/index.tsx` is dead code (nothing imports it); translated, not deleted.
