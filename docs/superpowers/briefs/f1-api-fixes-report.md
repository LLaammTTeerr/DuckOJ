# F1 — API fixes from the final review (B1, M1–M3, M9, M11, m1)

**DONE_WITH_CONCERNS.** Eight commits on `main`, not pushed. Gate green:
`-r typecheck`, `typecheck:scripts`, `-r lint`, `lint:scripts`, `-r test`
(590 api / 210 web / all packages), regen leaves no diff, `vite build` clean.

`cef600f` B1 · `82bc1b8` M1 · `6be7514` M3 · `67673c0` M2+m1 · `a25a2b5` M9 API
· `badb49b` M11 + M9 web · `80b050c` gate follow-ups · this report.

## Shipped, with red→green evidence
- **B1** `update()` diffs `contest_problems` by `problem_id`: survivors keep
  their id and are UPDATEd in place, new ones INSERTed, removed ones DELETEd;
  after the start a *removal* is 409 `contest_started`. Dead
  `problemsWouldChange` removed. `contest-edit.spec.ts` +3, red first — the
  identical-list edit lost the `contest_submissions` row to the cascade, and
  the in-place relabel was refused 409.
- **M1** `statsFor(userId, actor)` excludes `frozenSubmissionsWhere` rows from
  `solvedCount` (inside the `CASE`) and `points` (best-per-problem `WHERE`);
  `submissionCount` untouched per D23. `frozenSubmissionsWhere` grew an
  anonymous form; the route takes `@MaybeActor()`. New
  `user-stats-freeze.spec.ts` (3), red on rival and anonymous.
- **M3** New `isContestSourceHidden`/`maskHiddenSource` beside the freeze
  context, so `participationEndMs` is never derived twice.
  `SubmissionDetail.source` nullable + required `sourceHidden`. New
  `submission-source-contest.spec.ts` (4), all red first.
- **M2** 5/IP/hour under purpose `register`, 429 `register_rate_limited` +
  `Retry-After`, checked before the hash; every attempt counts (cost, not a
  guessed credential), the 429 records nothing. A taken email answers 201 with
  the same body shape, writes nothing, logs one `warn`; the hash still runs so
  timing does not give it away, and the INSERT race answers the same.
  `register.spec.ts` +4, all red first. Web: `email_taken` dropped from
  `fieldForCode`; copy says what a taken address will look like.
- **M9** Session-only admin route, 403/404/204-idempotent, `totp_reset`
  notification, runbook "A student lost their authenticator" (panel + curl +
  SQL), panel control behind `confirm()`, vi/en keys. `admin-users.spec.ts` +3
  red first; `admin.spec.tsx` +3 mutation-checked.
- **M11** Both admin handlers take the app's try/catch/finally busy shape;
  `disabled={busy}` on the rate buttons, one flag per table so a replay does
  not leave the six beside it live. +3 tests, mutation-checked.
- **m1** `clientIp`'s comment states Caddy's real strip-not-append behaviour, plus a runbook section on what a second proxy layer breaks.

**Rulings:** D26 (metering + email-as-success, residual oracle and NAT cost
stated), D27 (contest source withheld), D28 (problem-list diff; after the start
only a removal is refused — relabel/repoint/reorder/add are now legal).

## Concerns
1. **5/IP/hour is harsh behind NAT** — a school on one address gets five
   accounts an hour. Shipped as briefed; one constant to raise.
2. **The oracle is narrowed, not closed**: after a fake 201 the account still
   does not exist, so login and `GET /users/{username}` distinguish the two at
   one extra request. Closing it needs verify-before-create.
3. **The meter broke fixtures.** `registerAndLogin` now sends a synthetic
   per-user `X-Forwarded-For`; a new test registering >5 users over HTTP from
   one address hits the 429.
4. **B1 left the FK as `ON DELETE cascade`** — `restrict` would make the next
   such bug a 500, but no migration number was allocated.
5. **One flake**: `contest-scoreboard-cache.spec.ts` failed once under the full
   parallel `-r test`, passed alone and on a clean rerun of the whole api suite.
6. M9 ships an admin reset, not recovery codes; `security.tsx` still does not
   warn that none exist (outside this brief).
