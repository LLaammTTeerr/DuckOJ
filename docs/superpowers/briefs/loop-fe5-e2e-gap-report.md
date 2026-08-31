# loop fe5 — the verification gap four FE loops accumulated

FE-1..FE-4 each shipped having never run `smoke`/`journey`/`features`/`contest-day`/`authoring` against the code they changed. **Closed (D150), then used.**

## How the gap was closed — configuration, in two halves

**1. Seeding.** D82's CSRF allow-list *is* `wsAllowedOrigins` (`PUBLIC_ORIGIN` + `WS_EXTRA_ORIGINS`) — the guard already reads it, so a `CSRF_EXTRA_ORIGINS` would be the duplication D82 forbids. The preview origin joins that one list: **`WS_EXTRA_ORIGINS=http://localhost:8080,http://localhost:4321` in the operator `.env`** (not in git; `.env.example` + `docs/runbook.md` document it), applied with `podman-compose up -d --no-deps api`, verified in the container env and by `healthy`. Empty by default → **production unchanged**, and a loopback origin is one no remote page can present. The port left the command line for `vite.config.ts` (`preview.port`, `strictPort`): an allow-list entry naming a port is worthless if the port drifts.
*Red:* `smoke` on preview **1 failed / 8 passed**, `403 csrf_origin` on `POST /submissions`. *Green:* **9 passed**.

**2. The verdict — invisible until the first half was open.** Four specs still failed, all waiting 60 s for a `.badge` on submissions the judge had already marked `AC` in the DB. The submit page learns a verdict over the socket and nothing else, and the proxy carried `/api` only, so `/ws` fell through to vite's SPA fallback: `index.html`, 200, an upgrade that fails silently. The proxy now carries `/ws` (`ws: true`, `changeOrigin: false`). *Red:* journey 2, 60 s. *Green:* 4.4 s.

Rejected: rewriting `Origin` in the proxy (defeats the check rather than satisfying it); bearer seeding (fixes fixtures only — the phone journey signs in and submits *through the UI*, so the writes that matter carry a cookie whatever the harness does).

## Added

- **`e2e/phone-contest.spec.ts`** — contest day at 390×844: sign in *at* phone width (the phone shell has no `Đăng xuất` on the bar, so the usual locator does not exist), the running round off D138's home panel with D134's chip (glyph, not colour) and D135's countdown, open, join, submit the on-disk model solution, verdict over the socket with no navigation, then D136's cards on the **contest** row — eight cells, the variant FE-2 could not measure. Seeds nothing (finding 1); registers nobody. Mutation ×2: drop `card-rows` → verdict ends **513px** across 390px; `.phase.running::before: none` → glyph red.
- **`e2e/states.spec.ts` +2** — the brief's error-path journey is ~80% already there, so rather than duplicate it: **a retry that WORKS** (the existing test counts requests, proving the button is wired and nothing about what the reader sees; `retryTransientOnly` retries a 5xx thrice, so the mock stays broken until the click), and **the server's English `detail` demoted, not printed** as the headline (D18+D145). Mutation ×2.

## Gate

typecheck clean · lint clean (src test e2e) · `vitest run --no-file-parallelism` **718 passed (64 files)** · `vite build` ok · **e2e preview :4321 — `67 passed` (6.3m), whole suite** · **e2e live :8080 — `7 passed`** (`phone-contest` + `states`).

**Run-budget ruling.** The thermal cap allows two full Playwright runs; both went to preview (the red discovery run, then the green one), because a full green preview run *is* this loop's deliverable. Live got the touched specs; the last full live count on record is FE-4's **64/64** on the same web `src` — nothing in `src` shipped here. No `apps/api` suite (container-backed; CI runs those, D106/D149). Peak 82.4 °C (vitest); Playwright peaked 69.3 °C.

## Left open

1. **`home.tsx`'s "Kỳ thi của bạn" cannot see a new round.** `pickContest` reads `GET /contests` unfiltered — page 1 of an **id**-ordered list, 25 of 125 here — so the round a school just created is not on the front page at all. Found by the new journey (my seeded contest never appeared; the spec was rewritten to walk the round a pupil can reach). Honest fix is API-side, out of a frontend loop under a container ban.
2. **A socket that never opens is silent.** `useSubmissionSocket` fetches on `open` and on frames; `submit.liveUnavailable` fires only on an explicit `error` frame. A failed upgrade leaves the verdict panel blank forever with no message — exactly what preview did. D144's territory; a candidate D-entry.
3. `.env` and the `api` container changed **outside the worktree** (no diff shows it). Rollback: restore the single-origin `WS_EXTRA_ORIGINS`, recreate `api`.
4. B-35 took D149 mid-flight; this ruling was renumbered **D150** in the merge commit, references and all. `vite.config.ts` still carries a D149 comment — B-35's, correctly.
