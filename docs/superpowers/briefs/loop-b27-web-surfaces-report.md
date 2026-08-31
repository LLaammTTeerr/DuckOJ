# Loop B-27 — newest web surfaces (theme / countdown / print / comments)

**Status: DONE.** Branch `worktree-agent-a236f7a43ed518265` (not pushed).
Web `-r typecheck`, web lint, `vitest run --no-file-parallelism` (575 pass, 56
files), and `vite build` all green. Live e2e (added spec) green — see below.

## Fixes (2 real)

1. `aecf309` — **[serious, WCAG 4.1.2]** F-26 comment textareas had no
   accessible name: composer/reply relied on a placeholder, and the EDIT box
   had no label, aria-label OR placeholder — a nameless field the instant a
   viewer edits their own comment (axe `label`). Added `aria-label` to all
   three from 3 new i18n keys (vi+en). Red first: `findByRole('textbox',{name})`
   threw; green after.
2. `5dbe7bd` — **[moderate, D118]** The live header countdown re-renders
   HH:MM:SS each second in the proportional UI face (live computed style:
   `font-variant-numeric: normal`, no class), so the line reflowed sideways
   every tick — the "no layout shift each second" D118 promised was not held.
   Added `.countdown { font-variant-numeric: tabular-nums }` + the class. Two
   tests red first (component class, css rule); green after; both mutation-checked.

## Cleared with evidence

3. `c997517` — **new e2e `a11y-surfaces.spec.ts`, 3 passed live.** axe sweep of
   the surfaces B-20 never covered — contest header+countdown, scoreboard,
   organiser monitor, problem+discussion, submissions — in light, phone, and
   dark BOTH ways (OS media query AND the `data-theme` toggle, separate CSS
   triggers). **Zero serious/critical.** Plus two guards: OS-dark == toggled-dark
   `--bg` (D116 — the triggers must not drift), and print forces `--bg:#fff`/
   `--fg:#000` + nav hidden even under `data-theme="dark"` on all 3 print
   screens (D121's source-order claim, proved against the toggle path F-31
   never ran live).
4. `2fe011a` — **lang + data-theme orthogonal.** Testing Library test toggles
   theme-then-locale and locale-then-theme; neither attribute disturbs the
   other, System clears data-theme without touching lang. No bug — pinned.
5. **Timezone (D118):** `startTime`/`endTime` are `Timestamp =
   z.string().datetime({offset:true})`, so `Date.parse` is offset-correct; live
   countdown read `676:45:05` on the running contest. Correct.
6. **No untranslated JSX** in theme.tsx / teams.tsx / contest-monitor.tsx /
   the discussion — grep empty; every visible string is a `t()` key (the team
   form already wraps its inputs in labelled `<label>`s). i18n-parity (in the
   575) passes with the new keys.
7. **Keyboard reachability:** the theme control is three `<button>`s in a named
   `role="group"` (44px, global `:focus-visible` ring, B-20); the countdown is
   a non-interactive `role="timer"` — nothing to reach.
8. **Similarity marks:** `.match` uses only themed tokens (`--mark`,
   `--mark-fg: var(--fg)`), so it follows all three modes by construction;
   B-20 measured text-on-mark 13.8/9.5:1 and added the dotted non-colour cue
   (guarded in app-css.spec). Correct in dark.

## Rulings / concerns

- No new D-entry: no product ruling was needed (D123–D125 unused).
- The similarity COMPARISON page was not axe-swept live — it needs two seeded
  similar submissions + a computed report (heavy). Cleared via the token/CSS
  evidence above rather than a live render.
- e2e needs `E2E_SECRETS_FILE`=main repo's `.secrets/duckadmin.txt` (worktrees
  carry none); admin web-form login needs no TOTP. No live data mutated; no
  `bh27-*` accounts created.
