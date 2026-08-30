# Decisions

Answers to the questions this project had left open. Each entry says what was
decided, who decided it, and what it costs — so a later reader can tell a
deliberate choice from an accident.

Decided by the project owner on **22 Aug 2026** unless noted.

---

## D1 — Email is sent over SMTP

**Resend or plain SMTP**, at the implementer's discretion. Resolved as **one
SMTP implementation**: Resend publishes SMTP credentials (`smtp.resend.com`),
so a single transport satisfies both answers and leaves the provider a matter
of configuration rather than of code.

Closes foundation §15 question 4.

## D2 — Build order after Phase 3e

Left to the implementer. Taken as: **email first**, because it was the question
that got a concrete answer and it closes a real operational hole — today a
forgotten password is unrecoverable without database access. **UI screens next.**

## D3 — Ratings do not decay with inactivity

Glicko-2 grows rating deviation across an inactive rating period, but a contest
is our rating period, so nothing in the data says how much time passed.

**No decay is applied.** `applyInactivity` remains implemented and pure, called
by nothing. This is the reversible option: adding decay later replays the whole
history under the new policy, whereas removing it cannot restore what it moved.

## D4 — Regrading a problem changes rating history

Left to the implementer; the existing behaviour stands.

Foundation §9 asks for both a deterministically recomputable history and
corrections that replay forward. Those reconcile only if "deterministic" means
*a pure function of current database state* rather than *a frozen past*. So a
regrade, a late disqualification or a corrected scoreboard all propagate
forward into every rating that followed.

**Cost:** a rating a user saw last week can change. That is the point — the
alternative accumulates permanently wrong ratings, which is the failure
foundation §9's own text warns about.

## D5 — Rating is applied manually, never automatically

A contest is rated when an administrator says so. "The contest ended" and "the
results are final" are different claims, and the gap between them is where
broken test data gets found.

## D6 — Rank titles are a placeholder behind an adapter — SUPERSEDED by D46

Deferred as a product decision, with a working placeholder in the meantime,
modelled on **Codeforces or chess.com**.

Implemented as a pure band table behind one function, so replacing the names
and thresholds is a data edit rather than a code change.

Partially closed foundation §15 question 1 — the *thresholds and names*
remained open; the mechanism did not.

**Superseded (2026-08-29, D46).** The names are real now, in both locales,
and the mechanism this entry chose is what made that a one-file edit —
which is the outcome it was betting on. Foundation §15 question 1 is
closed.

## D7 — No consent is required to be added to an organization

An owner or admin adds members directly; there is no accept/decline flow and no
invitation entity.

**Cost:** a user can appear on a roster they did not ask to join. Being listed
grants access to that organization's problems and nothing of the user's, which
is why this is acceptable and why it is written down rather than assumed.

## D8 — Usernames are permanent

A rename would have to decide what happens to every existing citation of the
old name — scoreboards, submissions, problem authorship, external links. Not
worth it.

## D9 — Avatars are deferred

`users.avatar_key` exists, nothing writes it, and no URL scheme resolves it. It
stays out of the profile DTO until UI work needs it, because returning a key
nobody can dereference is worse than omitting the field.

## D10 — Statements are expected in Vietnamese **and** English

Both locales are real. Nothing multi-locale is built yet — `problems.statement`
is a single column — so this is a **known future migration**, recorded here so
it is designed for rather than discovered.

Closes the second half of foundation §15 question 3; the i18n library remains
unchosen and unneeded until UI text is localised.

## D11 — Submissions and grading history are kept forever

No retention policy. Revisit when storage cost is a real number rather than a
hypothetical one.

Closes foundation §15 question 6.

## D12 — No prerendering for public problem pages

No link-preview or search-indexing work. Revisit if public traffic ever
justifies it.

Closes foundation §15 question 5.

---

## Still open

- ~~**Rank title names and thresholds**~~ — closed by D46.
- **Frontend component library** — foundation §15 question 2. The retro
  terminal design is hand-written CSS, so nothing has needed one yet.
- **i18n library** — needed when UI text is localised, not before.

## D13 — Rate limiting on account recovery is DB-backed, 5/email/hour

A fixed one-hour window counted in a `rate_events` table, keyed by
`(purpose, key)` where the key is the lowercased email. No Redis, no
in-memory state: DB-backed is the only variant that is deterministic in
tests and correct across multiple API instances. The endpoint still
answers success — a rate-limited request is silently dropped, exactly like
an unknown email, so the limiter leaks nothing.

Applies to password-reset requests and verification sends. Chosen
autonomously under the 2026-08-22 "automate the rest" directive; the
number 5 is a guess and is one constant to change.

## D14 — Notifications are in-app only, three kinds

A `notifications` table (`user_id, kind, payload, read_at`), a list
endpoint and a mark-read endpoint, a bell in the nav. Kinds: org join
request received (to deciders), org join request decided (to requester),
global role granted. No email digests, no per-kind preferences — both are
easy to add and impossible to remove.

## D15 — Statement rendering is parked; nothing was built

First drafted as a `StatementRenderer` port modelled on `Mailer`, with a
Typst adapter activating where a `typst` binary exists. **No binary
exists on this machine**, installing one requires asking (the standing
ask-before-installing instruction outranks "don't stop"), and a port
with a null adapter and no consumer is dead scaffolding — so nothing
was built (2026-08-22 ruling, Phase 7c ledger). Statements render fully
today via Markdown+KaTeX.

**Resolved the same day:** the user approved installing typst, and the
port shipped as designed — `TYPST_BIN` config, `TypstStatementRenderer`
with mitex for math, 501 when unconfigured. Phase 7b ledger.

## D16 — Login is rate limited: 10 per identifier and 30 per IP, per 15 min

Counted in `rate_events` under purpose `login`, reusing D13's DB-backed
fixed-window limiter for the same reasons: deterministic under test and
correct across several API instances. Two windows, checked together,
because they stop different attacks — the per-identifier one stops a
single account being ground down, the per-IP one stops one host spraying
one password across many accounts, which the first never sees.

**Only failed attempts count.** A successful sign-in consumes nothing, so
someone who genuinely signs in all day is never affected; and a refused
(429) request records nothing either, so the window drains rather than a
shared IP staying locked out for as long as an attacker keeps knocking.
Every 401 does count, `totp_required` included: exempting it would leave
the six-digit code brute-forceable by anyone who already has the
password, which is the one attack two-factor exists to stop. The cost is
one of ten attempts per fifteen minutes for the ordinary two-step
sign-in.

The key is the identifier as SUBMITTED (lowercased), not the account it
resolves to — an unknown username must have a window too, or the
endpoint becomes an enumeration oracle. The IP is the first hop of
`X-Forwarded-For` (what Caddy prepends), else the socket address; later
entries in that header are client-supplied and would let a caller mint a
fresh "IP" per request. Express' `req.ip` is not used: it ignores the
header unless `trust proxy` is set, which this application deliberately
does not set.

The refusal is 429 `login_rate_limited` with `Retry-After` in whole
seconds — the header, per RFC 9110, not a body field. `AppError` grew a
`headers` bag for it and `ProblemFilter` writes them.

The numbers (10/30/15 min) are a judgement, not a measurement, chosen
autonomously under the province-ready campaign; they are three constants
in `auth.controller.ts`.

## D17 — Backups are 14 nightly copies, kept on this host only

`scripts/backup.sh` writes a `pg_dump -Fc` of the database plus a tar of the
`package_store` volume to `~/duckoj-backups`, nightly at 03:00
Asia/Ho_Chi_Minh (`deploy/duckoj-backup.timer`), and prunes to the newest
**14**. Two weeks is chosen against the realistic failure — a bad migration,
a mistaken delete, a botched restore — all of which are noticed within days.
Keeping more is cheap in bytes and expensive in nothing, so raise `KEEP` if a
longer window is ever wanted; the number is not load-bearing.

**Copying backups off this host is the province IT team's responsibility, not
this repo's.** Nothing here does it, and nothing here will warn if nobody
does. Fourteen copies on the same disk as the database protect against
software mistakes and against no hardware failure whatsoever: a dead disk, a
stolen machine, or a flooded room takes the database and all fourteen
backups with it in one go. Someone outside this codebase has to pull
`~/duckoj-backups` somewhere else on a schedule, and someone has to check
that it is still happening.

Cost of this decision: an unattended, unmonitored single-site backup. If that
is not acceptable for a rated province contest, the fix is an off-host copy —
not a bigger `KEEP`.

*Ruled by the implementer during the province-ready campaign (2026-08-29,
P3 ops brief), no human available to consult; recorded here per the campaign
conventions.*

## D18 — The UI is Vietnamese by default, English by toggle, with no i18n library

DuckOJ is a Vietnamese olympiad judge, so `vi` is the default and `en` is
the alternative — not the other way round. First visit resolves to `vi`
unless `navigator.language` starts with `en`; an explicit choice is
remembered in `localStorage['duckoj.locale']` and drives `<html lang>`.

**No i18n library.** Two flat catalogues under `apps/web/src/i18n/`
(`en.ts`, `vi.ts`) keyed by stable ids (`nav.problems`), a typed `t(key,
vars?)` with `{name}` interpolation, a `LocaleProvider`, and a `VI | EN`
toggle in the shell nav. `react-i18next` would bring a plugin system, a
backend loader, a suspense integration and an ICU parser for a few hundred
strings and two locales. The one thing given up is plural categories:
Vietnamese has no plural inflection, and the single English message that
needed one is two keys instead of a rule engine.

`en.ts` is the **type authority** — `MsgKey = keyof typeof en`, and `vi.ts`
is `satisfies Record<MsgKey, string>` — so a forgotten translation fails
`tsc`. `test/i18n.spec.tsx` asserts key parity in both directions (an
orphaned key survives `satisfies`), NFC diacritics, and matching
placeholder sets.

**What is never translated**, and why: verdict CODES (`AC`, `WA`, `TLE` —
identifiers a competitor reads the same in any language; their long names
are localized, in tooltips), the API's own enum values (`icpc`, `cpp17`,
`owner`) where they go on the wire, the ICPC scoreboard's `+`/`−`/`m`
notation, server-supplied `error.detail` and error `code`s (problem-edit
and problem-revisions show those verbatim on purpose — D-less but
long-standing: this is a tool for people who read `problem_code_taken`),
`formatPoints`' bare numbers (a thousands separator would be wrong beside
the rest of a monospace column), and CONTENT — problem statements, contest
names, org names, usernames. The `packages/glicko2` rank-band titles were
listed here too, and D46 moved them into the same shape a TAG has: both
spellings on one data row, picked by locale at render time — content that
is translated without being a catalogue entry.

Dates, times and relative times DO follow the locale, via `Intl` with
`vi-VN`/`en-US`. Fonts needed no change: the vendored IBM Plex Mono already
ships a `vietnamese` unicode-range subset (Phase 7b), which is stronger
than a system-font fallback and keeps app.css's "IBM Plex Mono only" rule
intact.

