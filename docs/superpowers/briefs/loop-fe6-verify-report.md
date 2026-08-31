# loop fe6 — F-37's two fixes, walked on a phone

Both hold on the live bundle. **No product bug.** One spec was stale, and one of its "proofs" was not a proof.

## 1. D151 — and why FE-5 could not have proved it
FE-5's `phone-contest.spec.ts` seeded nothing on purpose. That is what made its front-page assertions pass against the **broken** code: `thu-nghiem-1` is running, has been for days, and has **id 3** — page 1 of the id-ordered list D138 read. "The panel names a running round with a chip and a countdown" was as true before F-37 as after.

The spec now **seeds the round it walks**, with two load-bearing properties: created seconds ago on a 132-contest stack (so it is off page 1 — asserted from the very request D138 shipped, `GET /contests`, no params), and starting one minute before the earliest round the pupil can already enter, so `pickContest` *must* name it — asserted by **href**, not by "some running round". Then the journey walks it at 390×844: join → the contest's own `/submit?problem=…&contest=…` link → the on-disk model solution in CodeMirror → **AC over the socket, no navigation** → D136's eight-cell card on `/submissions`, badge inside 390 px, no sideways swipe. Real, not asserted-only: the round's scoreboard reads `hocsinh1, 100, 1 submission, first_solve`.

**Mutation** (`params: { query: {} }` = D138's unfiltered ask, built into a worktree bundle, run on preview :4321): red — `Expected "/contests/fe6-phone-1788194849422" / Received "/contests/thu-nghiem-1"`.

## 2. D152 — a dead live channel still delivers the verdict
`page.route` cannot intercept a WebSocket upgrade; **`page.routeWebSocket`** can, and is how the assignment's instruction was executed. Two tests, F-37's two failures: every upgrade **closed at once** (the connect→close→reconnect loop the one-deadline-per-submission rule exists for), and one **accepted and never spoken to**. Both must reach `AC` by polling with "Đang cập nhật chậm" on screen, and must never show `liveUnavailable`, whose "refresh" wording is the lie D152 fixed.

The judge grades A+B in ~2 s against a 6 s deadline, so unmodified these tests are a coin flip. `GET /submissions/{id}` is therefore **held at `grading`** (the server's own answer, two fields rewritten) until the slow line has been seen, then released — the verdict that lands is the real one, over a real 4 s poll on a genuinely dead socket. **Do not delete that gate.** `POST /submissions` has no id in its path and falls through.

**Mutations** (both `armDeadline()` call sites commented out): *silent* cut red on the slow line; *refused* cut red **earlier**, on the verdict panel never appearing — without the deadline nothing ever fetches, because that socket never fires `open`. A blank panel is D152's exact reported symptom, so the red is the right one.

## Runs (real counts)
`phone-contest` live :8080 **3 passed** (40.3 s), and again on the final committed file **3 passed** (40.1 s) · `states` live :8080 **6 passed** (33.5 s) · mutated bundle on preview :4321 → 1 failed (D151) + 1 failed + 1 failed (D152) · restored bundle on preview **3 passed** (38.9 s) · web vitest `--no-file-parallelism` **726 passed (65 files)**, F-37's count exactly · typecheck clean · lint clean (`src test e2e`) · `vite build` ok — worktree dist only, the live bind mount was never written.

**Spec fixed, not product:** `mode: 'serial'` is gone from `phone-contest.spec.ts`. Its three tests share only the seeded round and each signs in for itself; serial mode made one red **skip** the other two, which cost two extra runs to get one mutation's evidence out. `workers: 1` already serialises them.

## Concerns (none blocking)
- **Debris:** each run seeds a `fe6-phone-*` contest with a ≤40-minute window, so the home-page hijack self-clears; ~6 finished rows persist on the live DB.
- Stale `vite preview` servers from **other** worktrees listen on :4178 and :4179. Not touched.
- **Thermal:** Playwright peaked 79.5 °C. Web vitest spiked **94.1 °C** at its tail and `vite build` **92.9 °C**, both back under 85 °C within one sample — a spike, never a sustained minute, so nothing was aborted. F-37 measured the same 94 °C on the same suite: it is the gate, not this loop. No container-backed suite run (D106/D149); `graphify update .` deliberately skipped for the same measured reason (93.3 °C in F-37), this loop's thermal rules overriding conventions.md.
