# Loop f32 — deterministic initials avatars (D122)

**Status: DONE.** Web-only, zero-backend. Commits: `cf9087e` (component + tests
+ CSS), `22cc109` (five integrations + test-double fix), plus the docs commit.

## What shipped
- `apps/web/src/avatar.tsx` — `<Avatar name size? label?/>` + pure exported
  helpers (`initials`, `hueFromName`, `avatarColors`, `pickForeground`,
  `relativeLuminance`, `contrastRatio`, `hslToRgb`, palette constants).
- `apps/web/src/app.css` — `.avatar` (solid fill, `--line` border, no glass,
  no motion) and `.avatar-name` wrapper.
- Beside the name in: nav own-name (desktop + phone sheet), profile header,
  scoreboard rows (team name for team rows), comment authors (F-26), submission
  submitter. All decorative (`aria-hidden`); accessible names unchanged.

## Colour / contrast (measured)
- Background `hsl(hue 65% 25%)` from an FNV-1a name hash; foreground picked per
  background (near-white `#f8fafc` / near-ink `#111318`) by measured contrast.
- **Worst pair 5.52:1** at hue 60 (`rgb(104,105,22)` vs near-white). The 25%
  lightness keeps every hue out of the ~0.17–0.21 luminance band where neither
  foreground reaches AA. A 360-hue sweep test holds every hue ≥ 4.5:1.
- **Theme-independent**: the pair is self-contained, so the same worst case
  holds in both light and dark themes by construction.

## Tests (red→green)
- `apps/web/test/avatar.spec.tsx` (16): initials (multi/single/diacritic Đ,Ư/
  whitespace/empty→?), determinism + case/NFC insensitivity, foreground pick,
  360-hue AA sweep, nullish tolerance, aria semantics.
- Mutation-check: `AVATAR_LIGHTNESS` 25→45 turns the sweep RED (4.22<4.5);
  restored → 16/16 GREEN. The sweep imports the real constants, not copies.

## Verification
- web typecheck ✓, lint ✓, `vitest run --no-file-parallelism` **587 passed
  (57 files)**, `vite build` ✓ (pre-existing chunk-size warning only).

## Rulings / left out
- D122 recorded; supersedes D9 for the default case, uploaded image still deferred.
- Avatar tolerates a nullish name (→"?"); a frozen-submission test double gained the `username` production always carries (its "?" had collided with the frozen "?").
- No i18n key (all placements decorative). Not on the similarity `CompetitorLabel`
  or per-member roster links — out of scope.