---

## D19 — The first admin is minted by CLI, with a verified address

`corepack pnpm bootstrap:admin <username>` (`scripts/bootstrap-admin.ts`)
replaces the hand-typed `UPDATE users SET global_role = 'admin'` the runbook
used to prescribe. Three rulings inside it, taken during Task P4 because no
one was available to ask:

- **It creates as well as promotes**, and marks the address verified
  (`email_verified_at = now()`). A fresh install has no SMTP server
  configured, so the alternative parks the one account that can configure
  one behind a mail that will never be delivered.
- **On an existing account it promotes and nothing else** — never resets the
  password, never rewrites the address. A "bootstrap" command that quietly
  did either would be a foot-gun aimed at the account with the most to lose.
- **`--email` defaults to `<username>@bootstrap.local`.** The command has to
  work unattended in a provisioning script, and the admin can change the
  address from their own profile afterwards.

The SQL stays documented as the recovery fallback for a database the script
cannot reach. Cost: one more entry point that can create an admin, which is
why it is a CLI against `DATABASE_URL` and not a route — an HTTP endpoint
that mints admins only has to be reachable once to be a breach.

## D20 — Demo content ships as Polygon source, with sub-maximal tests

`content/problems/` holds five provincial-olympiad problems as Polygon
package *source* (`problem.xml`, `statement.md`, `solution.cpp`, `gen.py`,
`tests/`), imported into a stack through `polygon:import` → `package:build`
→ upload rather than seeded like `problems/`. Two rulings:

- **The committed tests are below the stated bounds** (largest: N = 5000 for
  the LIS problem, N = 2000 / M = 5000 for the graph problems; ~1.2 MB
  total). Test data at the real bounds is megabytes per problem in git for
  content whose job is to demonstrate the pipeline. Each generator exposes
  a `LARGE_N`/`LARGE_M` constant to produce bound-sized data on demand.
  Cost: as committed, these tests do not prove a solution is fast enough at
  the constraints their statements advertise.
- **No checkers.** Every answer is a single integer, so the standard token
  comparison is the whole of what a `wcmp`-style checker would do.

Statements are Vietnamese with an English section, per D10.

## D21 — A rejudge never replays ratings; it names the contests to re-rate

`POST /admin/submissions/{id}/rejudge` and `POST /admin/problems/{code}/rejudge`
answer with `ratedContestKeys`. They do not call `replayAll()`: at the
moment a rejudge runs, the case rows are gone and every affected score is
zero, so a replay there would fold zeros into every later rating — and the
judged worker, which is where grading actually finishes, has no rating
service to re-fold. D4 (regrading changes history) is honoured through D5
(rating is manual): the admin re-rates each listed contest once the queue
drains, and `POST /admin/contests/{key}/rate` replays.

The honest alternative — a completion hook in judged that replays — is a
cross-service dependency for a rare operation; deferred until a real contest
needs it.

## D22 — The scoreboard freezes by filtering, per participation, against an injected clock

`frozen_last_minutes = F > 0` on a contest means: while `now` is inside a
participation's own `[end − F·60s, end)`, that row is computed **only** from
its submissions dated strictly before the freeze instant, and the ones inside
the window are reported as a per-cell `pending` count instead. The response
carries `frozen` and `frozenAt`; the contest's creator and global admins
always get the live board (`frozen: false`), and at `now ≥ end` the board
unfreezes for everyone.

Five rulings, taken during task P1-C with nobody to ask. (The brief numbered
this D19; that number had already been taken by the bootstrap-admin ruling, so
the freeze is D22.)

- **The clock is a parameter, never read.** `lower(input, semantics, now?)`,
  and **omitting `now` means "no freeze"**. That single default serves both
  callers who must not freeze: the privileged viewer, and `scoreboardForSystem`
  — the rating replay, which would otherwise fold a half-board into everybody's
  rating. A default that froze on a forgotten argument fails dangerous; this
  one fails visible.
- **The freeze instant is per participation, not per contest** —
  `participation.end − F·60s`, so a virtual entrant's freeze is shifted by
  their own start exactly as their window already is. The cost is a conflict
  inside the brief itself: a virtual attempt still running after `end_time`
  stays frozen past the moment the brief says the board unfreezes "for
  everyone". The specific clause wins over the general one; the alternative
  reveals a running competitor's last hour to everyone watching.
- **`pending` sits on the ranking row, not in `format_data`.** A problem whose
  only submissions are inside the freeze window has no `format_data` cell at
  all, so a count nested there would silently vanish for exactly the case the
  freeze exists to describe. A submission outside the participation's window is
  **void, not pending**: advertising an attempt that will never appear when the
  board thaws is worse than hiding it.
- **Filtering is the whole of the freeze**, so DMOJ's per-cell `frozen_*`
  mirror fields now mirror the board actually served rather than projecting a
  second freeze onto an already-frozen one — that branch would have zeroed the
  very score being published. `is_frozen` on an `icpc` cell became real with
  the meaning it should always have had: *this cell hides attempts*. All 23
  goldens pin `frozen_last_minutes: 0`, so every one of them is byte-identical.
- **`frozen`/`frozenAt` are camelCase in a snake_case object.** The snake_case
  fields are the goldens' own shape, frozen from DMOJ; these two are DuckOJ's
  additions and are spelled the way the rest of the API spells things. `frozen`
  is true when at least one *ranked* row is inside its own freeze window —
  "this board hides something", which is the claim the banner makes; a
  spectator's window never raises it, because a spectator is never ranked.

Write time: `frozenLastMinutes` must be `≥ 0` and **strictly less than the
contest's duration in minutes** (422 `contest_freeze_too_long`), validated
against the merged state on edit — shrinking a contest under a stored freeze
window has to be refused too. The old blanket refusal
(`contest_freeze_unsupported`) is gone from the API, the contracts and the
schema comments.

## D23 — The freeze masks a submission's outcome; it never hides the submission

D22 froze the *scoreboard* by filtering, and stopped there: every late verdict
the board was hiding still travelled out through `GET /submissions` and
`GET /submissions/{id}`, so a rival could read what the ranking would not say
(the P1-C report named this hole in its own "Concerns"). D23 closes it.

**The rule.** For a submission attached to a contest, made at or after its own
participation's freeze instant, while `now` is inside that participation's
`[end − F·60s, end)`, and belonging to somebody else: the row is still listed
and still answers 200, with `frozen: true` and `verdict`, `points`, `timeMs`,
`memoryKb`, `compileOutput` replaced by `null` and `cases` by `[]`. The
submitter, the contest's creator and global admins are never masked, and at
`now ≥ the participation's end` everything is revealed — D22's
per-participation clause again, so a virtual entrant still inside their own
window stays masked past the contest's `end_time`.

Rulings taken during task P1-D with nobody to ask.

- **Masking, not filtering.** Existence is public; the outcome is not.
  Dropping the row would let a competitor tell "hidden" from "never
  submitted" by paging, and it would break the keyset cursor, which reads
  `items.at(-1).id` and so assumes nothing was removed after the query.
  `frozen` is a **required** field on both the summary and the detail: it is
  the only thing that distinguishes "withheld" from "not graded yet", and an
  optional one would read as the latter in every client that forgot it.
- **`?verdict=` is the one place the freeze filters.** A verdict filter is a
  question about the verdict, and a masked row that still answered it would
  hand the hidden verdict back in nine probes — the mask would be decorative.
  A frozen row therefore matches no value of that filter, excluded in SQL
  rather than thinned out of `items` afterwards.
- **`compileOutput` is masked; `state`, `maxPoints`, `judgedAt` are not.**
  `CE` is a verdict, and a compiler states it in full sentences. "Somebody
  submitted and grading has finished" is exactly what the board's own
  `pending` count already announces, and `maxPoints` is the contest problem's
  published total.
- **Two forms, and the SQL one restates `participationEndMs`.** The row form
  (`isSubmissionFrozen`) takes the window from `participationWindow`; the SQL
  form (`frozenSubmissionsWhere`) restates it as a `CASE`, because only a SQL
  form can reach a `WHERE` clause and the `?verdict=` rule needs one. A second
  derivation of the participation window is the split-predicate bug this
  project has found once per phase, so an agreement test seeds every
  participation shape — spectating, live ± time limit, virtual ± time limit,
  no freeze — and asserts the two mark the same set.
- **`source` is NOT masked.** It is not an outcome, and it is already governed
  by `canViewSubmission` — a viewer who reaches a rival's source at all did so
  through `source_access = 'solved'` or a problem role, both of which are
  decisions about the *problem*. Reading a solution during a contest is a
  wider question than the freeze; folding it in here would have made the
  freeze the place that answers it.
- **The realtime push and `GET /contests/{key}/me` needed no change, and that
  is a finding, not an omission.** `SubmissionsGateway.notify` publishes
  `{ type: 'submission', id }` — a signal, never data — and the client's
  re-fetch goes through `getVisible`, which now masks; `realtime.spec.ts`'s
  "delivers a wake-up signal carrying no submission data" is what keeps it
  that way. `/contests/{key}/me` answers with one participation window and no
  outcome at all, pinned by a test asserting its exact field set.
- **Out of scope, deliberately: the profile's solved count.**
  `UserAccessService` counts a user's distinct `AC` problems, which ticks up
  during a freeze for anyone polling it. It is a leak of the same family and
  it is not this task's; naming it here is what stops it being rediscovered as
  a surprise.

## D24 — A submission names its contest with no visibility check of its own

`SubmissionSummary` and `SubmissionDetail` both carry `contestKey` /
`contestLabel`, read from `contest_submissions ⋈ contest_participations ⋈
contests` as a LEFT JOIN, and `null` for a practice submission. The link is
the `contest_submissions` row — never "a submission targeting a problem this
contest happens to contain".

**No `canViewContest` gate is applied to it**, matching what
`SubmissionListQuery.contest` already does: the filter narrows an
already-`visibleSubmissionsWhere`-restricted set and asks nothing further
about the contest. The rule is therefore *whoever may see the submission may
see which contest it sits in*. The alternative — a per-row visibility check —
would cost the one-query property `listVisible` is built around, and would be
answering a question the caller can already answer by other means: they are
looking at the submission itself.

Safe against fan-out because `contest_submissions_submission_idx` is UNIQUE on
`submission_id`: at most one contest row per submission, so page size and the
keyset cursor computed from it are untouched.

## D25 — The scoreboard is cached in Redis for two seconds, keyed by view and freeze phase

P7 measured `GET /contests/{key}/scoreboard` at a 3.57 s p95 under 2000 VUs
(`load/RESULTS.md`) for a 520-byte response: `ContestAccessService` loads every
participation and every submission in the contest and folds the board in
JavaScript on every request. It now folds at most once per key per two
seconds.

