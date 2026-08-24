# The find-and-fix sweep (2026-08-22 → 24): ledger

**Trigger:** the user: "automatically run and find problem and dispatch
agent to fix." Three finder agents swept web/API/judging in parallel
while a live probe drove the served stack end to end; every finding was
verified against code before a fix was dispatched. **The weekly API
limit then killed all eight fixer agents mid-flight** — two had finished
(verification mail, submit-409), one left passing sources+tests unrun
(web busy), two left tests-without-implementation, four left nothing.
On reset, the remainder was completed inline, cluster by cluster, under
the same must-fail-first + mutation discipline.

## Fixed, with the finder that caught each

**Live probe (mine):**
- Visible problem with no published tests answered "No such problem" on
  submit → honest 409 `problem_not_submittable` after the visibility
  check (oracle preserved: invisible/nonexistent stay identical).
- Registration never sent the verification mail → sent best-effort
  (mailer outage cannot block signup), full loop tested.
- `PUBLIC_ORIGIN` pointed recovery mails at localhost → tailnet origin,
  proven by reading a real outbound mail.
- Probe corrections: the "failed" reset was my own wrong field name;
  virtual participation already works (my earlier gap survey was wrong).

**API finder:** MixedCase-email users could never receive a reset mail
(eq vs lower — login worked, recovery didn't) · `/users/X/rating` 404'd
where `/users/X` resolved · `%`/`_` were wildcards in user search ·
cursor `12abc` accepted · concurrent open-org join → raw 500 (now
onConflict + contracted 409) · concurrent last-owner removals stranded
an org ownerless — REPRODUCED, now advisory-locked per org ·
`setRated` committed the flag before a replay that can throw, wedging
the whole pipeline (now one transaction: a failed replay rolls the flag
back) · overlapping replays could commit a stale fold last (now
serialised by a replay lock, pinned deterministically after the
Promise.all race test let the no-lock mutant survive) · contest detail
and scoreboard leaked private problems' codes/names pre-start (now
concealed until start except for admins; scoreboard answers the
existing `contest_not_started`).

**Web finder:** transport failures permanently wedged recovery forms /
create-contest / sign-in (no catch, busy never reset) · double-click
minted two tokens or two virtual attempts · the edit form kept problem
A's content and saved it over problem B (keyed remount + seeded-from
tracking; the data-loss path) · deep-linked filters survived a nav
click to plain /submissions (keyed by search) · float points render
raw (deferred — cosmetic, noted below).

**Judging finder:** batched cases summed the batch's inherited total —
a k-case batch worth P recorded k·P, and (k-1)·P where one failure must
zero it (now mirrors the bridge's min/max aggregation; proven over the
real wire protocol) · a failed case write was logged-and-lost while
grading completed "done" with rows missing (now fails the attempt; the
lease retry regrades) · a stalled stale attempt could overwrite the
retry's verdict (in-statement fence on every submissions UPDATE) ·
all-zero dataset made ioi16 scores NaN (guard in lower.ts + the API's
missing-dataset check now rejects zero; 23 goldens byte-identical) ·
the fixed 300s ceiling infinite-looped any legitimately-slow dataset
(dataset-aware ceiling, hard-capped 30 min) · **bonus, found during
the ceiling fix: claim() still pinned limits at Phase 1's 1000 ms/64 MB
— problems displayed real limits and quietly graded at the constants** ·
the subscribe race dropped a terminal update forever (gateway acks;
client re-fetches on the ack).

## Deferred, knowingly

- Float-precision display (cosmetic, touches five screens' formatters).
- Login rate limiting, TOTP enrollment UI, contest editing, disqualify,
  rejudge — from the earlier gap survey, still open features.

## Discipline notes

- Every fix carries a test demonstrated to fail against the broken code
  (or an isolated mutant where the fix landed first), 20+ mutants run.
- Two mutants initially survived and were run to ground: the no-lock
  replay (race window too narrow → replaced with a deterministic
  hold-the-lock test) and a batch mutant that died by compile error
  (re-cut as a semantic mutant).
- Org races were REPRODUCED before fixing (raw unique violation; an
  actually-ownerless org on iteration 1 of 5).
