# loop-f33 — source tools on submission detail (D123)
Status: DONE

## Shipped
Two client-only controls beside the source on `/submissions/$id`, shown only
when the viewer may read it (reusing D111's `sourceVisible` gate — own / D27 /
teammate D117 see them; a masked/absent source sees neither):
- **Sao chép / Copy** — `navigator.clipboard.writeText(source)` in one
  try/catch (recovery-codes pattern, security.tsx): success shows a persistent
  `role="status"` "Đã sao chép" live region; a rejected/absent clipboard shows
  a `role="alert"` fallback. No busy flag.
- **Tải xuống / Download** — Blob + object URL + synthesised `<a download>`,
  `revokeObjectURL` in `finally`. Filename `submission-<id>.<ext>`, ext by
  exact `languageKey`: cpp17→cpp, py3→py, java→java, else txt.
Plain `<button>`s (already 44px + keyboard-reachable via app.css); vi/en i18n.

## Files
apps/web/src/routes/submission.tsx (ext map, state, handlers, JSX);
apps/web/src/i18n/{en,vi}.ts (4 keys); apps/web/test/submission.spec.tsx
(7 new tests); docs/DECISIONS.md (D123).

## Tests (red→green)
Tests first: 6 failed with feature absent (copy, rejected clipboard, 4×
download filename); "hidden" case passed pre-impl (no buttons). After impl:
submission.spec 17/17; full web suite 598/598. jsdom traps handled —
URL.create/revokeObjectURL stubbed, anchor click spied on the prototype.

## Rulings (brief overrides conventions.md)
Verification web-only (per task msg); explicit-path staging not `git add -A`;
report ≤35 lines; no push. `submission.copied` = "Đã sao chép." (period,
matching security.recoveryCopied). Blob `text/plain;charset=utf-8` so a
Vietnamese comment downloads intact. Verified: web typecheck + lint clean,
vite build green (pre-existing chunk-size warning only).