**Why this is safe.** The fold takes a clock (D22) and the clock reaches it in
exactly one place — `isFrozenAt`, per participation. The board is therefore
*piecewise constant* in `now`, with breakpoints only at a participation's own
freeze instant and its own end. Caching a board is caching an interval, not an
instant.

Rulings taken during task P8 with nobody to ask.

- **Redis, not an in-process map.** `main.ts` forks `API_WORKERS` workers
  (P7), so an in-process cache is four caches with four independent miss
  rates and four different answers for one contest. The `REDIS_URL` client
  the realtime gateway already uses is the one every worker shares.
  *Coalescing* stays in-process — one fold per key per worker at a time — and
  a distributed lock is deliberately not built: it would add a round trip and
  a lease to every read to save at most `API_WORKERS − 1` folds per TTL.
- **The key is `(contest id, view, freeze phase)`.** The privileged view is
  folded with no clock at all, so it is one key whatever the time is; a public
  view carries the instant its phase began — `0`, the contest's freeze
  instant, or its end. Sharing one key between the two views would serve a
  contest's creator the board a spectator just cached, which is the one thing
  a scoreboard cache must never do. The two comparisons come from
  `window.ts` (`freezeAtMs`, `isFrozenAt`) rather than being rewritten; D22
  and D23 each record a bug from a second derivation of that predicate.
- **Only the CONTEST's boundaries are in the key.** A virtual or
  time-limited participation has its own shifted pair (D22), invisible
  without loading the participations — the expensive thing this exists to
  avoid. Those boards thaw at most one TTL late. That is the whole of the
  staleness this design admits by construction, and it is why the TTL is two
  seconds rather than thirty.
- **`scoreboardForSystem` is never cached.** The rating replay folding a
  stale board into everybody's rating is the failure D22 was designed
  against, and the cache must not reintroduce it by a side door.
- **The API deletes on the writes it handles; a verdict rides the TTL.**
  Disqualify, contest edit and rejudge delete the contest's keys after their
  write commits. A submission graded by `judged` does not: the event writer
  is a separate process that never calls into the API, and a board two
  seconds behind a verdict is not a contest-day problem. An edit deletes the
  old *and* merged key sets, because the patch may have moved a boundary that
  is itself in the key.
- **`cache: 'hit' | 'miss'` is a response header (`X-Scoreboard-Cache`), never
  a body field.** The body is the goldens' snake_case shape, compared byte for
  byte by 23 replays; a cache is transport metadata, not something the contest
  format has an opinion about. A coalesced waiter reports `miss` — it did not
  read the cache, it waited on a fold.
- **A cache may never fail a request.** With Redis unreachable every command
  rejects at once (`enableOfflineQueue: false`), the outage is logged once,
  and the board is folded exactly as before. `ScoreboardCache` swallows a
  rejecting store as well, so the guarantee is structural rather than a
  convention each store must remember.

Left open: a fold already in flight when a write commits can still store the
pre-write board, for one TTL. Closing it needs a cross-worker epoch read on
every request, which costs more than the two seconds it buys.

## D26 — Registration is metered per IP, and a taken EMAIL answers like a success

`POST /auth/register` was anonymous, unmetered, and costs 19 MiB of argon2id
per call; it also answered `409 email_taken`, which the register screen
rendered next to the email field. Two problems in one endpoint, fixed
together because the first is what made the second cheap.

**Metering.** Five registrations per client IP per hour, counted in
`rate_events` under purpose `register` with D13's DB-backed limiter, refused
`429 register_rate_limited` with `Retry-After` in whole seconds. The IP is
derived exactly as D16 derives login's. The check runs **before** the hash, so
a refused caller costs this process nothing.

**Every attempt counts, unlike login.** D16 counts only failures because what
it guards is a credential, and a successful sign-in proves the caller is not
the attacker. Nothing is being guessed here: what is metered is the *cost*,
and a successful registration pays it in full. The 429 itself still records
nothing, so the window drains rather than a shared address staying locked out
for as long as someone keeps knocking. There is no per-identifier window to
pair with it, because the identifier is chosen freely by the caller and would
meter nothing.

**Enumeration.** `username_taken` stays a 409 — a username is public, it is
on every scoreboard and in every submission list, and refusing it is the only
way a person can pick another one. A taken **email** is answered `201` with a
body of the same shape (the submitted values echoed back, a random positive
id, the schema's `locale`/`timezone` defaults), **no account is created**, no
verification mail is sent, and the API logs one `warn` line naming the address
— the only record that it happened, since the response deliberately is not
one. The argon2id hash runs on that path too: skipping it would return the
fake 201 in a fraction of the time a real one takes, which is the same oracle
read with a stopwatch. The INSERT-time race answers the same way, or the
oracle survives under a condition an attacker can simply create.

**What this costs, honestly:**

- A person whose address is already registered is told nothing. They get a
  201, the page's chained sign-in fails, and they have to work out that they
  already have an account. The register screen's standing copy now says this
  will happen and points at "Forgotten your password?" — standing copy shown
  to everyone before submitting is not an oracle.
- **The oracle is narrowed, not closed.** After a fake 201 the account still
  does not exist, so `GET /users/{username}` 404s and the chained login fails
  — a determined attacker can still distinguish the two outcomes at one extra
  request each. The rate limit is what makes that expensive rather than free.
  Closing it fully needs verify-before-create (create nothing until the
  address is confirmed by mail), which is a larger change to the signup flow
  than this brief allows and would make the "registering signs you in straight
  away" property go away.
- **The number is 30/IP/hour, not 5.** The first cut shipped 5, which a
  single school lab behind one NAT address exhausts in one seating; 30 lets
  a class register in an hour while still capping an enumeration sweep at
  720 probes a day per address. It is one constant,
  `REGISTER_LIMIT_PER_IP` in `auth.controller.ts`; raise it further for a
  province-wide signup day and lower it back afterwards.

*Ruled by the implementer during the province-ready final-review fixes
(2026-08-29, F1 brief), no human available to consult.*

## D27 — A contest submission's source is withheld until its window closes

`source_access = 'solved'` opens a **problem's** solutions to anyone holding
an AC on it — the practice affordance P10 turned into a two-click control on
the problem edit screen. `canViewSubmission` has no notion of a contest, so
that setting also handed the first competitor to solve a problem every rival's
accepted C++, live, for the remaining hours of a contest that reused it. D23
left `source` outside the freeze on the reasoning that it "is already governed
by `canViewSubmission`"; this is the clause that makes that true.

**The rule.** While a submission's contest participation window (D22's
`participationEndMs`) is still open, its `source` is `null` and
`sourceHidden: true` for everyone except its submitter, the contest's creator,
and global admins. At `now >= end` — the participation's own end, so a virtual
entrant's source stays withheld past the contest's `end_time` exactly as their
board does — it is served normally.

Three deliberate independences:

- **Not the freeze.** It has no `frozen_last_minutes`, applies to contests
  with no freeze at all, and covers the whole window rather than its last
  minutes: reading a rival's solution at minute five is worse than reading
  their verdict at minute fifty-five, not better. It shares
  `SubmissionFreezeContext` and `loadSubmissionFreezeContext` with the freeze
  because both need the same participation end instant, and a second
  derivation of that instant is the split-predicate bug this project has
  found once per phase.
- **Not `source_access`.** The setting keeps meaning what its label says. A
  setter who opens a problem for practice does not have to remember that it
  might be reused in a contest one day.
- **A mask, not a 404.** The submission still answers 200 with everything
  else on it; only the one field is withheld, and `sourceHidden` says so
  rather than leaving `null` to read as "this submission was empty".

Cost: a curator or author of the problem — who may read every submission to it
— loses the source of contest submissions for the duration. That is the
intended direction. A contest's own creator keeps it, which is the role that
actually has to investigate cheating while the contest runs.

Only the detail route needed changing: `source` is not on
`SubmissionSummary`, so there is no SQL form of this predicate and no list to
keep in agreement.

*Ruled by the implementer during the province-ready final-review fixes
(2026-08-29, F1 brief), no human available to consult.*

## D28 — A contest edit diffs its problem list; only a REMOVAL is refused after the start

`contest_submissions.contest_problem_id` is `ON DELETE cascade` on
`contest_problems.id` (`0008_contests.sql:58`). `PATCH /contests/{key}` used
to replace the whole list — `delete … where contest_id = …`, then re-insert —
and guarded that with "a started contest refuses any problem *change*". The
two together were a data-loss bug, not a safety net: an identical list is not
a change, so the guard let it through, and the delete then cascaded away
**every submission of a running contest**. The edit form resubmits the whole
body, so pushing `endTime` out by fifteen minutes was enough to do it.

The write is now a diff keyed on `problem_id`: a row that stays keeps its
`contest_problems.id` and is UPDATEd in place (label, points, partial,
order), a genuinely new problem is INSERTed, and only a genuinely removed one
is DELETEd. Nothing a surviving problem can be edited into moves an id, so
nothing cascades.

That makes the started guard narrower on purpose, and this is the product
ruling: **after the start, a removal is refused (409 `contest_started`); a
relabel, a repoint, a reorder and an addition are allowed.** Refusing
everything was the old rule and it protected nothing — it never fired on the
one edit that destroyed data, and it did fire on the organiser fixing a label
typo thirty minutes into a provincial contest, which is a real thing to need.
Removal stays refused because a removal's cascade is not avoidable by writing
more carefully: the participation→problem mapping it deletes is the only
record of which submissions counted.

Cost: changing a live contest's points *does* rewrite the scoreboard under
the competitors, which the organiser now has no guard against. The scoreboard
cache is invalidated on both key sets already (D25), so what they see is
correct — it is simply different from a minute ago. The alternative, refusing
it, is the rule that just cost a contest its submissions.

Not done here, deliberately: changing the FK to `ON DELETE restrict`, so the
next such bug is a loud 500 rather than silent loss. It needs a migration and
this brief allocated no migration number.

*Ruled by the implementer during the province-ready final-review fixes
(2026-08-29, F1 brief), no human available to consult.*

## D29 — A judge connection grades one submission at a time, and a terminate is addressed to it

Final review's blocker **B2**. `terminate-submission` carries no submission id
(`packages/judge-protocol/src/dmoj-packets.ts`), and `DmojDriver.cancel`
broadcast it. With `JUDGED_CONCURRENCY=2` against the one `judge` container,
job A could sit undispatched behind job B, hit its own grading ceiling, and
cancel — terminating **B**, whose owner got a permanent `errored`/`IE` with no
requeue and nothing to appeal.

**The ruling: one submission per judge connection.** Nobody is available to
confirm it, so it is recorded as a ruling rather than a fact. It follows from
the protocol itself: judge-server tracks a single current submission and
answers `current-submission-id` with exactly one id, and `terminate-submission`
names none — a protocol that expected several concurrent grades per socket
could do neither. We therefore treat a connection as a one-slot resource:

