# Final review — province-ready campaign (`c991ead..HEAD`)

Read-only review of the whole autonomous campaign range on `main`. Every
finding below was verified by reading the code path end to end; two were
checked empirically (a throwaway Caddy container, and read-only inspection of
this host's systemd user units). A suspected finding that did **not** survive
verification is recorded under "Checked and cleared" so it is not
rediscovered as a surprise.

`git diff --stat c991ead..HEAD` — **307 files changed, 56297 insertions(+),
1230 deletions(-)**. Excluding generated and content files (`openapi.json`,
`packages/sdk/src/generated.ts`, `content/problems/**/tests`) the reviewed
surface is roughly 9k lines of source across `apps/api`, `apps/web`,
`apps/judged`, `packages/contest-formats`, `packages/contracts`, `scripts/`,
`deploy/` and `docker-compose.yml`.

---

## Blockers

### B1 — A contest edit deletes every contest submission of a RUNNING contest

`apps/api/src/authz/contest.access.ts:511-529`, reachable from
`apps/web/src/routes/contest-edit.tsx:152`.

`update()` guards a started contest against a problem *change*
(`contest.access.ts:476`, 409 `contest_started`) but not against a problem
*replacement*. When the submitted list is identical, `problemsWouldChange`
returns `false`, no 409 is raised, and control still falls into:

```ts
await tx.delete(contestProblems).where(eq(contestProblems.contestId, contest.id));
// ... re-insert the identical list, with NEW ids
```

`contest_submissions.contest_problem_id` is `ON DELETE cascade` on
`contest_problems.id` (`packages/db/migrations/0008_contests.sql:58`; nothing
in 0009–0015 alters it — 0010 only drops the `points` column). Deleting the
`contest_problems` rows therefore cascades away **every `contest_submissions`
row of that contest**. The comment at `:513` asserts the opposite — *"Safe to
delete because this branch is only reachable before the start (or with an
identical list)"* — and the parenthetical is exactly the unsafe case.

**Failure scenario.** A provincial contest is running. Thirty minutes in the
organiser opens `/contests/tinh-2026/edit` to push `endTime` out by fifteen
minutes (or to set `frozenLastMinutes`, or to fix a typo in the name). The
form prefills and always resubmits the whole body including `problems`
(`contest-edit.tsx:152`); the list is unchanged, so the server accepts it as a
no-op edit and commits. Every submission made in the contest so far loses its
`contest_submissions` row. The scoreboard folds to all-zero for every
participant, `GET /submissions?contest=…` returns nothing, `contestKey` goes
`null` on every affected submission, and a later rating replay rates the
contest as if nobody had submitted. There is no repair path in the
application — the participation→problem mapping is gone — so recovery is a
`scripts/restore.sh` from a nightly backup, which per B3 does not exist on
this host and per M4–M7 is itself unsafe.

**Why the suite does not catch it.** `apps/api/test/contest-edit.spec.ts:246`
("still allows renaming, and takes the values it already has as a no-op")
exercises this exact path but seeds zero submissions, so the cascade is
invisible.

**Fix.** Compute `problemsWouldChange` unconditionally, not only when
`started`, and skip the delete/insert entirely when it is `false`:

```ts
const problemsChanged =
  problemInputs !== undefined && (await this.problemsWouldChange(contest.id, problemInputs));
if (started && problemsChanged) throw new AppError(409, 'contest_started', …);
// …inside the transaction:
if (problemsChanged) { delete; insert; }
```

That keeps the intended "a client that PATCHes the whole form back must not be
told the contest started" semantics while making the no-op an actual no-op.
Regression test: seed a contest with one graded submission, PATCH the
identical problem list, assert `contest_submissions` still holds the row.
Consider additionally changing the FK to `ON DELETE restrict` so the next such
bug is a 500 rather than silent data loss.

### B2 — `JUDGED_CONCURRENCY=2` (the shipped default) lets one job's cancel terminate a different student's grade, permanently

`apps/judged/src/drivers/dmoj/dmoj-driver.ts:135-140`, with the default set at
`apps/judged/src/config.ts:17`, `docker-compose.yml:123` and
`.env.example:27`.

P3 shipped N independent claim loops, default 2, so two jobs are live at once
against the single `judge` container this stack runs. `cancel(jobId, attempt)`
fences on `(jobId, attempt)` only to decide *whether* to fire, and then sends:

```ts
this.bridge.broadcast({ name: 'terminate-submission' });
```

`terminate-submission` carries **no submission id**
(`packages/judge-protocol/src/dmoj-packets.ts:60`) and `broadcast` writes to
every connection unconditionally
(`apps/judged/src/drivers/dmoj/bridge-server.ts:116-118`). There are three
callers: the grading watchdog (`worker.ts:107-114`), cancel-after-failure
(`:181-192`), and `heartbeatOnce` (`:222`). A `terminated` event is terminal —
`worker.ts:144-151` resolves the dispatch and calls `jobs.complete`, and
`event-writer.ts:153-173` writes `state='errored', verdict='IE'` with **no
requeue**.

**Failure scenario.** Two students submit. Loop #1 claims job A, loop #2
claims job B. B is a heavy TLE-prone submission and occupies the one judge. A
sits undispatched and hits its own 300 s ceiling (`worker.ts:30-34`) *because*
B is running. A's watchdog fires → `cancel(A)` → A is live, so an id-less
`terminate-submission` goes to the judge → the judge terminates what it is
actually running, which is **B**. B's owner gets a permanent
"Errored / IE" on a submission that was about to be AC, with no requeue and no
retry. The province admin sees a healthy judge, green healthchecks, and one
student with an inexplicable IE they cannot appeal.

This contradicts `docs/superpowers/briefs/p3-ops-report.md` ("No correctness
issue found") and the runbook's own sequencing at `docs/runbook.md:841`
("**Then, and only then**, raise `JUDGED_CONCURRENCY` to 2 per judge") — the
repo ships 2 with one judge.

**Fix.** Ship `1` in `config.ts:17`, `docker-compose.yml:123` and
`.env.example:27` until cancel can be targeted. The structural fix is the one
`DmojDriver`'s own class comment (`:63-84`) defers: key `live` by
`(job, attempt)`, track which connection is grading which job, and send
`terminate-submission` on that connection only — which needs a submission id
in the packet or a per-connection dispatch map.

### B3 — The nightly backup was never installed on this host, while D17 describes it in the present tense

`docs/DECISIONS.md:190-198` states the backup "writes … nightly at 03:00
Asia/Ho_Chi_Minh (`deploy/duckoj-backup.timer`), and prunes to the newest 14."
Host state, checked read-only:

- `systemctl --user is-enabled duckoj-backup.timer` → **`not-found`**
- `~/.config/systemd/user/` contains only `duckoj.service` (plus its
  `default.target.wants` symlink)
- `~/duckoj-backups` **does not exist**

The boot unit shipped and is enabled with `Linger=yes`; the backup units did
not. This is deployment state rather than a source defect, but it is a blocker
for the campaign's own definition of done ("survive a reboot and a disk
restore") and D17's wording is what makes the gap invisible.

**Failure scenario.** The province admin reads D17, concludes fourteen nightly
copies exist, and plans accordingly. The disk fails in November, or B1 wipes a
contest. There is not one backup — not even the single-site ones D17 already
warns are insufficient.

**Fix.** Run the four commands the runbook already gives at
`docs/runbook.md:691-696`, confirm with
`systemctl --user list-timers duckoj-backup.timer`, and verify a `.dump`
actually lands. Reword D17 to say "install these units" rather than asserting
they run.

---

## Majors

### M1 — The freeze is bypassable through `GET /users/{username}`

`apps/api/src/authz/user.access.ts:117-153` (`statsFor`), served from `:90`.
`solvedCount` is `countDistinct(case when verdict = 'AC' then problem_id end)`
and `points` is `sum(max(points) per problem)`, both over
`problems.visibility = 'public'`, with no contest awareness and no freeze
awareness. D23 names this leak in its own "Out of scope, deliberately" clause
and stops there.

**Failure scenario.** A rated province contest runs on public problems (the
five seeded demo problems are public, and a public contest on public problems
is exactly the configuration D22's banner is written for). The board freezes
for the last hour. A competitor polls `GET /users/rival` every ten seconds.
`solvedCount` ticking 3→4 says the rival just got an AC; `points` moving
210→268 says by how much under partial scoring. That is strictly more than the
board's `pending` count discloses (which says "an attempt exists", not "it
passed"), so the freeze is decorative for anyone who knows the endpoint.

**Fix.** Exclude from both aggregates any submission `frozenSubmissionsWhere`
marks — the SQL form already exists and drops into `statsFor`'s `WHERE` as a
`NOT`. `statsFor` needs an actor parameter (with `null` treated as
non-privileged). Failing that, serve `stats` as `null` for a user with a live
frozen participation. Not fixing it means the freeze should not be advertised
as one.

### M2 — `POST /auth/register` is unauthenticated, unmetered, costs 19 MiB of argon2 per call, and is an email-enumeration oracle

`apps/api/src/authn/auth.controller.ts:86-107`, hash parameters at
`apps/api/src/authn/password.hash.ts:20-25`, error routing at
`apps/web/src/routes/register.tsx:84-88`.

D16 rate-limited *login* (10/identifier, 30/IP per 15 min) and this campaign
shipped the public registration screen that makes this endpoint a normal part
of the product. `register` has no limiter of any kind: `AuthService.register`
(`auth.service.ts:30`) runs `assertAvailable` twice, then
`this.passwords.hash()` — argon2id at `memoryCost: 19_456` (19 MiB),
`timeCost: 2`. The only nearby limit is inside `sendVerification` (5/hour
keyed on the *newly created* userId — one per new account, so it caps
nothing).

Two consequences, one endpoint:

1. **Resource exhaustion.** One host issuing 200 concurrent
   `POST /api/auth/register` puts each of the four `API_WORKERS` — one
   JavaScript thread apiece — in front of a native argon2 wanting 19 MiB and
   two passes. The event loop stalls, `/healthz` times out, podman restarts
   the container, and students cannot sign in. No attack sophistication
   required, and unbounded `users` rows accumulate that are indistinguishable
   from real students at seating time (D19).
2. **Enumeration.** `fieldForCode` (`register.tsx:84-88`) routes `email_taken`
   to the email field and renders the server's `detail` verbatim
   (`:169`). An anonymous visitor submits a throwaway username with a target's
   email and reads "that email is already registered". This contradicts the
   app's own posture two files over: `account-recovery.tsx:70-77` carries an
   explicit comment that forgot-password answers identically whether or not
   the account exists. Combined with the missing rate limit, the whole
   province's student roster is enumerable by email in an afternoon. The root
   cause is the contract (`packages/contracts/src/auth.ts:54` defines the
   distinguishing 409 codes), so this needs an API fix, not just a web one.

**Fix.** Apply the existing `RateLimiter` to `register` *before* the hash runs,
keyed `ip:<clientIp(req)>` on a small window (a judgement — e.g. 5/IP/hour),
refusing 429 with `Retry-After` as login does. Separately, make `email_taken`
indistinguishable from success at the API (accept the request, send a
"someone tried to register with your address" mail instead), or at minimum
stop routing it to a field the page renders.

### M3 — `source_access = 'solved'` hands a competitor a rival's contest source, live

`apps/api/src/authz/submission.visibility.ts:96` —
`return ctx.sourceAccess === 'solved' && ctx.viewerHasAc && ctx.viewerCanSeeProblem`
— combined with D23's explicit ruling that "`source` is NOT masked".

`canViewSubmission` grants the whole submission, `source` included, to anyone
holding an AC on a problem whose `source_access` is `solved`. That predicate
has no notion of a contest, so it applies unchanged while a contest is running
and while its board is frozen. This campaign made the setting a two-click
control on the problem edit screen (P10,
`apps/web/src/routes/problem-edit.tsx`) whose label describes practice
semantics and says nothing about contests.

**Failure scenario.** A setter opens source access on a practice problem so
students can compare solutions — precisely what the new select invites. The
problem is later reused in a school contest. The first competitor to solve it
can `GET /submissions?problem=X` and read every rival's accepted C++ for the
remaining hours.

**Fix.** Add a contest clause to `canViewSubmission` *and*
`visibleSubmissionsWhere` (one clause each, in the shared predicate): a
submission carrying a `contest_submissions` row whose participation has not
ended is visible only to its submitter, the contest's creator, and global
admins — the solver clause does not reach it. If the ruling is kept, the P10
select must warn that it applies during contests, and D23's "out of scope"
must become a documented contest-day operating instruction.

### M4 — `restore.sh` reads `COMPOSE_PROJECT` but `podman-compose` reads `COMPOSE_PROJECT_NAME`, so the documented worktree invocation restores the live database while stopping nothing

`scripts/restore.sh:55` sets `PROJECT` from `COMPOSE_PROJECT` and uses it only
for the container **label lookup** (`:62-69`). `"$COMPOSE" stop $SERVICES`
(`:90`) and `"$COMPOSE" start` (`:121`) invoke `podman-compose`, which derives
its project from the working directory or from `COMPOSE_PROJECT_NAME` — which
is never exported. `docs/runbook.md:653-657` documents this exact usage ("From
a git worktree, pass `COMPOSE_PROJECT=duckoj`"), as does restore.sh's own
header at `:19`.

**Failure scenario.** The admin is in a worktree at `~/duckoj-fix/` and runs
`CONFIRM=yes COMPOSE_PROJECT=duckoj scripts/restore.sh ~/duckoj-backups/duckoj-…`.
The label lookup correctly finds the **live** `duckoj_postgres_1`.
`podman-compose stop api judged` targets project `duckoj-fix`, which has no
containers, and prints nothing alarming. `pg_restore --clean` then drops and
recreates every table underneath a live `api` and a `judged` mid-`UPDATE
grading_jobs` — the exact hazard the comment at `:82-86` says it is
preventing.

**Fix.** `export COMPOSE_PROJECT_NAME="$PROJECT"` before the `$COMPOSE` calls,
or refuse to run when `basename "$PWD" != "$PROJECT"` without an explicit
override. `backup.sh` has the same asymmetry but is read-only, so it is
harmless there.

### M5 — `restore.sh` leaves `api` and `judged` stopped when the volume import fails

`scripts/restore.sh:114` — `podman volume import` is unguarded under `set -eu`
(`:40`) with no `trap`. On failure the script exits and `:118-122`
(`$COMPOSE start $SERVICES`) never runs.

**Failure scenario.** The admin restores after a bad migration from a tar
copied off a USB stick that was pulled early. `podman volume import` exits
non-zero, the script dies, and the site stays fully down — Caddy up, API
stopped — until someone notices and runs `podman-compose start api judged` by
hand. The database is already restored at that point, so the outage is pure
operator confusion.

**Fix.** `trap 'restart_services' EXIT`, or wrap the import so the writers come
back on every exit path.

### M6 — A genuinely failed `pg_restore` only warns, then the writers are restarted onto the wreckage

`scripts/restore.sh:101-104`. A non-zero `pg_restore` prints
`WARNING: … review the output above` and execution continues to the volume
import (`:113-116`) and to starting `api`/`judged` (`:118-122`). The reasoning
for omitting `--exit-on-error` is sound — a `--clean` reload into a fresh
database emits benign "does not exist" noise — but the consequence is that
*no* failure mode stops the script.

**Failure scenario.** A restore into a database whose disk is full fails
partway; half the tables exist, half do not. One WARNING line scrolls past
among forty lines of output, the script prints "Restore complete", and `api`
and `judged` start serving and grading against a half-restored schema.

**Fix.** Capture `pg_restore`'s stderr, filter the known-benign
`does not exist, skipping` lines, and fail hard — leaving the writers stopped
with a printed instruction — if anything else remains. At minimum, suppress
the "Restore complete" line when the warning fires.

### M7 — `restore.sh` never runs migrations after the reload

No `migrate` invocation anywhere in `scripts/restore.sh` (verified by grep over
the whole 124-line file). The dump carries the schema as of backup time,
including the drizzle migrations table, and `--clean` replaces the live schema
with it.

**Failure scenario.** A migration ships on 2026-09-10. On 09-12 something
breaks and the admin restores the 09-05 backup. The database is now at the
09-05 schema while the running images are 09-12 code. The stack comes up (the
healthcheck touches no new column) and the first request against the new
column 500s — exactly the "schema drift that announces success" failure
`compose-up.sh:130-141` was written to prevent, reintroduced through the
restore path.

**Fix.** Run the migrate step after the DB reload and before starting the
writers (`podman-compose up --no-deps --force-recreate migrate`, with the same
exit-code check `compose-up.sh:152-162` does), and document it in the
runbook's Restoring section.

### M8 — Backups are written world-readable, into a world-readable directory

`scripts/backup.sh:65` — `mkdir -p "$DEST"` with no `umask` anywhere in the
script (`set -eu` at `:34` is the whole prologue) and no `chmod` on the
artefacts (verified by grep: neither word appears in the file). Under the
default 022 umask that is `drwxr-xr-x` and `-rw-r--r--`. The dump contains
every `users` row: argon2id password hashes, email addresses and display names
of students (minors), session and token hashes, and encrypted TOTP secrets.

**Failure scenario.** The province host has a second account for the IT
contractor, or a compromised low-privilege service. `cat
~lamter/duckoj-backups/*.dump` walks off with the whole identity table for
offline cracking, and nothing in the stack logs the read.

**Fix.** `umask 077` immediately after `set -eu`, and `chmod 700 "$DEST"`
after the `mkdir`. State the intended modes in the runbook's Backups section
so drift is visible.

### M9 — TOTP is a one-way door: a lost authenticator loses the account, with no recovery path and no warning

`apps/web/src/routes/security.tsx:143` (the enrolment control shipped by P1-B),
against `apps/api/src/authn/totp.controller.ts`.

Verified across the stack: only three TOTP endpoints exist
(`packages/contracts/src/totp.ts:32,50,67`); there are no recovery or backup
codes anywhere in the contracts; `DELETE /auth/totp` is `@SessionOnly()`
(`totp.controller.ts:13,32`), i.e. behind the very factor that was lost; there
is no admin TOTP-reset surface (nothing under `apps/api/src/admin/` or
`scripts/` references TOTP); and password reset does not clear it
(`account-recovery.service.ts` contains no TOTP reference). `docs/runbook.md`
documents no SQL fallback for it either.

**Failure scenario.** A contestant enables 2FA the night before the contest —
the screen this campaign shipped invites exactly that — and loses or wipes
their phone. They are locked out permanently. There is no self-service path,
no admin path, and no documented DBA path. On contest morning the organiser
can do nothing for them.

**Fix.** API-side: recovery codes at enrolment, or an admin reset endpoint
(admin-only, `@SessionOnly`, audited). Web-side and immediately: extend
`security.intro`/`security.scanNote` (`i18n/en.ts:406-424`) to state plainly
that there are no recovery codes and that losing the authenticator loses the
account, and gate `Enable` behind a confirmation. Document the
`delete from user_totp where user_id = …` fallback in the runbook meanwhile.

### M10 — The boot unit sets `SKIP_BUILD=1`, and the runbook has no section about the boot unit at all

`deploy/duckoj.service:23` sets `SKIP_BUILD=1`; `scripts/compose-up.sh:100-105`
then skips `$COMPOSE build` while `:179` and `:188` still `--force-recreate`
from whatever image is on disk. That script's own comments (`:130-141`,
`:165-177`) argue at length that a bring-up which reports healthy while
running the previous build "does not fail, it lies."

Compounding it: `docs/runbook.md` has **no section for
`deploy/duckoj.service`**. Its install steps exist only in the unit file's own
header (`:9-13`); the runbook mentions the file once, in passing, from inside
the Backups section (`:691`, `:705`). An operator reading the runbook end to
end never learns the boot unit exists, what `SKIP_BUILD=1` means, or that a
redeploy after `git pull` must be a manual `scripts/compose-up.sh` without it.

**Failure scenario.** The admin pulls a fix, rebuilds by hand, everything is
green. Two weeks later the host reboots. `duckoj.service` recreates containers
from the images on disk — possibly predating a `git pull` someone did in
between. The stack reports fully healthy while serving old code, and the
checkout on disk says otherwise.

**Fix.** Add a "Surviving a reboot" runbook section: install steps,
`loginctl enable-linger`, and an explicit "this unit never rebuilds — after any
code change run `scripts/compose-up.sh` by hand." Optionally have the unit log
the image IDs it started so a stale boot is visible in `journalctl`.

### M11 — The two admin write handlers have no error handling and no busy flag; the rating replay is double-clickable

`apps/web/src/routes/admin.tsx:32-49` (`grant`) and `:94-131` (`setRated`).
Neither has `try/catch`, neither sets a busy flag, and the rate button at
`:139` has no `disabled` (the only `disabled` in the file is on the grant
button, gated on an empty username). Every other write in this app follows the
documented `try { … } catch { setError(t('common.networkError')) } finally {
setBusy(false) }` shape — `submission.tsx:49-70` is the pattern. Pre-existing
in shape, but this campaign localized these handlers and left the gap.

**Failure scenario.** (a) The API restarts mid-request; openapi-fetch rethrows
network-level failures rather than resolving to `{ error }`, so the admin gets
an unhandled rejection in the console and nothing at all on screen. (b) The
admin double-clicks "rate" and fires two rating replays of the operation this
file's own header calls "the most consequential retroactive operation in the
system (it rewrites every rating that follows)".

**Fix.** Add `busy` state and the standard `try/catch/finally` to both, and
`disabled={busy}` on the rate button.

---

## Minors

- **m1 — `clientIp`'s reasoning is wrong, though its result is right.**
  `apps/api/src/authn/auth.controller.ts:58-64`. The comment says the first
  `X-Forwarded-For` entry "is the one Caddy prepends" and later entries are
  client-supplied. Verified empirically against
  `docker.io/library/caddy:2-alpine` (v2.11.4, the tag compose pins) with the
  repo's own `reverse_proxy` shape: a request carrying
  `X-Forwarded-For: 9.9.9.9` arrives upstream as
  `x-forwarded-for: 127.0.0.1`. Caddy ≥ 2.7 *strips* `X-Forwarded-*` from
  untrusted clients (no `trusted_proxies` is configured, so all are untrusted)
  rather than appending. **There is no per-IP rate-limit bypass today.** The
  fragility is that the code reads `[0]` of a list on the theory that a proxy
  prepends; the day province IT fronts Caddy with nginx or a cloud LB — which
  do append — that entry becomes attacker-controlled and D16's 30/IP window is
  bypassable with one header. Fix: state the real invariant in the comment and
  note in the runbook that a second proxy layer requires revisiting `clientIp`.
- **m2 — Session audit rows record the proxy's address.**
  `auth.controller.ts:150-153` passes `ip: req.ip`, which is the socket address
  because `trust proxy` is deliberately unset — i.e. the Caddy container's
  compose-network address, identical for every session ever issued. Fix: pass
  `clientIp(req)`, the function two dozen lines above.
- **m3 — `rate_events` grows without bound under identifier spray.**
  `apps/api/src/common/rate-limiter.ts:100-111`. Cleanup is opportunistic and
  *per key*: a key's expired rows die on that key's next attempt. Login records
  one row per failure under `user:<submitted identifier>`, so an attacker who
  never repeats an identifier leaves rows nothing will ever revisit (~8.6M/day
  at 100 req/s). Fix: a periodic sweep, in the API or in the nightly slot.
- **m4 — A running contest's `startTime`/`endTime` are editable with no guard,
  and moving them voids submissions.** `contest.access.ts:466-484`. The
  `started` guard covers `format` and `problems` only. For a `LIVE`
  participation in a contest with no time limit, `participationStartMs` /
  `participationEndMs` (`packages/contest-formats/src/window.ts:51,73`) are the
  contest's own boundaries, and `lower()` drops any submission outside them
  (`lower.ts:253-256`). Fix: refuse a `startTime` change on a started contest,
  and either refuse an `endTime` that would void existing submissions or say
  plainly on the edit screen what shrinking the window does.
- **m5 — The edit form truncates seconds off the contest window.**
  `apps/web/src/routes/contest-edit.tsx:49-56` (`toLocalInput`) renders
  `YYYY-MM-DDTHH:mm`, and `save()` sends it back as an ISO instant. A contest
  created via API or seeding at `10:00:37Z` comes back `10:00`, so an
  otherwise-untouched save moves the boundaries by up to 59 s — `endTime`
  *earlier*, which with m4 can void a genuinely last-minute submission.
- **m6 — Clearing the freeze field silently disables the freeze.**
  `contest-edit.tsx:135-139`: `Number('')` is `0` and `Number.isInteger(0)` is
  true, so an empty input passes validation and PATCHes `frozenLastMinutes: 0`.
  The input is also a bare text field with no `type="number"`. Fix: reject
  `freeze.trim() === ''` before the conversion.
- **m7 — Rejudge's `submission_cases` inserts are not fenced (transient).**
  `apps/judged/src/event-writer.ts:35` checks `isCurrentAttempt` once per
  `apply`, then inserts case rows unfenced (`:105-119`) while every
  `submissions` UPDATE *is* fenced by `fencedById` (`:64`). The fence itself is
  correct end to end — `RejudgeService.requeueAll`
  (`apps/api/src/authz/rejudge.access.ts:196-207`) bumps `attempt` on the same
  `grading_jobs` row `fencedById` subselects. The gap is check-then-act on case
  rows: a stale insert can land after `requeueAll` deleted the old ones, and
  until the re-claim's first case, `getVisible`'s `max(attempt)` picks the
  stale attempt and shows old per-case verdicts beside a `queued` submission.
  Self-healing within one grading cycle.
- **m8 — `After=/Wants=network-online.target` is a no-op in a systemd *user*
  manager.** `deploy/duckoj.service:16-17`. The user manager has no such
  target (confirmed absent via `systemctl --user list-unit-files`), while
  `podman-user-wait-network-online.service` *is* present and static — the unit
  that exists for exactly this. The ordering is silently dropped, so at boot
  `compose-up.sh` can start before the network is usable; the generous
  timeouts (`:24-27`) mask it most of the time.
- **m9 — The backup unit will start a deliberately-stopped stack at 03:00.**
  `deploy/duckoj-backup.service:21-22` — `Wants=duckoj.service` pulls the stack
  up whenever the backup runs, contradicting the header's own stated intent
  (`:17-20`) that a down stack should make `backup.sh` exit loudly. Fix: drop
  `Wants=`, keep `After=`.
- **m10 — A non-numeric `KEEP` fails the run after a good backup is on disk.**
  `scripts/backup.sh:41,108`: `[ "$KEEP" -gt 0 ]` errors in `/bin/sh` on a
  non-integer and `set -eu` exits non-zero, so systemd records a failure for a
  backup that succeeded. Validate `KEEP` at the top.
- **m11 — A timed-out backup leaves `.partial` files nothing cleans up.**
  `deploy/duckoj-backup.service:36` (`TimeoutStartSec=1800`) kills the script
  mid-`pg_dump`, so the `rm -f` cleanups (`backup.sh:76,93`) never run, and the
  prune glob (`:109,113`) matches only `*.dump`. Remove stale
  `$DEST/duckoj-*.partial` at the start of each run.
- **m12 — `bootstrap:admin` promotes a squatted username with only a weak
  signal.** `scripts/bootstrap-admin.ts:83-92`. On a deployment with public
  registration, if someone registered the intended username first, the
  operator's `bootstrap:admin admin` promotes *that* account. This is
  D19-sanctioned and pinned by `packages/db/test/bootstrap-admin.spec.ts:139-168`,
  but nothing prints *who* is being promoted. Fix: print the existing account's
  email and `createdAt` on the promote path, or require an explicit
  `--promote`.
- **m13 — `--password` immediately before another flag swallows it.**
  `scripts/bootstrap-admin.ts:146-155`: `--password --email x` yields the
  literal password `--email`. Only ≥10-character strings survive the check at
  `:97`, so in practice only the token `--password` itself slips through.
  Contrived; reject values starting with `--`.
- **m14 — The "restore was exercised" caveat did not reach the runbook.**
  `docs/superpowers/briefs/p3-ops-report.md` states plainly that the stop/start
  path "is designed, not executed" and that "the first real restore should be
  watched, not trusted." `docs/runbook.md:665-671` describes the behaviour in
  the indicative with no such caveat, and that is the document read at 2 a.m.
- **m15 — Nothing alerts when a backup fails.** `Type=oneshot` with no
  `OnFailure=`. A nightly `pg_dump` that starts failing is visible only in
  `journalctl --user -u duckoj-backup`. D17 acknowledges the unmonitored
  property, so this is a known cost rather than a defect.
- **m16 — `?verdict=` filtering silently hides frozen rows with no UI hint.**
  `apps/web/src/routes/submissions.tsx:117-131`. The API exclusion is correct
  and deliberate (D23 — otherwise the filter is a nine-probe oracle), but
  during a freeze a competitor filtering by `AC` sees a shorter list than
  reality with nothing explaining why.
- **m17 — The freeze banner drops the date, which misleads a virtual
  entrant.** `apps/web/src/routes/contests.tsx:392-396`. `frozenAt` is the
  *contest's* freeze instant (`lower.ts:275,287`) while `frozen` is
  per-participation (`:281-283`). A virtual entrant three weeks after the
  contest sees "Bảng điểm đang đóng băng từ 16:00", which reads as today. Fix
  on the web: use `formatDateTime` when `frozenAt` is not today; the deeper fix
  is serving the viewer's own freeze instant.
- **m18 — `translate` has no missing-key fallback, and three dynamic lookups
  bypass the guards that exist.** `apps/web/src/i18n/index.tsx:102-108`.
  `verdictName` (`:174-177`) and `globalRoleLabel` (`:188-191`) guard with
  `key in en`; the template lookups at `problem-edit.tsx:252,294` and
  `problem-revisions.tsx:213` do not. An unrecognised enum value from the API
  renders **blank**, and had any such key taken a variable, `template.replace`
  at `:105` would throw and take the render down. Fix: fall back to the key.
- **m19 — Two dead i18n keys and a related a11y gap.**
  `apps/web/src/i18n/en.ts:39-40` / `vi.ts:34-35` define
  `nav.languageVi`/`nav.languageEn`, used nowhere. They pair with
  `router.tsx:79`, where `aria-label` sits on a `<span>` whose implicit role is
  `generic` — so screen readers announce two unlabelled buttons reading "VI"
  and "EN". Fix both together: `role="group"` on the span and those two keys as
  the buttons' labels.
- **m20 — Register retry after a partial success accuses the user of taking
  their own username.** `apps/web/src/routes/register.tsx:147-192`.
  `handleSubmit` always POSTs `/auth/register` first with no flag recording
  that the account already exists, so when the chained `/auth/login` fails
  (rate limit, transient 500) and the user clicks again they are told "Tên đăng
  nhập đã được sử dụng" about the name they just chose. Fix: a `registered`
  state flag so a retry skips to the login call.
- **m21 — The mobile table scroll container is not keyboard-reachable.**
  `apps/web/src/app.css:448-456` makes `table` a `display: block;
  overflow-x: auto` scroller under 700px with no `tabindex="0"`, so a
  keyboard-only user cannot reach the hidden columns (WCAG 2.1.1).
- **m22 — `.dq td { color: var(--muted, inherit) }` is dead.**
  `apps/web/src/app.css:426-429`. `--muted` is defined nowhere; the variables
  are `--fg` (`:134`) and `--dim` (`:135`), so the fallback always wins.
  Cosmetic only — the strike-through and `[DQ]` marker still carry the state.
- **m23 — The submit page never says which contest it is submitting into.**
  `apps/web/src/routes/submit.tsx:484-491`. `contestKey` is threaded correctly
  (`router.tsx:426-429` → `:310` → `:462`) but never rendered, on the one
  screen where the practice-vs-contest choice is actually made.

---

## Checked and cleared

Verified, no finding:

- **Route markers.** `corepack pnpm --filter @duckoj/contracts test` — 18/18,
  including `route-coverage.spec.ts` and `scopes.spec.ts`. Every new route
  (`PATCH /contests/{key}`, `PATCH /contests/{key}/participants/{username}`,
  `POST /admin/submissions/{id}/rejudge`, `POST /admin/problems/{code}/rejudge`)
  carries exactly one marker. Both new admin controllers are `@SessionOnly()`
  at the class with the admin check in `RejudgeService.requireAdmin`
  (`rejudge.access.ts:312`), matching the convention. Reads answer 404 for
  invisibility (`update` → `NOT_FOUND`), and `setDisqualified`'s deliberate 403
  is documented with its reasoning.
- **Login rate-limit bypass via `X-Forwarded-For`.** Empirically disproved —
  see m1. The 429 is also raised *before* the password is checked
  (`auth.controller.ts:172`), so a limited caller costs no argon2 and gets no
  timing oracle; only failures record, and the 429 itself records nothing, so a
  shared IP drains.
- **Cluster mode.** Nothing in the API holds cross-request state a second
  process would break: the rate limiter and sessions are in Postgres, TOTP
  keeps no in-process replay cache (`totp.service.ts` is stateless,
  `window: [1, 0]`), the WebSocket gateway's `clients` map is intentionally
  per-worker with Redis fan-out (`submission-publisher.ts`), and
  `ScoreboardCache`'s only in-process state is the coalescing `inFlight` map,
  which is per-key deduplication and correct at any worker count.
  `resolveWorkerCount` (`cluster.ts:60`) rejects non-integers loudly rather
  than defaulting, with an empty-string carve-out for Compose.
- **Scoreboard cache poisoning across views.** `scoreboardCacheKey`
  (`scoreboard.cache.ts:71`) separates `:priv` from `:pub:<phase>`;
  `getScoreboardCached` (`contest.access.ts:186`) reads one clock, calls
  `loadVisible` (404 for an invisible contest) *before* touching the cache, and
  folds the privileged view with no clock at all. `computeScoreboard` takes no
  actor, so the body is not viewer-dependent beyond that split.
  `scoreboardForSystem` bypasses the cache entirely (`:250`). Invalidation
  covers disqualify, edit (both old *and* merged key sets) and rejudge; `join`
  does not invalidate, which the 2 s TTL makes immaterial. `RedisScoreboardCacheStore`
  swallows every failure and `ScoreboardCache` swallows a rejecting store, so a
  Redis outage degrades to folding rather than to 500s.
- **Freeze boundary, off-by-one.** `freezeAtMs`/`isFrozenAt`
  (`window.ts:104,114`) are closed at the freeze and open at the end, and are
  the single derivation used by `lower()`, `isSubmissionFrozen`, and the cache
  key — no second copy anywhere.
  `corepack pnpm --filter @duckoj/contest-formats test` — 118/118 green,
  including `freeze.spec.ts` (15) and all 27 goldens byte-identical.
- **Freeze masks via filters, sorting, WebSocket.** `?verdict=` is excluded in
  SQL (`submission.access.ts:257-266`) rather than thinned from `items`, so the
  keyset cursor stays sound; `?problem=`, `?user=` and `?contest=` only narrow
  an already-`visibleSubmissionsWhere` set and disclose no outcome; the list has
  no sort parameter (always `id` desc); `SubmissionsGateway` publishes
  `{ type, id }` only and the client's re-fetch goes back through `getVisible`,
  which masks; the scoreboard's own ranking is computed from the frozen values,
  so rank order leaks nothing. `frozenSubmissionsWhere` is never reached with a
  null actor — all three `SubmissionsController` routes are `@CurrentActor()`.
  The freeze UI is correct: the web renders `?` rather than `—` for a frozen
  row (`submissions.tsx:190-199`) and `VerdictPanel` checks `frozen` *before*
  the verdict branches (`submit.tsx:139-148`), so a masked row cannot read as
  "not yet judged".
- **Rejudge fencing vs judged claim.** `requeueAll` bumps `attempt` on the
  existing `grading_jobs` row rather than inserting a second one, which is
  exactly what makes `EventWriter.fencedById` (`event-writer.ts:64`) fence a
  judge still grinding on the pre-rejudge attempt; `JobStore.complete`
  (`job-store.ts:132`) additionally requires the old attempt *and*
  `state='leased'`. `JobStore.claim` uses `FOR UPDATE SKIP LOCKED`
  (`job-store.ts:82`), so N claim loops are safe. See m7 for the one transient.
- **`assertFreezeFits`.** Runs against the merged state in both `create` and
  `update` (`contest.access.ts:340,459`), so shrinking a contest under a stored
  freeze is refused; negatives are refused by Zod `.min(0)` and again in
  `lower()` (`lower.ts:208`).
- **i18n key parity.** `apps/web/test/i18n.spec.tsx:30-37` compares sorted key
  arrays with `toEqual` — genuinely bidirectional, and it does catch an orphan
  key in `vi.ts` that `satisfies` cannot see. Backed by NFC normalization
  (`:39`), non-blank values (`:48`) and per-key placeholder-set matching
  (`:54-63`). All 31 placeholder-bearing keys were checked against their call
  sites: no mismatches. No hardcoded user-visible strings bypass `t()` — the
  only literals are example placeholder data and the product name.
- **XSS.** `dangerouslySetInnerHTML` appears twice (`problem.tsx:83`,
  `problem-edit.tsx:220`), both through `renderStatement`, where `markdown.ts`
  runs `DOMPurify.sanitize` last. Every server `detail` string reaches the DOM
  as a React text child.
- **Locale persistence.** Storage reads and writes are individually try/caught
  (`i18n/index.tsx:70-92`), the bare-render fallback resolves lazily rather
  than at module load (`:128-132`), and `<html lang>` follows via effect
  (`:146-148`).
- **`backup.sh` secret handling and atomicity.** `pg_dump` runs via
  `podman exec` over the container's local socket (`:75`) — no password on any
  command line, in the environment, or in the output; `duckoj-backup.service`
  correctly carries no `POSTGRES_PASSWORD`. Both artefacts go to `.partial` and
  are renamed only after exit 0, with `rm -f` on failure (`:69-98`), so a failed
  `pg_dump` leaves nothing `restore.sh` would accept. A missing `package_store`
  volume is a hard failure rather than a silent DB-only backup (`:84-89`). The
  only exposure is the file mode — M8.
- **Pruning.** `ls | sort | head -n $doomed` over `duckoj-*.dump` is
  chronological given the `YYYYmmdd-HHMMSS` stamp, deletes oldest-first, and
  removes the matching `.tar` alongside (`:105-119`). It counts dumps, never
  pairs, so it can neither orphan a tar nor prune the newest; `.partial` files
  are excluded by the glob.
- **Backing up a live package volume.** `apps/api/src/packages/package.store.ts:75-78`
  writes to a random temp name in the same shard directory then `rename()`s, so
  a concurrent `podman volume export` captures a whole file or a stray `.tmp-*`,
  never a torn one. No quiesce needed.
- **systemd shapes and timer semantics.** `Type=oneshot`+`RemainAfterExit=yes`
  is correct for `duckoj.service`; `Type=oneshot` with no `[Install]` is correct
  for the backup service; `WantedBy=default.target` / `timers.target` are the
  right user-manager targets; `WorkingDirectory=__REPO__` is set on both;
  `loginctl enable-linger` is documented in both unit headers and in the
  runbook, and `Linger=yes` is actually set on this host.
  `OnCalendar=*-*-* 03:00:00 Asia/Ho_Chi_Minh` pins the timezone in the
  expression as D17 claims, and `Persistent=true` covers the
  powered-off-for-four-days case. `COMPOSE_PROJECT=duckoj` and the default
  `STORE_VOLUME` match the live `duckoj_package_store`.
- **The Dockerfile change weakens nothing shipped.**
  `pnpm --filter "@duckoj/api..." exec tsc -b` still builds
  `apps/api/tsconfig.json`, whose `include` is `["src"]`, so a type error in
  shipped code still fails the image build. The dropped half
  (`tsc --noEmit -p tsconfig.test.json`) is still run in CI via
  `pnpm -r typecheck`; the `rootDir: ".."` change is what lets it reach
  `apps/judged/src`.
- **`JUDGED_CONCURRENCY` parsing.** An unparseable value fails loudly (zod
  `min(1).max(16)`; `''`→0 and `abc`→NaN both throw with the variable named).
  The hazard is entirely in the driver — B2.
