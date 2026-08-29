# P5 — Playwright journeys against the live stack

**DONE_WITH_CONCERNS.** `34ab990` sign-out button · `0532701` visitor 401 + phone
overflow · `f921aa3` the six journeys · `84ea589` no dead-cookie request on sign-out.
`test:e2e` → **15 passed** (6 journeys + 9 smoke) against localhost:8080; ritual green
(web **183**, api **509**, regen leaves no diff, `vite build` clean).

## Shipped
`apps/web/e2e/journey.spec.ts` — serial, unique names per run, each asserting an empty console and no broken subresource:
1. register (API) → sign in (form) → display name, Vietnamese nav, EN toggle.
2. `tong-hai-so` → *Nộp bài giải* → the model solution **read from disk** → **AC
   over the WebSocket**, never a reload → *Bài nộp của tôi* filters to it.
3. a wrong answer → **WA**, with its per-case grid.
4. `duckadmin` creates a contest through the form with `frozenLastMinutes = 5` → a
   pupil joins, submits, **AC** → the row scores 100 → *Hủy tư cách* → `(hủy tư cách)`
   + `.dq` → *Chấm lại* → the verdict returns **AC**.
5. TOTP from the shown secret (`otpauth`, new devDep) → sign out → password alone
   refused → code accepted → disabled again.
6. 390×844: `scrollWidth <= innerWidth` on `/problems`, contest, scoreboard.

`e2e/watch.ts` — the watchdog lifted out of `smoke.spec.ts`; expected 4xx are a
`e2e/watch.ts` — the watchdog lifted out of `smoke.spec.ts`; expected 4xx are a
per-test parameter, scoped to route AND status. `e2e/credentials.ts` —
`E2E_ADMIN_PASSWORD`, else `.secrets/duckadmin.txt`, whose two `key: value` blocks
(admin + pupil, split by `---`) are chosen between by `globalRole`: a flat parse
authenticates as whoever is written last. Never logged, never on screen.
`playwright.config.ts` gains `locale: 'vi-VN'` — Chromium reports `en-US` and D18
honours that, so every spec drove the ENGLISH app while asserting Vietnamese, and
`smoke.spec.ts` failed on its own assertions. Screenshots → gitignored.
## Bugs found, each fixed red→green
1. **No way to sign out.** `POST /auth/logout` had no control anywhere; only a hand-
   cleared cookie ended a session. `test/logout.spec.tsx` (3 cases) red without it.
2. **Sign-out fired one more authenticated request**: `resetQueries()` refetches
   active queries and the bell's `enabled` drops only on the next render → a 401
   `GET /notifications` (4th case, red on `['/auth/me','/notifications']`). `['me']`
   goes null first, then the rest is removed — `clear()` cannot: observers keep
   rendering what they last saw and the nav kept the departed name.
3. **A visitor's contest page 401s**: session-only `GET /contests/{key}/me`, asked
   unconditionally. New red case in `contests.spec.tsx`.
4. **A phone scrolls sideways on `/problems`** (408 > 390): the six-column table needs
   ~392px against a 358px column. Tables scroll themselves under 700px, desktop
   measured unchanged. Journey 6 is the failing test — jsdom has no layout.
5. *Harness, not the app:* a bare `locator.textContent()` waits with NO timeout, so
   the rejudge poll blocked and never reloaded — a two-minute false failure on a
   rejudge the API finishes in three seconds (measured).

## Rulings
- **Registration stays API-only** — no register page exists; adding one is a feature.
- **`duckadmin` is used, never mutated**; TOTP is enrolled on a throwaway user, since
  a run dying between enable and disable would lock later runs out.
- **The freeze is set but not biting** (5 min on 2 h): a live one would hide the very
  row journey 4 checks for, since D22 freezes at `end − F`.
- **Explicit `git add` paths** (dispatching brief) over conventions.md's `-A`; and no
  literal `[DQ]` — the brief predates D18, so journey 4 asserts the shipped strings.

## Concerns
- **No registration UI** — the one journey step no browser can perform; and nothing
  links a submission to its contest (the DTO has no `contestKey`).
- The `otpauth` install re-resolved jsdom's optional `@noble/hashes` peer in the
  lockfile (1.8.0 → 2.2.0). Every suite is green after it, but it is unrelated drift.