- The driver keeps a connection id → submission map, maintained from both
  ends — what we sent, and what every reply packet's `submission-id` confirms.
- `cancel` sends `terminate-submission` to the one connection provably running
  that submission, and to nothing otherwise: a job still queued, a job whose
  judge vanished, a job already finished cancels nothing, logs
  `cancel for a submission no judge is running`, and emits **no** `terminated`
  event — a submission no judge touched must not be written off as IE.
- `dispatch` never sends a second `submission-request` to a busy connection;
  it parks until one is idle, and rejects if cancelled while parked (a
  silently-resolving dispatch would hang the claim loop forever).
- A judge redialling under the same `judge_nodes` name clears its own stale
  assignment at handshake, or the fresh connection would read as busy forever.

**Back-pressure, not just targeting.** Targeting alone still leaves a surplus
job leased with nothing running it until its watchdog fires. `Worker` now
reserves a judge slot (`JudgeDriver.tryAcquireSlot`, optional, synchronous)
*before* it claims and releases it after completing, so a claimed job is always
immediately runnable. A driver without the method is unlimited, which keeps
every in-process test double unchanged.

**`JUDGED_CONCURRENCY` ships 1, not 2.** With back-pressure, 2 against one
judge is now provably *safe* — and provably *inert*: the second loop can never
win a slot, so it polls the database every 500 ms and claims nothing. The
brief's "keep 2 and say why" branch has no honest why. One loop per judge, and
it rises with the fleet (docs/runbook.md, "Judging throughput"), which is the
sequencing the runbook already prescribed and the repo had not followed.

Left open: `live` is still keyed by job id, not `(job, attempt)`. Terminating
attempt N on its own connection and not reusing that connection until the judge
answers narrows the window hard, but it is still an argument from timing.

## D30 — A failed restore leaves the writers stopped when the database is unverified, and restarts them when it is not

`scripts/restore.sh` stops `api` and `judged`, reloads the database, runs
`migrate`, imports the package volume, and starts them again. Every step in
that list can fail, and the review found the script had no answer for any of
them: a failed `pg_restore` printed a WARNING and carried on to start the
writers on top of a half-restored schema (M6), while a failed
`podman volume import` killed the script under `set -eu` and left the site
fully down with the database already fine (M5).

Both are now handled, and **they are handled differently on purpose**:

- **`pg_restore` or `migrate` failed → `api` and `judged` stay STOPPED.** The
  database is in a state nobody has verified — half the tables restored, or
  the right tables at a schema version older than the running images. The
  script prints the whole `pg_restore` log, says in capitals that the writers
  were left down deliberately, names the command to bring them back, and exits
  non-zero. A stack that is honestly down is recoverable in one command by
  whoever is reading the message. A stack serving and *grading* against a
  half-restored schema writes wrong verdicts into tables that then have to be
  untangled by hand, and it does it while looking healthy.
- **Anything after that → the writers are RESTARTED, loudly, by a trap.** By
  then the database is reloaded and migrated; only package bytes are missing.
  Keeping the site down for that trades a real outage against an incomplete
  problem-package store, which is the wrong trade — and the failure is still
  loud, and the exit code is still non-zero.

The line between the two is "can the running code be trusted against this
database". That is also why `migrate` is on the stopped-side: a restore of an
old backup onto today's images is precisely the schema drift
`scripts/compose-up.sh` was written to catch, and letting the writers start
anyway would reintroduce it through the restore path (M7).

Two smaller rulings ride along:

- **One project variable, exported.** `restore.sh` resolves
  `COMPOSE_PROJECT_NAME` (podman-compose's own variable; the old
  `COMPOSE_PROJECT` remains a read-only alias) and exports it, so the container
  lookup and the `podman-compose` calls cannot address different stacks. They
  could before, and the documented worktree invocation did exactly that: it
  dropped the live database while stopping nothing (M4).
- **`SERVICES=""` means data path only** — no `podman-compose` command at all,
  not even `migrate`. It exists so the restore path can be exercised against a
  throwaway container (`scripts/test/restore.test.sh`) without going near a
  live stack, and it is not an operating mode.

Not decided here: alerting. Nothing tells anyone a nightly backup or a restore
failed except `journalctl`; D17 already accepts that for backups and this does
not change it.

## D31 — A clarification and an announcement are one row, and notifications fire on transitions

Contest day needs a channel between the room and the organisers, and the
province has none (`PROVINCE-READINESS.md` gap 4). `contest_clarifications`
is it: `contest_id`, nullable `problem_id`, `asked_by`, nullable `question`,
nullable `answer`, `answered_by`/`answered_at`, `visibility private|public`.

- **One table, two things.** A question has `question` set and is `private`
  until an organiser publishes it. An **announcement** is the same row with
  no question at all — the text is in `answer`, it is `public` on creation,
  and `asked_by` is the organiser, because that column means "who wrote this
  row", not "who is waiting for a reply". Two tables would have duplicated
  the visibility rule, the notification fan-out and the feed query to keep
  one nullable column out of one of them. A CHECK refuses a row with neither
  question nor answer, so "an announcement with no text" is not representable.
- **Notifications fire on transitions, never on every PATCH.** The asker is
  told the first time an answer lands; every participant is told the first
  time an *answered* row becomes public. An organiser fixing a typo in an
  answer two thousand students have already read notifies nobody. The
  alternative — notify on each write — is how a feed becomes something people
  stop opening, and it is unrecoverable once it has happened once.
  `answered_by`/`answered_at` are stamped on the first answer and never
  rewritten, so they name the reply the asker was actually told about.
- **The fan-out is one INSERT, over `selectDistinct`, inside the
  transaction.** A person holding a live participation plus two virtual
  attempts is one recipient. Capped at 10000 — four times the largest room
  this is being built for, a bound on the statement rather than a product
  rule anyone will meet.
- **Asking requires a participation; 403 `contest_not_joined`.** This is
  contest-day Q&A, not a public forum. 403 rather than 404 on
  `setDisqualified`'s reasoning: the caller already reached the contest, so
  its existence is theirs to know. A contest they may *not* see still 404s.
- **Reading is `@Public()`, like every other contest GET.** An anonymous
  viewer of a public contest sees the public rows: an announcement is for the
  people watching as much as for the people competing. A signed-in
  non-organiser sees the public rows plus their own; the creator and a global
  admin see everything.
- **Rate limit: 20 asks per user per contest per hour**, D13's DB-backed
  limiter, refused **loudly** with 429 `clarification_rate_limited`. D13's
  silent drop is for outbound mail, where the refusal must not confirm an
  address exists; an interactive form that silently swallowed a question
  would be a worse bug than the flooding it prevents. Per contest, not per
  user: a student sitting two rooms in one afternoon is two conversations.
- **A `problemCode` not attached to this contest is `problem_not_found`**,
  identically to a code that names nothing — a clarification form must not
  become a way to enumerate which problems exist.
- **The web polls every 30 s while the contest runs, and not at all once it
  has finished.** No WebSocket: the realtime channel carries submissions, and
  widening it for a feed that tolerates half a minute of staleness would add
  a failure mode no reader could perceive the absence of.

Rulings taken during loop task F1 with nobody to ask. Migration 0017.

## D32 — A password reset revokes access tokens too, not only sessions

`resetPassword` ended every session for the account and left every personal
access token alive. The two are not comparable in danger: a session dies on
its own in `SESSION_TTL_HOURS`, whereas `POST /auth/tokens` accepts
`expiresAt: null` and mints a credential that never expires — and that route
is `@SessionOnly()`, which means the caller who can mint one is exactly the
caller holding the session an intruder stole. Mint a token, wait for the
victim to notice and reset, keep the account: the rescue the reset exists to
perform was reachable around.

**The rule.** Redeeming a `password_reset` token deletes every
`access_tokens` row for that user in the same transaction as the password
change and the session purge, so there is no instant at which the new
password is live and an old credential still is.

**Not the same as a routine password change**, which does not exist here —
there is no "change my password" endpoint, only the mailed reset, and every
reset is by construction a "someone may be in my account" event. If a
self-service change is ever added, it is a separate decision: revoking a
CI token because a person rotated their own password on a Tuesday is a
different trade from revoking it because they are being locked out of their
own account.

**What this costs.** A person who resets their password re-issues their `oj`
CLI token and any CI credential. That is the correct direction — the
alternative is a reset that quietly leaves the compromise in place — and it
is the same behaviour GitLab, Google and Atlassian all have for OAuth/app
credentials after a credential-reset event. The one refinement worth having
later is telling the user, on the reset-complete screen, that their tokens
are gone; the web reset page is out of this brief's surface.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B1 auth
brief), no human available to consult.*

## D33 — Starting a TOTP enrolment cannot un-enrol an existing one

`POST /auth/totp/begin` upserted a fresh secret with `confirmedAt: null`.
Against a *pending* enrolment that is right — the last QR shown is the one
that works. Against a *confirmed* one it was an un-enrol: `isEnabled` went
false the moment the call returned, `login` stopped asking for a code, and
the account was down to a password. Verified against the live stack: `begin`
→ `GET /auth/me` reports `totpEnabled: false` → sign-in with the password
alone answers 200.

Two ways to arrive there, one hostile and one not. Hostile: whoever holds a
stolen session strips the second factor with a single POST that proves
nothing — not the current code, not the password — and the holder is not
told. Accidental: a stale tab whose cached `/auth/me` still says "off" shows
the Enable button; one click, then the user wanders off, and 2FA is now off
with a pending secret nobody scanned.

**The rule.** `begin` answers `409 totp_already_enabled` when a confirmed
credential exists. Re-enrolling means `DELETE /auth/totp` first.

**Why not stage the new secret and swap it on confirm** — the strictly better
behaviour, and what a `pending_secret_enc` column would buy: it needs a
migration, and this brief deliberately adds none (a migration number is
shared state with the other agents working this repo tonight). The refusal is
the subset of that fix which needs no schema change and gives up nothing that
`DELETE` + `begin` does not restore in one extra click. If the column is ever
added, this ruling is the thing to revisit.

**The window is not closed, it is made explicit.** `DELETE /auth/totp` still
needs no code, so a session holder can still end up with no second factor —
in two steps, one of which the UI already guards with a confirm dialog and
which raises a `totp_reset`-shaped absence the owner can see on their own
security page. Step-up re-authentication (demand the current TOTP code, or
the password, before `DELETE`) is the real fix for the hostile case and is a
larger decision than this one: it needs a password-confirm flow the app does
not have anywhere yet.

**No UI change.** `security.tsx` renders Enable only when `totpEnabled` is
false, so the refusal is unreachable from a correctly-loaded screen; it is
the stale-tab and the raw-API paths that meet it, which are exactly the ones
that should.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B1 auth
brief), no human available to consult.*

## D34 — A TOTP code is single-use

