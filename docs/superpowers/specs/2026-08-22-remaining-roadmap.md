# The remaining roadmap (2026-08-22, autonomous run)

**Status:** executing top to bottom under the user's directive
"automate all of the remaining task, do whatever you seem fit".
Each phase: tests mutation-checked, committed, CI green before the next.
Strike a line through a phase when its ledger exists.

Done: 5b, 5c, 5d, 5e, 6a, 6b (ledgers in docs/superpowers/ledgers/).

1. **5b — rank bands (D6).** Pure band table in `packages/glicko2`
   (`bands.ts`), Codeforces-shaped thresholds, placeholder names.
   Profile page shows title + colour. Data edit to rename.
2. **5c — rate limiting on account recovery (D13).** `rate_events`
   table, 5/email/hour on reset + verification sends. Silent drop.
3. **5d — organization screens.** List, detail, join/request-to-join,
   requests queue for deciders, member role management. API complete
   since 3e — this is UI + any contract gaps the SDK surfaces.
4. **5e — admin screens.** Rate/unrate a contest, grant global role.
   Session-only routes; UI hidden unless `globalRole === 'admin'`.
5. **6a — notifications (D14).** Table + list/mark-read endpoints +
   producers at the three sites + nav bell.
6. **6b — ICPC scoreboard detail.** Attempts/penalty per cell IF the
   format cells already carry them; otherwise extend `lower.ts` output.
7. **7a — Polygon import.** Pure parser + CLI, **no upload endpoint**
   (ruling 2026-08-22, reversing the line below's first draft: server-side
   zip ingestion is zip-slip/bomb surface and nothing needs it — the CLI's
   output goes through the existing `buildPackage` → `POST /packages`
   path, which already validates). Input is an extracted directory, not a
   zip.
8. **7b — statement rendering port (D15).** Port + null renderer;
   Typst adapter only if `which typst` finds a binary.
9. **7c — `oj` CLI.** login/list/submit/watch on the generated SDK.

Rulings live in `docs/DECISIONS.md` D13–D15. The verify ritual before
every push: typecheck, `-r lint`, `lint:scripts`, `-r test`, SDK drift
check, web build — all via `corepack pnpm` (bare pnpm not on PATH).
