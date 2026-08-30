# loop-b21 — comments (F-26) & cross-cutting correctness

**Status: DONE_WITH_CONCERNS.** Branch `worktree-agent-ae4b17eadb9bc515e`, not
pushed. Ruling **D112**. 4 fixed + 4 cleared. Each fix: failing test → fix →
mutation-checked (red confirmed) → one commit.

## Fixed
1. **HIGH — D109/D35 spoiler-hide bypasses team mode.** `3e6e16e`.
   `contestHiddenProblemIds` keyed on `contest_participations.user_id` (the
   captain who pressed Join). Every other member competes on that same row
   (D101) — reads the problem, submits — yet the hide reached only the captain,
   so 2/3 of every team could read the whole solution thread mid-round, post
   into it, AND see the unmasked tags/difficulty/stats (same fn feeds D35's
   mask). Fix reuses `actingParticipationWhere`. 63 masking specs still green.
2. **MED-HIGH — announcements/clarification answers reach only captains.**
   `fbd9d01`. `broadcastRecipientsQuery` selected `contest_participations
   .user_id` only; team members live in `team_members` and were never told —
   contest-critical info. Union in the members (D101's "participants online"
   shape); `UNION` gives the distinct `selectDistinct` used to. Cap/exclude/
   SQL-order specs still green.
3. **LOW-MED — comment page ignored its advertised `limit`.** `7e2538b` +
   **D112**. Route advertises `PaginationQuery` (limit 1..100); controller
   parsed then dropped it — every page a fixed 25. Now passed through, clamped.
4. **MED — comment meter's Retry-After is a treadmill.** `b3c16c4`. Used
   `RateLimiter.allow`, which records the attempt it refuses (D80 warns of it):
   a refused create kept an attempt row, count stayed AT the limit as the
   oldest event expired, so honouring Retry-After was refused again — each
   refusal pushing the cooldown out. Switched to D80's `retryAfterSeconds` +
   `record` split; a refusal now leaves no attempt row (12→10, red before).

## Cleared with evidence
5. **Comment XSS.** `dd69698`. Bodies use the SAME `renderStatement` (DOMPurify
   last) as statements/editorials — one config. Added comment-shaped payloads
   (data:text/html link, ontoggle, onpointerover — each red without DOMPurify)
   + a case pinning a KaTeX `\href` never becomes a live link (`trust:false`
   renders inert error text; `javascript:` is escaped text, not an href).
6. **Every route has exactly one auth marker.** `route-marker-coverage.spec.ts`
   already boots `AppModule` and asserts it for every non-internal route (incl.
   the 3 comment routes and all since D99) — 3/3 green.
7. **`must_change_password` (D102) through every write surface.** Gate at
   `TokenService.issue` (l.58) + `resolve` (l.106): every token/MCP write —
   comments included — 409'd by construction; session writes deliberately open.
   `password-change-required.spec.ts` covers it.
8. **Certificates/results naming in team mode.** `results.ts`/`results.service
   .ts` are team-aware (D99): team name + members, school = team's org. Also
   re-checked correct: one-level enforcement across a deleted parent,
   tombstone-vs-omit at a page boundary, rate-limit KEY (`user:<id>`).

**D112** — comment page honours `limit`; a page's replies are fetched whole
(top-level ceiling bounds the fan-out): accepted province-scale limit, upgrade
path per-parent reply pagination.
**Verify (all green):** typecheck (-r) + :scripts; lint (-r) + :scripts; API
1085/1085 (122 files, `--no-file-parallelism`); web 544/544; vite build; no
contracts/openapi/sdk diff.

## Concerns
1. Reply fan-out (D112) bounded only by top-level ceiling × actual replies;
   first hot editorial-style thread should confirm it holds.
2. A reply notification still fires to a parent author mid-contest who cannot
   see the thread — activity signal, no content; footnote, not fixed.