`TotpService.verify` checked the code against the secret and stopped there,
so the same six digits worked as many times as they were presented for the
sixty seconds `window: [1, 0]` keeps them acceptable. Verified against the
live stack: sign in with a code, present the identical code again, second
sign-in also answers 200. RFC 6238 §5.2 is explicit that a verifier must not
accept the same OTP twice, and the reason is the attack the second factor
exists to stop: a code read over a shoulder, relayed through a phishing
proxy, or lifted out of a proxied form is worth a whole extra sign-in.

**The rule.** A correct code is spent on first use. A replay inside the
retention window answers exactly like a wrong code — `401
invalid_totp_code`, which also consumes one of D16's ten login attempts, so
spraying replays is metered like any other failure.

**Where the record lives.** `rate_events`, purpose `totp_used`, key
`<userId>:<code>`, through a new `RateLimiter.consumeOnce`. In the database
rather than in this process because the API runs `API_WORKERS` of them and
an in-memory set lets the replay land on a different worker; in the existing
table rather than a new one because this brief adds no migration (the
migration number is shared state with the other agents working tonight) and
the shape — a purpose, a key, a timestamp, an age-based sweep — is exactly
what that table already is.

**`consumeOnce` takes a lock; `allow(…, 1, …)` would not have.** The class
comment on `RateLimiter` accepts a count-then-act race because the limits it
was written for guard nuisance volume. A single-use credential inverts that:
two simultaneous presentations of one code is the *defining* case, since a
relay forwards the victim's code at the instant the victim submits it. So
`consumeOnce` takes a transaction-scoped advisory lock on `(purpose, key)`
and serialises them. Its test needs three real connections —
`withTestDb`'s rolled-back transaction makes nested `db.transaction()` calls
savepoints of one xid, and an advisory lock is re-entrant within a session.

**Keyed on the code, not the step**, so no second copy of `window`'s
arithmetic can drift from otplib's. Cost: if two steps within the two-minute
retention produce the same six digits (~1 in 10^6) one legitimate sign-in is
refused and the next code works. Refusing is the safe direction.

**Not applied to `POST /auth/totp/confirm`.** Confirming an enrolment is not
an authentication — the caller already holds the session — and spending the
code there would refuse a sign-in the enrolling user attempts thirty seconds
later on their phone.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B1 auth
brief), no human available to consult.*

## D35 — A tag is a hint, so tags and difficulty vanish for the duration of a contest

The province's teachers organise practice by topic, so problems carry tags
(`tags` + `problem_tags`, migration 0018) and a nullable 1–10 `difficulty`,
and `GET /problems` filters on both. That same classification is a hint: "this
is a segment-tree problem" is a third of the work on the hardest problem in
the room, and a scoreboard that rewards reading the tag list rewards the wrong
thing.

- **Hidden from a participant, while the contest runs.** A viewer holding a
  participation in a contest that is running *now* and that uses the problem
  sees `tags: []` and `difficulty: null` on both `GET /problems` and
  `GET /problems/{code}`. Nothing is stored and nothing is scheduled — this is
  a clock question, and the hint comes back on its own when the contest ends.
- **Blanked, never signalled.** The masked values are exactly what an
  untagged, unrated problem returns. A distinguishable "hidden" state would
  itself confirm the problem is in the contest the viewer is sitting, which is
  the fact the mask exists to withhold.
- **The filter runs over the masked view, not under it.** A hidden problem
  drops out of a tag- or difficulty-filtered page entirely. Masking the field
  while still letting `?tag=do-thi` match it would leave the filter as an
  oracle answering exactly what the blank chip row refused. An *unfiltered*
  page still lists it, blanked: hiding the hint must not hide the problem.
- **Exempt: the contest's organiser (`created_by`) and any global admin.**
  Both already read the problem's edit screen; a mask they can trivially step
  around is a mask that only costs the people running the room.
- **The contest's window, not the participant's virtual one.** A virtual
  attempt begun after `end_time` sees the tags. The hint is withheld from the
  live room, which is what the ranking depends on.
- **Every participation counts** — spectators (`virtual = -1`) and
  disqualified entries included. Hiding a chip from someone who is only
  watching costs them nothing that matters; showing it to someone quietly
  competing costs the contest.
- **Signing out defeats it, and that is accepted.** An anonymous viewer holds
  no participation, so nothing is hidden from them. The ruling is about not
  putting a hint in front of a competitor, not about making the tag list
  unobtainable — the vocabulary is public (`GET /tags`) and so is every
  problem outside a live contest.
- **`PATCH` echoes what it wrote.** The mask lives on the read paths only; a
  setter who just set `tags` gets them back, or the write would look lost.
- **An unknown slug on a PATCH is a named 422 `problem_tag_unknown`**, not the
  blurred `problem_org_unknown` its neighbour uses. An organization's
  existence is a secret; a tag's is published, so naming the offending slug
  costs nothing and turns a rejected request into a fixed one.

Rulings taken during loop task F2 with nobody to ask. Migration 0018.

## D36 — A scoreboard row is a participation, not a person

`mapContest` refused, with `409 contest_duplicate_participant`, any contest in
which one user held more than one participation. The comment explaining that
refusal named its own expiry date: *"nothing in this phase can create it:
participations are seeded, and joining is out of scope … the phase that adds
joining will have to widen the input shape's key."* Phase 4d added joining and
never widened it.

So the state is now routine and the refusal is a denial of service anybody can
perform. `join` mints a fresh virtual attempt on every call **by design** ("a
client that retries a virtual join blindly gets a second attempt, and that is
the correct reading of the request it made twice"), and a live entrant may
replay a finished contest virtually. Either one makes
`GET /contests/{key}/scoreboard` answer 409 for **every** viewer, permanently,
with no way back short of deleting a row by hand — and it poisons
`scoreboardForSystem`, so one such contest flagged rated wedges
`POST /admin/contests/{key}/rate` for every contest in the system.

**The ruling: the identity a submission is attached to is the participation,
and the name is only what the row prints.** `ParticipantSpec` and
`SubmissionSpec` gain an optional `participation_id`; `lower()` matches on it
where it is present and on `name` where it is not. The API sets it from
`contest_participations.id` on every row, so one person legitimately appears
twice on a board, once per attempt, exactly as `virtual` on the ranking row
already implied and as the web's `key={participant-virtual}` already assumed.

- **Optional, not required.** Every fixture under `fixtures/contest-goldens/`
  omits it and therefore lowers by name exactly as before; all 27 goldens stay
  byte-identical and the 23 replays with them. A required field would have
  rewritten 46 files to record a fact DMOJ's own export does not carry.
- **Two participations under one key is now an error in `lower()`**, not a
  silent overwrite. The old `new Map(...)` kept the last row and merged the
  first one's submissions into it — a wrong board reported as a right one,
  which is what the 409 was really protecting against. The API cannot reach
  the throw: it keys every participation by its primary key.
- **`first_solve` is unaffected.** It already counts only `virtual === 0`, and
  a person holds at most one live participation.

Not done here: widening `ContestParticipationDto` or the ranking row with the
participation id. Nothing client-side needs it — `(participant, virtual)` is
already unique — and adding it would change the goldens' output shape.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B2 contests
brief), no human available to consult.*

## D37 — A disqualification binds the person, so a later join inherits it

`setDisqualified` states the rule in its own doc comment — *"every
participation that user holds in this contest moves together … disqualification
is a judgement about the person in this contest, not about one attempt"* — and
implements it for the rows that exist at the moment it runs. Nothing carried it
to a row created afterwards, and `join` mints one on demand: a virtual join is
deliberately not idempotent, so an expelled competitor answered a
disqualification with one more `POST /contests/{key}/join` and reappeared on
the board un-struck, free to submit again (`resolveContestTarget` refuses the
disqualified participation and takes the clean one, highest `virtual` first).

**The ruling: `join` inherits the flag from any participation the caller
already holds in that contest.** Reinstatement is unchanged and still clears
every row, the new one included, so a wrongly-disqualified competitor is
restored by the same single PATCH.

- **Inherit, not refuse.** A 403 on `join` would have been simpler and is the
  wrong shape: the board renders disqualified rows struck through with `[DQ]`
  (D-era brief), so the record of what happened lives in a row, and refusing
  the join leaves the contest with no row to render for an attempt somebody
  did make. It would also mean a reinstated competitor's history differed from
  one who was never expelled.
- **`some`, not "the highest `virtual`".** Any live disqualification taints a
  new attempt; a mixed state cannot arise through the API (`setDisqualified`
  writes every row) and, if one ever did, the safe reading is the strict one.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B2 contests
brief), no human available to consult.*

## D38 — A started contest's start time is frozen; its end time is not

`update`'s started guard covered `format` (and, since D28, a problem removal)
and nothing else. `startTime` and `endTime` were editable on a running contest
with no check at all, and moving either is destructive: `participationStartMs`
and `participationEndMs` are computed from them for every live participation
with no time limit, `lower()` drops any submission outside that window
(DIV-1), and `icpc` counts its penalty minutes from the participation's start.
Probed live: a contest running with one submission on the board, one
`PATCH {startTime}` two hours forward, `200 OK`, and the board's
`submission_count` goes `1 → 0` with nothing said.

**The ruling: once a contest has started, `startTime` may no longer change
(409 `contest_started`); `endTime` still may, in either direction.**

- **`startTime` serves no operational need after the start.** It is the origin
  of every clock the contest has. Moving it forward voids what was submitted
  before the new origin; moving it back rewrites every `cumtime` on the board.
  Neither is something an organiser mid-contest is trying to do.
- **`endTime` is the lever they *are* trying to pull** — "we start fifteen
  minutes late, everyone gets fifteen more" is the single most common
  contest-day edit, and ending early (a fire alarm, a power cut) is a real one
  too. Refusing it would repeat D28's mistake: a guard that never fires on the
  edit that destroys data and always fires on the edit the organiser needs.
- The accidental version of that damage was the actual hazard, and it is fixed
  on the web instead: `contest-edit.tsx` rendered a stored `10:00:37Z` into a
  minute-resolution `datetime-local` and saved `10:00:00Z` back, so an
  untouched save moved `endTime` up to 59 s EARLIER and could void a genuinely
  last-minute submission. A field the reader did not touch now sends the exact
  instant it was seeded with.
- Compared by instant, not by presence, so a form that PATCHes the whole body
  back is a no-op — the same rule D28 states for the problem list.

Residual, stated rather than fixed: shrinking `endTime` on a running contest
still voids submissions made after the new end, deliberately (that is what
"the contest ended at 15:30" means), and the edit screen does not warn about
it. Refusing only an `endTime` that would void an existing submission needs a
per-participation window query on the write path; it is worth doing when the
edit screen grows a confirmation step.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B2 contests
brief), no human available to consult.*

## D39 — Two-factor authentication gets a way back in: eight single-use recovery codes

