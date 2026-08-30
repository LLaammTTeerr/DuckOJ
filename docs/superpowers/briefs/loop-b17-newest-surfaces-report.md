# B17 — bug hunt across the three newest surfaces (MCP, prepare, monitor/clones)

**Eight verified findings, seven fixed, eight commits — each: failing test → fix → mutation
check.** Branch `worktree-agent-ab098147de8ec7110`, nothing pushed. Rulings **D96**, **D97**.

## Findings
1. **`solve-problem` spliced an untrusted statement into a user-role message unfenced** (MCP,
   *medium*). A statement is written by whoever set the problem; one opening `## How to finish`
   wrote the section telling the agent what to do next — to an agent possibly running
   `DUCKOJ_MCP_WRITES=1`. Now in marked, defanged delimiters with a guard sentence, instructions
   first, title flattened to one line. **D96.** `prompts.ts`, `test/prompts.spec.ts` (6).
2. **That prompt scraped samples out of the statement instead of D94's published files** (MCP,
   *low*, same commit). `problems_get` beside it returned the graded bytes; the prompt a trimmed
   copy, or "no sample table could be parsed". Now `resolveSamples` — which is what makes the
   fence-length rule load-bearing: a sample FILE can hold a ``` line.
3. **Resource and prompt refusals dropped the code, the status and D80's wait** (MCP, *medium*).
   The SDK turns a thrown error into `-32603 Internal error` + message, so a token lacking
   `problems:read` reading `duckoj://tags` was told `Internal error: no` — reads as transient
   when no retry can work. `guarded()` + `asHandlerError()`; 404 → `-32602`. `errors.ts`,
   `test/refusals.spec.ts` (4).
4. **A checker that compiles but crashes was blamed on the model solution** (prepare, *medium*).
   Every test came back testlib `FAIL` and the report read `checker: compiles` / `model: does not
   reproduce 2 of 2 answer(s)` — sending a setter to debug a correct program, masking exactly
   what `model.ts` says must never be masked. `FAIL` now replaces the `checker` line; model and
   matrix `skip`. `validate.ts`, +2 tests (a crash, and testlib `_fail`/3).
5. **`prepare publish` published `editorial.md` on every run, including runs that published
   nothing** (prepare, *medium*). Staging a package on a live problem — the documented use
   without `--publish` — handed the room the write-up, since D43 serves a published editorial to
   any viewer. Stored always, published only with the revision. **D97.** `publish.ts`, +3 tests.
6. **`unwatch-contest` matched case-sensitively while `watch-contest` canonicalises** (realtime,
   *low*). A client unwatching with the spelling it had sent kept the activity frames and its
   slot against the 8-watch cap, from a frame just acked. `submissions.gateway.ts`, +1 test.
7. **One refused submission wrote TWO `refused:submission` rows** (API/monitor, *medium*).
   `submissionRetryAfter` asks both D80 windows under one purpose and key, and
   `retryAfterSeconds` marks on each non-null answer — so D95's `submitRefusalsLast10Min`, the
   panel that exists to make a script visible, doubled exactly when the room is busiest.
   `mark: false` on both, one `markRefused`; login's two markers are two KEYS and stay.
   `rate-limiter.ts`, `submission.access.ts`, +1 test.
8. **Migration 0035 bounds the feed but NOT the per-problem panel** (*medium, NOT fixed*). EXPLAIN
   on a seeded fixture (100k rows in a foreign contest, 200 in this one): `problems()` seq-scans
   all 100,200 `contest_submissions` **and** all 100,200 `submissions` — 32 ms for ten rows of
   twenty — while the feed uses the index (82 buffers, 1.4 ms). D95's docstring claimed both. Two
   `LATERAL` rewrites do drive `contest_submissions` through 0035 and measure *worse* (98 ms):
   the ~5010-rows-per-problem estimate hashes `submissions` ten times. The real fix is a
   per-`contest_problem` counter or a reachable verdict — schema, not query. Docstring corrected
   **with** the measurement rather than left claiming a falsehood.

## Checked, sound, no bug
Write tools truly absent from `tools/list` (through a real `McpClient`) · D80 `retryAfterSeconds`
surfaced by tools · no traversal: `openapi-fetch` percent-encodes path params, so
`duckoj://problems/..%2F../statement` reaches `/problems/..%252F..`, and a `/../` URI is "not
found" · a lone surrogate in `q`, and oversized or mistyped args, refused cleanly before any
request · `submissions_watch` answers `timedOut` under the poll interval, stops after 6 failed
polls · both layouts: `problem.xml` wins · unicode test file names load and gate · a validator
rejecting a test, and a model that TLEs on its own tests, both report correctly · presence dedupes
two tabs · the monitor cache key is per contest and freeze-independent · a case-differing clone
code is 409 on the `lower()` unique index · an org-restricted contest clones orgs by id (D88).
**Ruling:** a co-organiser via org (D56) may NOT read the monitor — `canRunContest` is creator or
admin, D56 governs who may JOIN. Left as designed: D95's gate, not an oversight.

## Verify
`-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts` green; contracts + SDK regen left
**no diff**; `vite build` green. Tests per package under `--no-file-parallelism`: web 50/507, mcp
87, prepare 62, judged 123, oj 32, other packages 403, api 114/1007. Live stack NOT probed: every
finding has a repository test, so a registration and a token to revoke bought risk, not evidence.