Enrolling in 2FA was a one-way door. A lost, wiped or stolen phone left the
account holder with a password that no longer signs in and exactly one
remedy — `POST /admin/users/{username}/totp/reset`, i.e. finding an
administrator. On a province deployment the administrator is a teacher who
reads mail twice a week, so the person who did the *responsible* thing was
locked out for days while everyone else carried on. That is a product
telling its users not to turn the second factor on.

**The rule.** Confirming an enrolment issues eight single-use recovery
codes, returned once and never again. Any one of them substitutes for the
TOTP code at `POST /auth/login`. `POST /auth/totp/recovery/regenerate`
replaces the set. `GET /auth/me` carries `recoveryCodesRemaining`.

**Eight, at 50 bits each, shaped `xxxxx-xxxxx`.** Eight is the convention
(GitHub, Google) and about a year of ordinary use. Ten characters over a
32-symbol Crockford-ish alphabet — no `0/O`, no `1/I/L`, no `U` — is 50 bits,
far past guessable through a route D16 meters at ten attempts per fifteen
minutes, and short enough to copy onto the inside of a notebook cover, which
is where these actually live. The server canonicalizes on the way in
(uppercase, non-alphanumerics dropped), so a code typed back without its
dash, in lowercase, or with a stray space still works: it is transcribed by
hand, under stress, by someone already locked out.

**Stored as `sha256`, not argon2.** The value is server-generated randomness
with no dictionary behind it, so a work factor buys nothing the entropy does
not already give; an argon2 verify at 19 MiB against up to eight rows, on a
route any anonymous caller can reach, is a denial-of-service surface rather
than a defence; and hashing to a *lookup key* is what lets the consume be one
statement. `one_time_tokens` already stores `sha256(token)` for reset links
for the same reasons — this is that precedent, not a new one.

**Single use, enforced by the row.** `UPDATE … WHERE user_id = $1 AND
code_hash = $2 AND used_at IS NULL RETURNING id`. Two simultaneous
presentations of one code contend on that row and exactly one gets a row
back. D34's `consumeOnce` needed an advisory lock because `rate_events` has
no row to claim — a count of absent rows is not a claim. Here there is one,
so a lock would only be slower. `used_at` rather than a delete, so the
remaining count and the fact of a spend both survive.

**Unknown, malformed and already-spent are one answer**: `401
invalid_totp_code`, the same one a wrong TOTP code gets, counted by the same
D16 window through the same `catch`. Distinguishing them would let someone
holding an old printout learn which of the eight are still live without ever
completing a sign-in, and an unmetered eight-code guessing surface beside a
metered six-digit one would be the softer target. For the same reason
`recoveryCode` is validated loosely (1–64 chars): a strict shape would answer
422 *outside* the window for a mistyped credential.

**`totpCode` wins when both are sent.** Someone holding their authenticator
should not burn a recovery code because a stale form field came along; the
web form sends exactly one, and the precedence is what makes a raw API caller
safe too.

**Regenerating demands a live TOTP code, and spends it.** The codes are the
second factor in another shape, so minting a set from a session alone would
let whoever holds a stolen session walk out with eight standing logins —
which is exactly the hole D33 closed on `begin`. `isEnabled` is checked
first and answers `409 totp_not_enabled`: `TotpService.verify` returns `true`
for an account with no confirmed credential (it documents that it fails open),
so without the gate any session could mint eight sign-in credentials by
posting six arbitrary digits. The presented code is spent (D34) exactly as a
sign-in would spend it — a code relayed out of a credential-issuing route is
worth at least as much as one relayed out of a login.

**Confirm returns them, and confirming again replaces the set.** `POST
/auth/totp/confirm` goes 204 → 200. A confirm proves precisely what a
regenerate proves, so there is no state where the two should behave
differently; and issuing inside the same transaction as `confirmedAt` means a
confirm can never leave an account with a second factor and no way past it.
`422 invalid_totp_enrolment_code` is reused by both routes rather than minted
anew: its meaning is "the code you typed at a credential-management route was
wrong", which is what a client needs to tell apart from the login-time 401.

**Disabling takes the codes with it**, including through the admin reset,
which goes through the same `TotpService.disable`. Leaving them would mean a
later re-enrolment silently inherited codes printed for a secret that no
longer exists, and a stolen printout would outlive the reset made to defeat
it.

**Running out is a notification (D14), written in the transaction that spends
the last one.** Nothing else in the product would ever mention it: the next
lockout is when the holder finds out, and by then the notice they needed sits
behind the sign-in they cannot complete.

**What is deliberately not built.** No download button (the browser sandbox
and the printer already cover it, and a file on the same laptop as the
password manager is not a backup); no "codes remaining" warning below eight,
because seven of eight is not news; no per-code labels or usage history,
which would be an audit surface for something whose whole story is "it
worked once". And the codes are still shown to a *session*, so a stolen
session sees them at enrolment — closing that needs the step-up
re-authentication D33 already names as the missing piece.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F3 recovery
codes brief), no human available to consult. Migration 0019.*

## D40 — A package's source checker is a testlib checker, rendered as DMOJ's `bridged`

`PackageManifest.checker` has exactly two shapes: `{ kind: 'standard' }` and
`{ kind: 'source', path, language }`. `renderInitYml` wrote the second one as a
bare string — `checker: checker/check.cpp` — and dropped `language` on the
floor entirely.

That is not a form judge-server can run. `Problem.checker()`
(`dmoj/problem.py:495-515`) branches on `'.' in name`: a name containing a dot
is a **Python module path**, loaded with `load_module_from_file`, which
`exec(compile(...))`s the file. A C++ checker therefore raises `SyntaxError` —
caught by neither the `except IOError` nor the `except AttributeError` around
that call — every time a case is checked (`dmoj/graders/standard.py:56`). Every
checker-based problem was ungradeable, and every Polygon import plans a
`kind: 'source'` checker (`packages/polygon-import/src/parse.ts`), so the
entire import path led to problems that could only ever answer IE. Reproduced
directly against the reference judge: `load_module_from_file` on a `check.cpp`
raises `SyntaxError: invalid syntax (check.cpp, line 2)`.

**The ruling: `kind: 'source'` means a testlib checker, and it renders as**

```yaml
checker:
  name: bridged
  args: { files: <path>, lang: <EXECUTOR>, type: testlib }
```

- `bridged` (`dmoj/checkers/bridged.py`) is the only builtin that compiles and
  runs a checker program; `files` is resolved against the problem root, so the
  package-relative path passes through untouched.
- `type` names a contrib module (`dmoj/contrib/`). **`testlib`** is the ruling:
  the manifest has no field for a checker dialect, the importer that produces
  every source checker we have reads Polygon packages, and Polygon checkers are
  testlib checkers. A package wanting `coci`/`peg` semantics would need a
  manifest field, which is a schema change nobody has asked for.
- `lang` is a judge **executor** key (`CPP17`), not our language key — which is
  what the manifest's previously-unread `language` field is for. Upper-casing
  is the whole mapping, the same one `apps/judged/src/main.ts` applies to a
  submission's language; it is duplicated rather than imported because
  `@duckoj/package-format` must not depend on the judged app.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B3 judging
brief), no human available to consult.*

## D43 — An editorial is a spoiler, so it is withheld from the room still solving it

Problems carry an editorial (`problems.editorial` plus
`editorial_published_at`, migration 0021): the setter's write-up, Markdown in
the same Vietnamese-then-English shape as a statement (D10). It is the one
part of a problem page that can destroy the thing the page is for, so who
reads it is a ruling and not a permission bit.

- **Published, then visible to almost everyone.** A published editorial is
  served to any viewer who may see the problem at all, anonymous included. It
  is teaching material; withholding it from readers who are not competing
  costs the province a textbook to protect nothing.
- **Withheld from a live contest, exactly as D35 withholds a tag.** A viewer
  holding a participation in a contest running *now* that uses this problem
  does not get it — the same `contestHiddenProblemIds` set, the same database
  clock, the same exemptions (the contest's `created_by`, any global admin).
  One query answers "is this person in the room" for both rules, because two
  would eventually disagree.
- **Unless they have already solved it.** An AC on the problem restores the
  editorial mid-contest: someone who has solved it cannot be spoiled by the
  solution, and the alternative makes the room's best readers the last to
  learn anything. Keyed on `verdict = 'AC'` existing, not on the `me`
  lateral's best verdict — that is a `points` ordering with its own null
  handling, and this question is not about points.
- **Never a leak of existence.** `GET /problems/{code}` carries `editorial`
  and `editorialAvailable`, and for anyone who cannot edit the problem
  `null`/`false` is ONE answer to three questions: there is no editorial,
  there is an unpublished draft, there is one you may not read yet.
  Distinguishing them would leak a setter's work in progress and, during a
  contest, the fact that a solution is sitting there to be waited for. The
  dedicated `GET /problems/{code}/editorial` route 404s
  `editorial_not_found` for all three, after the problem's own
  `problem_not_found` has had its say first.
- **An editor sees their own draft.** An author, curator or admin gets
  `editorial` populated whatever its publish state, because the edit form
  seeds its textarea from that field and a form that cannot load what it is
  about to overwrite is a way to lose an editorial. This is the only case
  where a non-null `editorial` comes back with `editorialAvailable: false` —
  which is what the publish toggle seeds from. A third
  `editorialPublishedAt` field would have said it more plainly; it would also
  have had to be masked for everyone else, so two fields it is.
- **Publishing is a claim there is something to read.** `editorialPublished:
  true` against absent or whitespace-only text is 422
  `problem_editorial_empty`, and `editorial: null` clears the publish date in
  the same UPDATE. The database holds the same rule as
  `problems_editorial_published_ck`, so an importer or a psql session cannot
  create the state either. Re-publishing does not move the date: that would
  rewrite when readers were first let in.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F4
editorials brief), no human available to consult. Migration 0021.*

## D46 — Rank titles are Vietnamese olympiad ranks, and they get a colour

D6 shipped a Codeforces-shaped placeholder and deferred the words. These are
the words. Thresholds are unchanged — D46 renamed the bands and moved
nobody's title, because a rank that changes on the same rating is a rank
nobody trusts.

| key | Vietnamese | English | from |
| --- | --- | --- | --- |
| `newbie` | Tân binh | Newbie | — |
| `pupil` | Học viên | Pupil | 1200 |
| `specialist` | Chuyên gia | Specialist | 1400 |
| `expert` | Cao thủ | Expert | 1600 |
| `candidate-master` | Ứng viên kiện tướng | Candidate Master | 1900 |
| `master` | Kiện tướng | Master | 2100 |
| `international-master` | Kiện tướng quốc tế | International Master | 2300 |
| `grandmaster` | Đại kiện tướng | Grandmaster | 2400 |
| `international-grandmaster` | Đại kiện tướng quốc tế | International Grandmaster | 2600 |
| `legendary-grandmaster` | Đại kiện tướng huyền thoại | Legendary Grandmaster | 3000 |

- **Both locales live on the same row, not in the message catalogue.** A
  band's words are DATA, exactly like a tag's two spellings (D18): the UI
  picks a field rather than looking a key up in `en.ts`/`vi.ts`. That keeps
  a rename a one-line edit in `packages/glicko2/src/bands.ts` instead of
  three edits across three files that can drift apart, and it is what the
  D18 i18n entry now says about rank titles.
- **`rankBand()` returns `{ key, nameVi, nameEn, min }`.** The unused `color`
  hex is gone. A hex on a data row could only ever be right in one of the
  two palettes, and this app has both.
- **The key IS the CSS class.** The profile renders
  `<span class="rank specialist">`, and `app.css` owns `--rank-<key>` in the
  light and the dark palette. A band renamed in the table and not in the
  stylesheet loses its colour loudly (falls back to `--fg`); a web test
  reads both files and refuses the drift.
- **This is the one amendment to app.css rule 1, "colour is reserved for
  verdicts", and it is written into that file's header.** The rank scale is
  a single desaturated ramp — cool grey, sage, teal, steel, periwinkle,
  plum, mulberry, terracotta, bronze, dark bronze — at roughly half the
  chroma of any verdict hue; it appears on exactly one row of one screen (a
  profile's rating line), where no verdict is ever rendered beside it; and
  it is never colour alone, because the band's NAME is the information and
  the hue only tints it. Every value clears 4.5:1 against both backgrounds.
  The top band also takes the weight, so "legendary" reads as such without
  needing a hue nobody had left.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F5 brief),
no human available to consult. No migration: nothing persists a rank.*

## D47 — The admin dashboard is one snapshot, and it tells the truth about what it cannot see

`GET /admin/dashboard` (session-only, admin-only, tag `Admin`) answers one
question — is judging healthy right now — with six panels in one response.
One response rather than six endpoints because the panels only mean anything
together: a queue backing up reads one way beside a live judge and another
beside a silent one, and a 15-second refresh of six routes is six times the
load for a page one admin has open. Nothing is cached; a cache would add a
staleness question to a screen whose entire job is to be current.

- **`grading_jobs` has no `running` state**, so the queue panel splits the
  leased count by the only thing that distinguishes a working judge from a
  dead one: whether the lease is still live. `running` + `expiredLeases` is
  exactly the leased total, and `expiredLeases` is written to match
  `reclaimExpiredLeases`'s WHERE clause *exactly*, because the reclaim
  button is labelled with that number — if the two ever disagree the button
  lies about its own effect. An empty queue reports `oldestQueuedSeconds:
  null`, never `0`: zero reads as "queued this instant", which is the
  opposite of calm.
- **Judges and workers are two panels, and they do not join.** A
  `judge_nodes` row is a DMOJ process that connects to judged's bridge; a
  `grading_jobs.worker_id` is one of judged's own claim loops. No column
  relates them, and inventing one would cost a migration plus a change to
  judged's dispatch for a deployment that runs one of each. So liveness
  lives on the judge panel (silent for 90 s = offline, the same
  `PING_INTERVAL_MS × MISSED_PING_LIMIT` the bridge itself drops a judge
  after, duplicated rather than imported because `apps/api` must not depend
  on `apps/judged`) and throughput lives on the worker panel.
- **A refusal is now recorded, because it was not derivable.** `rate_events`
  holds one row per attempt, admitted or not, so no query over it could
  answer "how many callers did the limiter turn away". A refusal therefore
  writes a second row under `refused:<purpose>` — from `allow`, from
  `consumeOnce` inside its transaction, and from `retryAfterSeconds`, which
  IS how login refuses. `purpose` is plain text by design, so this needed no
  migration; the two populations are disjoint because every existing count
  filters on an exact purpose; and the expired-rows sweeper already bounds
  the table by age. Known wart: login asks per key (user and IP), so one
  refused sign-in can leave two markers. Counting refusals slightly high
  during a stuffing run is the harmless direction.
- **`JUDGED_CONCURRENCY` is reported as `null` when the API was not told.**
  judged is a different container. `docker-compose.yml` now passes the same
  compose variable to both, so the number shown is the number judged runs —
  but an API started without it says "not reported" rather than printing a
  guessed `1`. A dashboard that invents a capacity number is worse than one
  that admits ignorance. Unparseable is also `null`, never a throw: unlike
  `API_WORKERS`, this knob does not govern the process reading it and must
  not be able to 500 the dashboard.
- **`POST /admin/grading/reclaim` answers 200, not 202**, unlike the rejudge
  routes: the requeue is one UPDATE that has already completed when it
  returns. Nothing is deferred that was not already the queue's ordinary
  business. It **bumps `attempt`**, which is the point of having a button at
  all — `claim` already treats a lapsed lease as claimable, so a bare
  requeue would be nearly a no-op, whereas incrementing the fencing token
  cuts off a judge still working past its lease the instant an operator
  presses it. The statement moved into `@duckoj/db` as
  `reclaimExpiredLeases` so judged's `JobStore.reclaimExpired` — dead code
  since it was written, flagged in the B3 report — and the API run the same
  sweep instead of two copies that would eventually disagree about what
  "expired" means.
- **`DashboardService` lives in `apps/api/src/authz/`**, not in `admin/`:
  two panels read `submissions` and `problems`, and the runbook's "Reading a
  guarded table" rule is not relaxed for a read whose visibility rule is
  simply "admin sees everything". `403 admin_forbidden`, not 404, because
  `/admin/dashboard` is a fixed path in the published OpenAPI document —
  there is no resource whose existence a 404 would be hiding.
- **No index was added, deliberately.** The queue and worker panels
  aggregate over all of `grading_jobs`, which grows forever (D11), and the
  failures panel filters `submissions` with no supporting index. At province
  scale these are scans of thousands of rows. The upgrade path, when
  somebody measures a need: a partial index `on grading_jobs (state) where
  state <> 'done'`, and one `on submissions (id desc) where verdict = 'IE'
  or state = 'errored'`. Recorded here so the next person finds it rather
  than rediscovering it; an index nobody has measured a need for is a
  migration and a write cost paid against a guess.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F5 brief),
no human available to consult. No migration.*

## D48 — The contest booklet is one typst document, and `## English` is the language split

`GET /contests/{key}/booklet.pdf` prints the whole contest: a cover page (name,
window, a per-problem time/memory table), then every problem in contest order
behind a page break, headed `Bài A. …`, page-numbered throughout.

- **One document, not one compile per problem.** `bookletToTypst` concatenates
  the lowering `markdownToTypst` already does (`lowerBody`, factored out for
  exactly this) and hands typst a single source. Page numbering has to run
  across the whole booklet, `#import` is only legal at the top of a document —
  so the mitex import is hoisted, and still emitted only when some statement
  actually carries math — and merging separately-compiled PDFs would need a
  second dependency to do it worse.
- **The language split is the convention `content/problems/` already uses.**
  The first top-level `## English` (or `## Tiếng Việt`) heading splits the
  Markdown: what follows is in the language it names, what precedes it is the
  other. `?lang=vi|en`, defaulting to **vi**. A statement with no such heading
  is printed WHOLE under either value — a monolingual statement is still the
  statement, and returning nothing would print an empty problem. The splitter
  is fence-aware, using the same ``` tracking the lowering does, and it drops
  the thematic break the corpus writes above the heading: `escapeText` escapes
  `-`, so a surviving `---` prints as three literal dashes on the last page.
  The heading word follows the language too — `Bài A.` / `Problem A.`
- **Visibility is the contest's problem LIST, not its scoreboard.** Pre-start
  the booklet is concealed from everyone but the people who run the contest
  (`canRunContest`), and concealed means **404**, not the scoreboard's 409
  `contest_not_started`: a distinct code would say "this contest exists and
  starts later", which is the fact the concealment withholds. D22's freeze has
  no bearing on a statement. Visibility is decided BEFORE the renderer is
  touched, so a server with no typst cannot answer 501 for a contest whose
  existence it should be hiding — `statement.pdf`'s rule, unchanged.
- **The cache key is the hash of the document, not the revision set.** 60 s in
  Redis, through the same read-through cache the scoreboard uses (now generic:
  `through<T>(key, compute, ttlMs)`). "Per revision set" was the brief's
  wording and is not enough — a statement lives in `problems.statement`, a
  plain column, so a setter fixing a typo changes no revision id and would have
  gone on serving the stale booklet for a minute. Hashing what is about to be
  typeset is the exact invalidation, which is why there is no invalidation call
  anywhere: an edit stops addressing the old key rather than deleting it.
- **The PDF rides through the JSON cache as base64**, and the cover is dated in
  `Asia/Ho_Chi_Minh` with the offset printed. A booklet handed to a room in
  Vietnam dated in UTC states the wrong hour to everyone holding it; the zone is
  fixed rather than configurable because there is no per-deploy timezone
  anywhere else in this codebase and a cover page is not the place to add one.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F6 brief),
no human available to consult. No migration.*

## D49 — Statistics count a submission only once its contest window has closed

`GET /problems/{code}/stats` — total submissions, people who tried, people who
solved, the acceptance rate, a verdict and a language histogram, the ten
fastest ACs and the first solver — plus `solvedCount`/`attemptedCount` on every
row of `GET /problems`. Visibility is exactly the problem's, decided by
`getVisible` before anything is counted.

- **The exclusion is uniform, and that is the ruling.** A submission joins the
  statistics only once its contest participation window has closed — the same
  instant D27 releases its source and D22 unfreezes its board, off the same
  `participationEndsAtSql()`, now shared by `frozenSubmissionsWhere` and
  `contestWindowOpenWhere` rather than transcribed twice. It applies to every
  viewer, an admin and the contest's own creator included. Per-viewer would
  have been defensible and is worse: it makes a 30 s cache a per-viewer cache,
  and it puts the same mask in five places where it only has to be forgotten
  once. A live room's acceptance rate is a difficulty hint of exactly the
  family D35 withholds. **Corollary, accepted:** while a contest runs, "first
  solver" can name the second person to solve it — the true first is sitting
  in an open window — and it corrects itself when the window closes.
- **D35 masks the statistics too, on the way out.** A viewer holding a
  participation in a running contest that uses the problem gets zeros, empty
  lists, `acceptanceRate: null` and no first solver: exactly what a problem
  nobody has attempted returns. Blanked, never signalled — the same rule, the
  same `contestHiddenProblemIds` set, as the tags and the editorial. The cache
  stores the TRUE object and the mask is applied after the read, so the mask
  can never be what gets cached for everybody.
- **Acceptance rate is accepted submissions / total submissions**, not solvers
  over attempters — that is what every judge means by the words, and it is what
  the verdict histogram beside it breaks down. `null`, never `0`, when there is
  nothing to divide.
- **The fastest table is one row per person**, their own best AC with a
  recorded `time_ms` (`DISTINCT ON (user_id)`, re-sorted outside), so one
  student's eleven resubmissions cannot own it. It links `/submissions/{id}`,
  which decides for itself whether the viewer may open it: the statistics
  disclose that somebody solved the problem and how fast, never their source,
  and a link that 404s for a viewer without a source grant is
  `canViewSubmission`'s existing answer rather than a new hole.
- **The list counters are ONE aggregate for the page**, never one query per row
  — the N+1 `tags` and `testCount` were hoisted onto the summary to avoid — and
  **migration 0022** adds `submissions(problem_id, user_id, verdict)` to pay
  for it. Postgres indexes no foreign key on its own and the existing composite
  is led by `user_id`, so without it the most public page in the app
  sequentially scanned a table that grows forever (D11). Measured on the test
  container at 60 000 rows: a bitmap index scan over the page's ids, 4.8 ms,
  instead of a full scan. This is the case F5's "no index, deliberately" ruling
  explicitly left open — that one was an admin-only page, this one is hot.
- **30 s in Redis**, one key per problem (`duckoj:pstats:v1:<id>`), through the
  same read-through cache the scoreboard and the booklet use. `X-Stats-Cache`
  is a header, never a body field — D25's precedent. The list counters are
  deliberately uncached: a page's ids differ per request, so the key would miss
  almost always.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F6 brief),
no human available to consult. Migration 0022.*

## D50 — A session holds every scope; `@RequireScope` governs tokens only

`GET /packages/{hash}` carries `@RequireScope('packages:read')` and answers
**200 to a plain signed-in session that has no token and no scopes at all**.
This was raised twice as a suspected auth hole (B3's hand-off, B5's brief). It
is not one — it is the design, and it is what the guards say:
`ScopeGuard.canActivate` returns `true` for `actor.via === 'session'` before it
reads any route metadata, and `hasScope` agrees independently.

The ruling, so it stops being rediscovered:

- **Scopes narrow a machine credential; they never grant anything.** A personal
  access token is a *subset* of its owner's authority, chosen at mint time. A
  session is the owner, present and interactive: there is nothing to narrow it
  down from, and refusing it would mean a user could not read a package their
  own token could.
- **`@RequireScope` is how a route opts *into* token traffic at all.** Its
  absence is not "unrestricted" — `ScopeGuard` denies by default, so an
  undecorated route is unreachable with any token. Read the decorator as
  "tokens declaring this scope may also come here", not as "this route is
  protected by this scope".
- **Authorization proper is elsewhere.** What a session may *see* is decided by
  `apps/api/src/authz/**` (and, for packages, by requiring an actor at all);
  scopes sit on top of that for tokens, never underneath it. A route that must
  refuse some sessions needs a role or visibility check in its service — a
  scope will never do it.
- **`@SessionOnly()` is the opposite marker** and the one to reach for when a
  route must be closed to tokens entirely (credential management, admin
  minting). See the runbook's "Authentication is deny-by-default".

Pinned by `apps/api/test/scope-matrix.spec.ts` (every scope × {session,
token-with, token-without, token-empty}) and `scope-guard.spec.ts`'s "lets a
session reach a scoped route regardless of scopes". Nothing changed in
behaviour; the runbook paragraph claiming `Actor.scopes` "is still read by
nothing" predated `ScopeGuard` and is corrected in the same commit.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B5 brief),
no human available to consult. No migration.*


## D53 — A package inflates to at most 1 GiB, and refuses rather than tries

`PACKAGE_UPLOAD_MAX_BYTES` (256 MiB) bounds the bytes that arrive at
`POST /packages`. It does not bound what those bytes *become*: zstd is an
amplifier, and 200 MB of zeroes compress to about 6 KB. Both readers in
`@duckoj/package-format` decompressed a caller-supplied archive into one
`Buffer` with no limit, so a 6 KB upload — waved through by every HTTP-level
check — allocated whatever the archive said, and an allocation that large
does not fail a request, it ends the process. `readArchiveEntry` runs on the
same path from `attachRevision`, so a stored package could do it too.

- **1 GiB (`MAX_UNPACKED_BYTES`)**, four times the compressed cap. Real
  provincial test data is megabytes (D20); nothing legitimate is near this.
  Larger, and a rejection stops being a rejection and becomes an OOM again;
  much smaller, and the ceiling would be a product rule about package size,
  which is not what this is.
- **Refused before allocating.** `maxOutputLength` makes zlib raise
  `ERR_BUFFER_TOO_LARGE` instead of asking the allocator, which is the only
  moment at which refusing is still possible. `PackagesService.upload`
  already turns a non-`AppError` from unpacking into `422
  package_archive_invalid`, so the bomb answers as the bad archive it is.
- **The cap is a parameter with that default**, not a hard-coded constant, so
  a test can prove the bound with a 64 KB archive instead of a real gigabyte.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B6 brief),
no human available to consult. No migration.*


## D56 — A contest's organizations decide who may JOIN it, not only who may see it

`contest_orgs` existed since Phase 4c and meant exactly one thing: which
organizations may SEE an `org`-visibility contest. So a school could run a
private contest — but the thing a school actually wants is a *public* contest
that only its own pupils may enter, and attaching an organization to a public
contest meant nothing at all, because `canViewVisible` short-circuits on
`public` before it ever looks at the shares.

**The ruling: the same table now also restricts entry.** A contest with at
least one organization may be joined only by a member of one of them. A
contest with none is unchanged — every pre-D56 row keeps its exact behaviour,
because "no organizations" is the whole of "no restriction". `orgSlugs` became
editable in the same change; it was absent from `UpdateContestRequest`
entirely, so a contest's organizations were fixed for its whole life and a
mistyped slug could only be fixed by deleting the contest.

- **403 `contest_org_required`, not 404.** This is the one refusal in
  `ContestAccessService` that is a 403 on a read-shaped path, and it is not an
  exception to the 404-over-403 rule: that rule protects EXISTENCE, and there
  is none left to protect. `loadVisible` has already shown this caller the
  contest, and every contest response now names the organizations restricting
  it. A 404 would tell a competitor looking at the contest page that the
  contest had vanished. The 400 that used to hold this code — "an org-visible
  contest needs at least one organization" — is `contest_org_missing`; one
  code meaning both "you forgot to name a school" (to a setter) and "you are
  not in one" (to a competitor) tells a client nothing.
- **The gate sits after the idempotent live short-circuit.** Only the
  CREATION of a participation is refused. A school that removes a pupil in the
  middle of a contest does not thereby delete the contest from under them, and
  an organiser who seeded a guest does not have to enrol them in a school to
  keep them competing.
- **A global admin is exempt; the contest's creator is not.** The first
  follows every other visibility decision in this codebase. The second is a
  deliberate asymmetry: running a contest is not competing in it, and a setter
  who wants a row on their own school's board can be a member of their own
  school. It does mean a creator can 403 on their own contest.
- **Attaching an organization needs OWNER or ADMIN of it, not membership.**
  Restricting a contest to a school is a claim to speak for that school; a
  pupil on its roster does not get to make it, and could before this. Problems
  keep the looser rule on purpose — sharing a problem with your own school is
  publishing to a room you are in, not conscripting it. Already-attached ids
  are exempt (as `problem.access.ts` already does), so the edit form's
  resubmission of the stored list still saves for a creator who is only a
  member of an organization an admin attached.
- **Attaching an organization PUBLISHES its slug and name** to everyone who
  can see the contest, a private organization included. That is a real
  disclosure and it is accepted: the refusal is unreadable otherwise, and "you
  may not join, and I will not say why" is the worse answer. The link a badge
  points at still 404s a stranger — naming it is the point, where it leads is
  that page's decision.
- `GET /contests?org=` answers an EMPTY page for a slug that names nothing or
  an organization the caller may not see — never 404, so the filter cannot
  become the existence oracle `GET /orgs/{slug}` is careful not to be.
  `OrgSummary.myRole` was added so a client can offer the organizations a
  setter may actually pick without one members request per row.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F7 brief),
no human available to consult. Migration 0023 indexes `contest_orgs(org_id)`:
the primary key walks `contest_id` first, so the org page's own list scanned
the table.*

## D57 — A preference the server holds beats this browser's, and `NULL` means "not chosen"

`users.locale` and `users.timezone` were `NOT NULL DEFAULT 'vi' /
'Asia/Ho_Chi_Minh'`. `PATCH /users/me` had validated and stored both since
Phase 3 and no screen could send either, so every account looked exactly like
one that had asked for Vietnamese and ICT — and with a default there is no
such thing as "the reader has not chosen".

That distinction is the whole ruling. A server preference that beat the
browser's would otherwise have forced Vietnamese onto every English-browser
visitor the moment they signed in, and ICT clocks onto everybody, undoing
D18's `navigator.language` resolution for people who had never opened a
settings screen. **So 0023 makes both columns nullable, `NULL` means "not
chosen", and only a non-null value overrides anything.**

- **The backfill nulls every value equal to the old default.** Nothing in the
  product could write either column until this release, so a stored default
  was written BY the default. A value someone set through the API that happens
  to equal the old default is lost with them; one that differs is kept.
- **Applied when the stored VALUE changes**, not on every render and not once
  per identity. Both simpler rules are wrong in opposite directions: on every
  render the nav's `VI | EN` toggle is undone a minute later when the
  notification bell refetches `['me']`; once per identity, the save the reader
  just made on `/account/settings` is swallowed, because their id has not
  moved. So the marker is `(id, locale, timezone)`, and the toggle stays a
  per-browser choice while the settings screen is the only writer of the
  account's.
- **A tag this build has no catalogue for is ignored, not half-applied.** The
  API accepts any well-formed BCP-47 tag (`fr`), deliberately — narrowing it
  to the two locales the web ships would be a product ruling that breaks the
  moment the list grows — so the web checks before adopting.
- **The recovery mails read it.** A password reset is the one piece of DuckOJ
  that reaches somebody who cannot sign in to change any setting, so both
  mails now come in vi and en, chosen by prefix (`en-GB` is English) with
  `NULL` meaning Vietnamese: a server has no `navigator.language`, and D18
  makes `vi` this judge's default. They live as whole paragraphs side by side
  in `apps/api/src/mail/templates.ts` rather than as catalogue keys, because
  for two messages that must say the same thing, reading them beside each
  other is the only review that matters.
- **`syntheticMe` returns `null` for both**, because a genuine registration
  now does and D26 requires the two bodies to be indistinguishable.
- Residual, stated rather than fixed: the scoreboard's freeze banner decides
  "is this today?" in the BROWSER's zone and then renders the instant in the
  chosen one, so the two can disagree by an hour either side of midnight. The
  question it asks — "does the reader think of this as today" — is about the
  screen in front of them, which is the honest half to leave in local time.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F7 brief),
no human available to consult. Migration 0023.*
