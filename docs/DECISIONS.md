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

### Amendment, 2026-08-30 (B9): the need is measured, and 0025 pays for it

The bullet above ends "an index nobody has measured a need for is a migration
and a write cost paid against a guess". Somebody measured. On a seeded
database of 200 000 grading jobs and 200 000 submissions — one province season,
not a stress figure — the three panels that read those tables cost 22.9 ms,
88.3 ms and 18.5 ms, **every fifteen seconds, growing forever**, because D11
keeps grading history and none of the three queries had a bound. The failures
panel is the one worth stating plainly: it walked **151 501 clean submissions**
backwards to find twenty failures, so it got *slower the longer judging went
well*. Migration **0025** adds four indexes and `dashboard.access.ts` is
rewritten around them; `apps/api/test/admin-dashboard-plan.spec.ts` asserts the
PLANS, dropping the indexes inside its own rolled-back transaction so both
directions are proved on identical rows on every CI run.

- **The two indexes this entry named are cheap because they are partial.**
  `grading_jobs (state) where state <> 'done'` is **16 kB** beside a 21 MB
  table, and `submissions (id desc) where verdict = 'IE' or state = 'errored'`
  is **32 kB** beside 23 MB. A partial index holds an entry only while its
  predicate holds, so neither grows with history — the first is sized by work
  in flight, the second by how often the judge breaks. This is the write cost
  the entry above worried about, measured, and it is nearly nothing.
- **`queue()` gained `where state <> 'done'`, which reports the same numbers.**
  Every state it counts is already non-done. The clause exists only to give
  the planner a restriction that provably implies the partial predicate; the
  spec asserts the bounded and unbounded aggregates are equal, so a future
  `grading_job_state` cannot silently blank the panel. 22.9 ms → 0.9 ms.
- **`recentFailures()`'s SQL did not change at all** — the index did the work.
  Its WHERE clause is now also the index predicate, word for word, and the
  comment says not to tidy it: Postgres serves a partial index only where it
  can prove the query's restriction implies the predicate, and the failure
  mode of an innocuous rephrase is silent. 18.5 ms → 0.35 ms, 7 084 buffers
  → 74.
- **Two FULL indexes were also needed, and that is the part this entry got
  wrong.** A time window bounds the rows a query RETURNS; only an index bounds
  the rows it SCANS. The worker panel's "graded in the last hour" therefore
  could not be fixed by windowing alone from either join direction, so 0025
  also adds `submissions (judged_at)` and `grading_jobs (submission_id)` —
  4.4 MB per 200 000 rows each, growing with history, one extra index write
  per insert. Paid deliberately: the alternative is an O(history) hash join
  every fifteen seconds against a pool of ten connections per worker.
  `grading_jobs (submission_id)` earns its place twice over — it is a
  **missing foreign-key index under ON DELETE CASCADE**, so until 0025 every
  cascaded submission delete sequentially scanned the whole job table.
- **`workers()` is now two queries merged in JavaScript**, because its two
  questions share nothing but the grouping key. `judged_at`, not `created_at`,
  still dates the throughput — windowing on `created_at` would report a worker
  chewing through a backlog as having graded nothing. The merge is full-outer:
  a worker with work in flight may have finished nothing this hour, and a
  worker that finished work may hold nothing now.
- **One thing the worker panel no longer shows**, ruled rather than
  overlooked: a worker whose every job is done and whose last verdict landed
  over an hour ago is absent, where the single query listed it forever with
  zeros. Restoring it costs `select distinct worker_id from grading_jobs` —
  the unbounded scan this whole amendment removes — and D47 already puts
  **liveness on the judge panel** and throughput here. A worker that is stuck
  rather than gone still holds a non-done job and is still listed, which is
  the case an operator is actually watching for.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B9 brief),
no human available to consult. Migration 0025.*

**Measured again 2026-08-31 (B-19).** B-8's "`workers()` is unbounded" was
carried forward as still-open through B-16, B-17 and B-18 without being
re-asked; it was closed by this amendment, and the reason it kept being
believed is that only the throughput half was ever ASSERTED. Both halves are
now in `admin-dashboard-plan.spec.ts`, on the same 100 000-row fixture and
with the same drop-the-index red direction. The live half — "what is each
worker carrying now" — reads `grading_jobs_active_idx` for 40 rows in
**0.058 ms**; drop the index and the identical statement sequentially scans
`grading_jobs` and discards 99 960 rows to find them (**6.15 ms**). The
throughput half nests `submissions_judged_at_idx` into
`grading_jobs_submission_idx` for 276 rows in **0.423 ms**. No migration was
needed, and 0038 was NOT spent here.

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

### Amendment, 2026-08-30 (B9): the list counters are cached, keyed per problem

The bullet above ends "The list counters are deliberately uncached: a page's
ids differ per request, so the key would miss almost always." The premise is
right and the conclusion only holds for a key over the SET. Keyed on a
**problem**, a page of fifty problems nobody has ever requested together is
still fifty hits — and the detail route and the list route warm each other's
entries, which the set-key version could never do.

What that cost, measured on a seeded database of 200 000 submissions against
one problem: `loadCountsByProblem` reads **200 000 index rows and 201 620
buffers in 126 ms**, uncached, on `GET /problems` and `GET /problems/{code}`
— the two most public routes in the app. Migration 0022 is what keeps it an
index scan rather than a sequential one; nothing kept it from being an index
scan over every submission the problem had ever had. The number is a **floor**:
that database held no contests, so the `NOT EXISTS` that excludes open contest
windows collapsed to zero rows instead of probing once per submission.

It survived F6, B4, B5 and B8 because it is invisible at fixture scale. The
counters are correct at every size and slow at exactly one.

- **`duckoj:pcounts:v1:<id>`, 30 s**, through the same read-through cache the
  scoreboard, the booklet and the statistics use — and the same TTL as the
  statistics beside it, for the same reason: these two numbers are a
  difficulty hint on a catalogue page, not a live board. A solve appears
  within half a minute.
- **The statement count went DOWN, not up**, and getting this wrong was the
  first attempt: caching a page by calling the read-through helper once per
  row turns D49's single grouped aggregate into one round trip per problem —
  the exact N+1 the catalogue endpoints exist to avoid, and
  `problem-me-verdict.spec.ts`'s "a fixed number of statements for a page,
  regardless of how many rows are on it" caught it immediately. So
  `ScoreboardCache` grew `throughMany`: read every key, then compute only the
  misses, together. **One aggregate on a cold page, none on a warm one, never
  one per row.** That test is the reason this entry describes an improvement
  rather than a trade.
- **No `X-…-Cache` header**, deviating from D25 and from `getStats`. A page
  mixes hits and misses per problem, so one boolean would have to lie about
  one of them, and a header per problem is not a thing HTTP offers.
- **A problem nobody has attempted caches ZEROS**, not an absent entry.
  Otherwise the one problem a setter reloads constantly — the one they are
  still writing — is the one that never has an entry to hit.
- **The D35 mask is untouched and stays outside the cache.** Every call site
  checks `contestHiddenProblemIds` and returns `BLANK_COUNTS` without reaching
  the method at all, so what is stored is always the true count. That is this
  entry's own rule for the statistics cache, unchanged.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B9 brief),
no human available to consult. No migration.*

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

## D58 — A roster is a page, and the viewer's own standing rides on the row

`GET /orgs/{slug}/members` served every row of `org_members` in one array,
and so did the four writes that answer with the roster. `org_members` has no
bound: a province's school with 5,000 accounts serialised 5,000 rows on every
click, on the one shape every sibling list (`/problems`, `/contests`,
`/orgs`, `/submissions`, `/users`) abandoned long ago. The B6 report named
it; this closes it.

- **Keyset on `username`, which is also the sort column.** The cursor is the
  last username on the page, so it is stable under concurrent joins and
  departures — a member added before the cursor cannot push a later one onto
  a page already read, and one removed cannot make the walk skip a row.
  `users.username` is unique, so no tiebreaker is needed, and `>` and
  `ORDER BY` resolve under the same collation, so the walk cannot disagree
  with the sort.
- **The four writes answer the FIRST page**, with its own `nextCursor`. A
  write's body is a convenience refresh, not the roster of record; a client
  that needs the rest pages the read endpoint like anybody else.
- **A cursor longer than a username is 422 `invalid_cursor`**, not a scan —
  the same refusal every sibling list makes for a cursor its ordering column
  could never hold.
- **`OrgSummary` gains `myRole`, and that is required by the above, not a
  bonus.** The org screen derived "am I in this?" by searching the roster it
  had just downloaded whole. Once the roster is a page, a member sorted past
  the first page reads as an outsider and is offered a "Join" button for an
  organization they already belong to. The viewer's own standing is one fact
  about one row, so it travels with the row. It leaks nothing — it says only
  what the caller already knows about themselves — and the list computes it
  for a whole page in ONE extra query (`rolesOf`), never one per row.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B7 brief),
no human available to consult. No migration.*

**Amended 2026-08-30 (F13 owed sweep):** `GET /users/{username}/rating` — the
one collection B7 named as still unpaged — now takes the same shape: a
hundred a page, keyset on `(contests.end_time, contests.id)`, 422
`invalid_cursor` for anything the ordering could not have issued. The id is
the tiebreaker because two divisions of one round end on the same bell, and
a cursor keyed on the instant alone would skip the second or serve the first
twice. The profile appends pages behind "Tải thêm".

## D59 — A truncated broadcast is ordered, and it says so

`broadcast` capped its recipient list with `.limit(NOTIFY_CAP)` and no
`ORDER BY`. That is not a cap, it is a lottery: `SELECT DISTINCT … LIMIT n`
lets Postgres return whatever the plan reaches first, so a room over the cap
notified an arbitrary — and, between two announcements, a *different* —
subset, and nothing anywhere said anybody had been left out. The B6 report
named it; this closes it.

- **Ordered by `user_id`.** Not because low ids deserve to be told first,
  but because a deterministic truncation can be reproduced, explained and
  re-run; an arbitrary one cannot. On a test-sized room the planner picks
  Sort+Unique and emits that order anyway — which is why the clause is
  asserted on the compiled statement rather than only on a result set: a
  behavioural test passes with it deleted, and the plan that does not
  (HashAggregate, on a real over-cap room) cannot be summoned from a
  fixture.
- **The truncation is logged at `warn`, with the contest key and the
  clarification id.** The announcement still succeeds — refusing to post it
  would be worse — so the organiser has no way to learn from the response
  that part of the room was not told. The log is the only place that fact
  can exist, and it is what an operator has to go on when a competitor
  reports never seeing an announcement.
- **`NOTIFY_CAP` stays 10,000, and the cap is a parameter.** The bound is
  unchanged (four times the largest room this is built for); taking it as an
  argument is what lets the truncation be proved against four participants
  instead of ten thousand.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B7 brief),
no human available to consult. No migration.*

## D60 — `POST /packages` refuses a manifest that names files it does not have

`upload()` parsed the manifest and threw the parsed value away: the archive's
real file list and the manifest's promises were both in hand and never
compared. So a package whose manifest names `tests/01.out`, or a
`checker: { kind: 'source' }` whose source was never packed, was hashed,
stored and served — and refused only much later at `attachRevision`, by the
rule B6 added there. The B6 report left this open as "one line to add if
wanted". It was wanted.

- **The same `findMissingPackageFiles`**, not a second copy. Completeness is
  a property of a package's contents, independent of whether it is checked
  while building the archive, while uploading it, or while attaching a
  revision — and two copies is exactly how the checker path came to be
  checked nowhere at all.
- **422 `package_manifest_incomplete`**, its own code rather than the
  neighbouring `package_manifest_invalid`. The two have different fixes:
  invalid means "correct the JSON", incomplete means "pack the file", and
  the message names which files are missing so the second is actionable.
  Deliberately NOT `attachRevision`'s 400 `package_invalid`: that is the
  code vocabulary of the problem-revision endpoints, and this endpoint
  answers 422 for every "this archive is not acceptable". The RULE is
  shared; the wire code belongs to its own route.
- **Refused before anything is stored.** A package that cannot be attached
  to any revision is a dead blob with a permanent hash — garbage an eviction
  pass has to reclaim, and a hash a client can hold and believe in.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B7 brief),
no human available to consult. No migration.*


## D61 — A school's roster is imported in one all-or-nothing call, and the accounts it mints must change their password

A province seats thousands of pupils who will never sign themselves up.
`POST /orgs/{slug}/members/import` takes a CSV or a JSON list of
`{ username, displayName, email? }`, at most 2,000 rows, and either creates
every account or none of them. The rulings inside it, each taken by the
implementer with nobody available to ask:

- **All-or-nothing, with every bad row named.** A partial import leaves a
  teacher holding a printout that is right for some of their class and
  silently wrong for the rest, and the natural repair — run it again — then
  trips over the accounts the first run did create. The 422 is
  `member_import_invalid` and every failure rides in `ProblemDetails.fields`
  keyed `rows[<n>].<field>`, `n` being the 1-based data row, so a client can
  put each message beside the line that caused it without widening the error
  schema every other endpoint shares.
- **Uniqueness is decided the way the unique indexes decide it** —
  case-folded, against the database *and* against the rest of the file.
  `users_username_lower_idx` means two rows differing only in case are one
  account; a raw-string check passes validation and then fails the INSERT,
  turning a legible 422 into a rolled-back 500.
- **Owner or global admin, not an organization `admin`.** Approving a join
  request is running the organization; minting two thousand accounts on a
  province's judge is speaking FOR the school, which the rank below owner
  does not. 404 before 403, as everywhere.
- **`dryRun` validates, creates nothing, and consumes no meter.** It is what
  the web's preview is built from, and the normal flow is a teacher fixing
  one row and resubmitting — a meter that punished that would make the
  preview useless. The real import is one per organization per minute,
  through `RateLimiter.consumeOnce` (race-free by design) keyed on the
  organization **ID**, because a slug is patchable and a meter keyed on one
  could be reset by renaming the school.
- **A missing address becomes `<username>@<slug>.import.invalid`, marked
  verified.** `users.email` is `NOT NULL` and uniquely indexed and most
  pupils have no school mailbox. `.invalid` is RFC 2606's reserved TLD, so
  the placeholder can never be delivered to and can never be somebody's real
  address; marking it verified is D19's ruling for `bootstrap-admin`, for
  D19's reason — the alternative parks the account behind a mail that will
  never arrive. An address the roster DOES supply is left unverified: a
  school asserting a pupil's mailbox is not that mailbox having been
  confirmed.
- **A taken address is named in the 422**, which narrows D26's
  anti-enumeration posture deliberately and in one place only: the caller is
  session-authenticated, is an owner of this organization, and is metered,
  so this is not the anonymous oracle D26 closed — and an all-or-nothing
  import that cannot say which row it choked on is unusable.
- **The passwords are twelve characters from an alphabet with no `I`, `L`,
  `O`, `i`, `l`, `o`, `0` or `1`.** They are read off a printed sheet by a
  thirteen-year-old; the failure this prevents is a pupil who cannot sign in
  because two glyphs look alike. Hashing runs OUTSIDE the transaction (two
  thousand argon2id hashes is tens of seconds) and at a concurrency of four,
  so an import does not enqueue two thousand 19 MiB jobs ahead of everyone
  else's sign-in.
- **`users.must_change_password` (migration 0024) and
  `POST /auth/password/change`.** An imported account holds a password it
  never chose, so between the import and the first sign-in one sheet of
  paper is the credential for a whole class. The flag is what lets the
  change endpoint accept a new password WITHOUT the old one — demanding it
  back would make that sheet the credential authorising its own replacement
  — and what stands in for it is the route's `@SessionOnly` marker. For
  every other account `currentPassword` is required, and its absence is a
  422 rather than a silent success. Succeeding clears the flag and destroys
  every session and token, as `resetPassword` does; a fresh cookie is issued
  so the caller stays signed in on the device they are looking at.
- **The flag is enforced by the web, not by the API.** `PasswordGate` swaps
  the whole page (a redirect is one `history.back()` away from being undone)
  while the flag is set. The API deliberately does not gate other routes on
  it: doing so would mean auditing every endpoint for a new refusal code
  that a client can already avoid, in exchange for stopping a pupil who
  would have to be driving the API by hand to reach it.
- **The CLI (`corepack pnpm org:import <slug> <file.csv>`) goes through the
  database, not the API.** The brief offered either; the route is
  `@SessionOnly`, so a token is refused before the handler runs and the
  first option does not exist. It is not a second implementation: the rule
  lives in `apps/api/src/authz/org-import.core.ts`, framework-free precisely
  so `scripts/tsconfig.json` (no decorator support) can import it — the same
  arrangement `bootstrap-admin.ts` has with `password.hash.ts`. That module
  also writes the owners' notification itself rather than through
  `NotificationsService`, which is otherwise the one writer of that table:
  the service is `@Injectable`, so routing it there would mean the CLI
  silently sent no notification at all, which is the case where it matters
  most. Reaching `DATABASE_URL` is the authority, so the CLI has no owner
  check and no meter, exactly as `bootstrap:admin` has none.
- **The 100 KB JSON body limit stays for every route but this one.** A
  full roster is up to ~1.2 MB; raising the limit globally would undo the
  early `413` that `app.smoke.spec.ts` pins for an oversized submission. A
  2 MB parser is mounted on the import path alone, ahead of the ordinary
  one.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F8 brief),
no human available to consult. Migration 0024.*

**Amended 2026-08-30 (F13 owed sweep):** a request carries **at most 500
rows**, not 2,000. The F8 report's own concern was wall time — 2,000 argon2id
hashes is twenty-odd seconds, and a proxy or browser timeout there strands
accounts whose passwords nobody ever received. Five hundred keeps a request
near six seconds; over that the 422 now says to split the file. The teacher
never has to: **the web panel splits it**, sequentially, with a progress bar
and one merged credentials table, using the SERVER's own record grammar
(`@duckoj/contracts/org-import-csv.ts`, moved there from the API so the two
cannot disagree about where a quoted newline ends) with the file's header
repeated in every chunk. Two consequences: the meter becomes **ten imports
per organization per minute** (`allow`), which is the same 5,000 rows a
minute the old single call could do — losing `consumeOnce` costs nothing,
because the duplicate submission it guarded is refused by the unique index
inside `runImport`'s transaction anyway — and the panel refuses a username
the FILE repeats across two chunks before sending anything, since no single
request can see that. A chunk that fails mid-sequence shows the credentials
the earlier chunks did create, beside the reason it stopped.

**Amended again 2026-08-30 (B13 leftovers):** the whole-file check covers
**both identity columns**, not the username alone. B11 recorded the gap as
"one field short", and the B13 brief carried a diagnosis of it that turned
out to be wrong — worth writing down, because the wrong diagnosis is the
expensive thing to build:

- **The server already refuses a repeated address across chunks, and creates
  nothing when it does.** Probed against a real database: chunk one imports
  `dung@thpt.vn`, chunk two names it again, and `validateImportRows` answers
  `422 member_import_invalid` with `rows[1].email`, because `takenIdentities`
  reads `users` — where chunk one's accounts already are. Pinned now by a
  test, so it cannot quietly stop being true.
- **What is actually missing is in the PREVIEW.** A preview creates nothing,
  so a whole-roster preview compares each chunk against an empty table and
  every chunk comes back clean. The teacher then presses import and the
  sequence strands: chunk one's accounts exist, chunk two is refused, half a
  class holds a printout. That is the defect, and it lives where the file is
  split rather than where a request is validated.

So the fix is the panel's `crossChunkDuplicate`, extended from usernames to
usernames **and** addresses, case-folded the way `users_username_lower_idx`
and `users_email_lower_idx` fold them, with a blank address skipped (the
placeholder is derived from the username, so it collides only when the
username already has). `importUsernames` becomes `importIdentities` in
`@duckoj/contracts`, beside the grammar it reads.

**Three server-side shapes considered and refused**, each because it costs
more than the client check that closes the case:

- **A short-lived Redis set of addresses per organization.** Wrong substrate
  for a refusal: every Redis use in this system is best-effort and fail-open
  by design (D25), the test harness points `redisUrl` at a closed port on
  purpose, and a correctness guard that silently stops guarding when Redis
  blinks is worse than no guard. It also adds nothing the `users` check does
  not already do for real imports.
- **A claim ledger in `rate_events`.** Same information as `users` for a real
  import, and for a preview it *breaks D61's own workflow*: the normal flow is
  a teacher fixing one row and previewing again, which would collide with
  their own previous preview. Scoping it to a sequence needs a client-supplied
  sequence id — new contract surface to protect one client from duplicates in
  a file that client is holding in full.
- **Exempting `dryRun` from the 500-row cap**, so one preview sees the whole
  file. It drags the row cap, the body-size limit and the preview table along
  with it, for a case the client check kills outright.

What remains after this is the preview→import race — somebody registering one
of these addresses in the seconds between — and that already has its answer:
the unique violation is caught, validation is re-run, and the caller gets the
422 naming the row rather than a 500.

## D62 — A contest booklet carries the problems the reader may read, not the contest's whole list

`GET /contests/{key}/booklet.pdf` (D48) read `problems.statement` for every
row of `contest_problems`, gated only on "may this caller see the contest"
and "has it started". Every other statement surface in the product is gated
on `canViewProblem`, whose contest clause is `inJoinedContest` — a
**participation**, not merely being able to see the contest — which is why
`GET /problems/{code}` and `GET /problems/{code}/statement.pdf` 404 a private
problem for a spectator. So the booklet published, in full, the text those
two routes withhold.

**The ruling: `loadBookletRows` is narrowed by `visibleProblemsWhere`, for
every caller including the contest's own creator.** A booklet is a bundle of
statements, and a bundle may not carry what its parts may not.

- **D56 is what makes this a leak rather than an inconsistency.** A public
  contest restricted to one school refuses `join` with 403
  `contest_org_required`, so a rival school's pupil has no route to a
  participation at all: "the same access by a longer route", the argument
  that excuses the post-start problem LIST being public, does not hold for
  them. At the bell they could download every statement.
- **Filtered, not refused.** A caller who may read three of five problems
  gets a three-problem booklet rather than a 404 — the same shape
  `getVisible` already takes, where the problem list is served and the
  statements behind it are not. A booklet with nothing in it renders as a
  cover page, which the lowering already supports.
- **No exemption for the organiser.** `canRunContest` is not a problem-level
  permission, and `resolveProblemIds` already required the creator to be able
  to see every problem they attached — an author or curator, or an admin —
  so in practice the creator passes `visibleProblemsWhere` on their own
  problems. A setter who was a *tester* and has since been removed loses the
  booklet with the statement, which is the same answer `GET /problems/{code}`
  gives them, and one predicate that answers the same everywhere is worth
  more than an exemption that only this route would carry.
- **The cache needs nothing.** `bookletCacheKey` hashes the finished
  document, so a filtered booklet and a full one are different keys by
  construction — there is no privileged/public split to add and no way for
  one viewer's entry to answer another's request.

*Ruled by the reviewer during the 2026-08-29 feature/bug loop (B8 whole-diff
review), no human available to consult. No migration.*

## D63 — The clarification feed is capped at 200, and says when it cut

`GET /contests/{key}/clarifications` had no bound: "not paginated — a
contest's Q&A is read whole, on one screen", which is a true statement about
the screen and says nothing about the table behind it. `POST
/contests/{key}/clarifications` admits **20 questions per user per contest per
hour**, so a 2000-seat provincial room can write 40 000 rows of up to 2 000
characters in the contest's first hour. Every one of them was serialised into
every read — and `ClarificationsPanel` repolls this route **every 30 seconds
for every reader while the contest runs**. Two thousand browsers × a
multi-megabyte body × every half minute is an outage the product inflicts on
itself on precisely the day it exists for.

**The ruling: 200 rows, newest first, plus `truncated: boolean`.** The same
shape as D59's broadcast cap, and for the same reason — a silent `.limit()`
is a lie a reader cannot detect.

- **Capped, not paginated.** A cursor would be the "right" answer and the
  wrong change: the panel is a reverse-chronological feed nobody scrolls to
  the bottom of, a cursor is a second contract plus infinite-scroll UI, and
  neither buys anything the cap does not. If a real room ever wants the older
  rows, pagination is an additive change on top of this.
- **The cap drops the OLDEST.** `order by id desc` already sorted newest
  first, so the announcement posted thirty seconds ago is never the row cut —
  which is the only property a contest-day feed genuinely has to hold.
- **`limit(FEED_CAP + 1)`, not a second COUNT.** "Was anything left out" is
  answered by the same query that fetched the page, so the flag and the body
  cannot disagree. `broadcastRecipientsQuery` already does exactly this.
- **The web says it out loud** (`clar.truncated`, vi + en). A reader who
  cannot see the whole conversation must not believe they can.

*Ruled by the reviewer during the 2026-08-29 feature/bug loop (B8 whole-diff
review), no human available to consult. No migration.*


## D64 — The booklet cover is dated in the reader's own timezone, and prints the offset it used

D48 fixed the contest booklet's cover to `Asia/Ho_Chi_Minh` and printed the
string `(GMT+7)` beside it, reasoning that "there is no per-deploy timezone
anywhere else in this codebase". Two releases later D57 gave every account
`users.timezone`, a settings screen to set it on, and made every other date in
the product honour it — so by the time B-8 flagged the constant, the booklet
was the one page in DuckOJ that ignored the clock its reader had chosen. **The
cover now reads `users.timezone` for whoever asked for the PDF, and falls back
to ICT.**

- **The viewer's zone, not the organiser's.** `contests` carries no timezone
  column, and adding one would be a migration for a field no screen can set —
  which is precisely the shape D57 rejected when it made these columns nullable
  rather than defaulted: a stored preference nobody can edit is not a
  preference, it is a default wearing a disguise. The account's zone is a value
  somebody actually chose.
- **`NULL` still means "not chosen" (D57), and unchosen means ICT (D18).** An
  anonymous downloader — `booklet.pdf` is `@Public` — and an account that never
  opened the settings screen both get the room's own clock, which is the answer
  D48 was right about for the case it was thinking of.
- **The offset is DERIVED, and that is the real defect this ruling fixes.**
  `(GMT+7)` was a literal sitting beside a formatter pinned to the same zone:
  true only while both halves stayed frozen, and the moment the zone became the
  reader's it would have stopped being stale and started being a confidently
  wrong hour on a page somebody sits an exam from. It is computed from the zone
  at the contest's START, not at render time, because a zone with daylight
  saving has two answers and the one that matters is the one in force when the
  room sits down.
- **An unresolvable zone prints ICT rather than 500ing.** D57 deliberately
  accepts any well-formed value into the column, so `Mars/Olympus` is reachable
  and `Intl` throws on it. One bad row on one account must not be able to break
  the printable problems for a whole room at the bell.
- **The cache needed no work, and that is worth stating** because the opposite
  reading would send somebody rewriting it. D48 keys the booklet on a hash of
  the document about to be typeset; the zone changes the cover text, so two
  zones are two keys by construction, with no invalidation call and no
  per-viewer cache design. The cost is a lower hit rate on a 60-second TTL in a
  room that is overwhelmingly on one clock.
- **Residual, stated rather than fixed:** a booklet is a shared artefact. If an
  organiser prints one set of papers for a room, every copy carries the
  organiser's zone, not each student's — which is correct, and is what printing
  means. The per-reader rule governs the PDF a reader downloads for themselves.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (B9 brief),
no human available to consult. No migration — `users.timezone` already exists
(0023).*

## D66 — Homework is assigned to a school, and a late solve is shown beside the on-time one rather than instead of it

A province's teachers organise practice by handing out a list of problems and
a date. Until now the judge had no word for that: a contest is the wrong
shape (it ranks, it freezes, it has a start you may not enter before), and a
tag is a topic, not an assignment. `problem_sets` + `problem_set_items`
(migration 0026) plus six routes under `/orgs/{slug}/sets` are the word —
*bài tập về nhà*, homework, belonging to one organization.

- **Three questions, in this order: may you see the school, do you belong to
  it, do you run it.** The first is `OrgAccessService`'s existing visibility
  gate, unchanged — a school you may not see 404s with no mention of sets.
  The second is new: a set list is **empty** for a member-less viewer of a
  *visible* school, and every individual set 404s
  (`problem_set_not_found`). Blanked, never signalled — D35's shape — because
  "this school has assigned nothing" is a real state and must be
  indistinguishable from "you are not in this class". It is not tidiness: an
  item may name an `org`-visibility problem shared with this school alone, so
  a readable set is a readable list of problem codes.
- **A late solve is its own entry on the cell, not a flag on the counted
  one.** Each cell carries `onTime` and `late`, either of which may be null.
  The alternative — one "best" attempt plus `late: true` — has to choose, for
  a pupil with an on-time `WA` and an `AC` two days later, between showing
  the `WA` (and never telling the teacher they got there) and showing the
  `AC` (and making the deadline mean nothing). Both, side by side, is the only
  shape that says what happened. **The deadline is inclusive**: a submission
  made at the stroke of it is on time. With no deadline, `late` is always
  `null` — there is nothing to be late for. `solvedAt` is non-null only for
  an `AC`, because "solved at" is a claim about solving it.
- **The grid does not count a submission whose contest window is still open;
  the pupil's own page does.** D49's uniform exclusion, reused verbatim
  (`contestWindowOpenWhere`), because a set that reuses a live contest's
  problem would otherwise be a scoreboard of that room, readable by a teacher
  who is not running it. The pupil's own view is exempt for D23's reason: a
  submission's author is never masked from their own result. The accepted
  consequence — a pupil sees their score before their teacher's grid does.
- **A problem the school's members could not open is refused, 422.** Public,
  or `org` shared with THIS organization; `private` and another school's `org`
  problem are both `problem_set_problem_private`, an unknown code is
  `problem_set_problem_unknown`, and a code twice is
  `problem_set_problem_duplicate` — every failure in `fields`, keyed
  `problems[<n>].code`. A problem NARROWED after it was assigned keeps its
  row, marked `visible: false`: the teacher assigned it, and the page simply
  stops offering a link that would 404.
- **The CSV is the whole roster; the JSON grid is a page.** The rows are
  D58's keyset roster page, cursor and 422 included — except under
  `?format=csv`, which serves every member. That is a deliberate exception to
  D58, not an oversight: the export exists *because* a paged grid cannot be
  handed to a spreadsheet, and a file that stops after twenty-five pupils is
  a file somebody would mark a class from. A dated set gets a second
  `<code> (late)` column per problem, because that is the whole of what a
  deadline buys the person reading the sheet.
- **D35 has nothing to mask here, by construction.** A set item carries the
  problem's code, name and its per-set points — no tags, no difficulty, no
  acceptance rate — so a set page cannot become the hint D35 withholds from a
  room still solving. Adding any of those to an item later means adding
  `contestHiddenProblemIds` with them.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F9 brief),
no human available to consult. Migration 0026.*

**Amended 2026-08-30 (F13 owed sweep):** the CSV is still the whole roster
rather than one page — that exception stands — but it is **walked in cursor
pages of 500 and capped at 20,000 rows**, and a file that stopped early says
so on a final `truncated,<rows>` line rather than letting a teacher mark a
class from a file that ended without warning. Both bounds are injected
(`PROGRESS_EXPORT_BOUNDS`), so the cap is provable at three rows. The JSON
grid and the export now share ONE page query, which the old whole-roster
branch quietly forked — and paging it also bounds the `IN` list of the
per-page best-submission lookup, which used to carry the entire school. The
web grid grew the "Tải thêm" button its own screen had only been describing.

## D67 — The interface is Apple's Liquid Glass, and every pane has a solid twin

The retro terminal ("IBM Plex Mono only, no glass, no blur, no gradients, no
shadows, no rounded corners", `app.css`'s old header) is replaced, by the
owner's direction, with Apple's Liquid Glass: translucent layered surfaces
over a quiet ground, hairline specular edges, soft depth, continuous-feeling
corners, and short fluid motion. What did NOT change is what the terminal was
actually protecting — colour still belongs to verdicts and to the one rank
ramp D46 carved out, every verdict still carries a glyph as well as a hue,
and the statement is still the only surface that is not dense.

**Two files, and the split is meaning.** `apps/web/src/design/tokens.css` is
new and owns the MATERIAL: neutrals, four glass depths (`bar`, `sheet`,
`raised`, `inset`), radii, blur, shadows, spacing, motion, and the two font
stacks. `app.css` owns the two SEMANTIC scales — the verdict hues and the
D46 rank ramp — beside the `.badge`/`.case`/`.rank` rules that paint them,
because a hue and the rule that paints it are one decision and because
`test/user.spec.tsx` reads that file to prove the ramp matches
`packages/glicko2`.

- **Glass is chrome; data is not.** The floating nav, the page sheet, panels,
  buttons, fields and chips are translucent. Tables, statements, code blocks
  and case grids sit on an opaque-enough inset well inside them and never
  blur their own backdrop: a blurred scoreboard is a scoreboard nobody can
  scan, and a per-row `backdrop-filter` is the single most expensive thing
  this app could ask a phone to composite.
- **Every glass token has a solid twin, declared once.** Under
  `prefers-reduced-transparency: reduce` AND under `@supports not
  (backdrop-filter)`, every `--glass-*` resolves to `--panel` and every
  `--blur-*` to `0px`, in the token layer. No component rule has to
  remember, so a surface added later inherits the fallback for free.
  `prefers-reduced-motion` flattens every duration the same way, which is
  only sound because no component rule hardcodes a duration —
  `test/app-css.spec.ts` fails if one ever does.
- **Body prose moves to the system UI stack; data stays on IBM Plex Mono.**
  This amends D18's "Fonts needed no change… app.css's IBM Plex Mono only
  rule intact". `--font-ui` is `-apple-system, "SF Pro Text", "Segoe UI",
  Roboto, "Noto Sans", sans-serif` — resolved entirely locally, no web font
  added — and carries headings, prose, labels and nav. `--font-mono` is the
  same vendored face as before and carries everything read as DATA: tables,
  scoreboards, code, verdicts, case grids, field values, numbers. The
  vietnamese subset therefore still covers every problem code, username and
  org name that lands in a table, which is what it was self-hosted for.
- **The ground is drawn, not photographed.** Three low-alpha radial washes
  over a flat floor, `background-attachment: fixed`. That is a design choice
  with a verification consequence: because the app controls every pixel
  behind every pane, the composite under each glass surface is knowable, and
  the contrast below is measured rather than hoped for.

**Contrast, measured.** 22 text colours × 6 surfaces (`bar`, `sheet`,
`raised`, inset-on-sheet, inset-on-raised, the solid twin), each composited
over all four grounds the wash produces, worst case reported:

| | light | dark |
| --- | --- | --- |
| worst of all pairings | **4.53:1** (`--tle` on `sheet`) | **4.53:1** (`--mle` on `raised`) |
| `--fg` | 16.6–18.0 | 12.0–14.5 |
| `--dim` (nav, labels, `.muted`) | 7.2–7.8 | 7.3–8.8 |
| verdict hues | 4.53–6.7 | 4.53–7.0 |
| rank ramp (all ten) | 5.5–9.0 | 5.8–12.0 |

Getting there moved the MATERIAL, never a hue: light `--glass-sheet` 0.72 →
0.79 and the wash alphas down, dark `--glass-raised` 0.74 → 0.82 and darker.
`.badge` and `.case` gained an inset backing so a verdict's contrast is a
property of the component instead of a property of whatever the page is over.

Two honest exceptions:

- **`--rte` in dark mode was wrong and is fixed.** It had been left at the
  LIGHT palette's #cf222e since the dark scheme was written and measures
  2.7–3.3:1 on every dark surface — a runtime-error verdict a reader with
  normal vision could not see. It is #ef6a5f (4.8:1 worst case), still the
  darkest of the three reds, and the three were already told apart by glyph.
  This is a correction, not a re-palette: D46 reserves the SEMANTICS, and a
  value that fails AA is not a semantic.
- **The pessimistic bound is not met, and does not apply.** Over a backdrop
  this app does not draw — pure black or pure white behind the glass —
  `--dim` falls to 2.3–4.5:1. That is the honest limit of translucency, and
  it is why the ground is a drawn wash and not user imagery. If a background
  image is ever put behind this glass, these numbers must be re-measured.

**Targets and focus.** 44px for anything a thumb aims at (nav items, form
controls, page-level buttons); WCAG 2.2's 24px-with-spacing for the dense
inline controls where 44px would destroy the scanning the table exists for
(`td button`, `.tag`) and 36px for the twenty-five topic-filter labels, where
the LABEL is the target and not the 13px box inside it. One focus ring,
`--fg`, never removed. The floating bar is offset by `scroll-padding` at both
edges so it cannot obscure a focused control (WCAG 2.2 Focus Not Obscured).

**The phone gets the bar at the bottom**, fixed, safe-area aware — which is
why `index.html` now carries `viewport-fit=cover`; without it
`env(safe-area-inset-bottom)` is always 0 and the bar sits under the home
indicator. The twelve nav items scroll sideways inside the bar rather than
wrapping to three rows; `overflow-x` is on the bar's inner div and never on
the document, so journey 6's `scrollWidth <= innerWidth` still holds at
390×844 on every screen.

**No JSX changed.** The whole design lands in CSS plus one meta tag. Three
class names the routes were already emitting against nothing — `.panel`,
`.muted`, `.field` — were given the meanings their names claim, which is what
made that possible; `.shell-nav`, `.badge`, `.case`, `.num`, `.rank`, `.dq`,
`.tag`, `.stats`/`.stat` and the print classes are unchanged. There is no
toast component, because nothing in this app emits a transient message:
`role="alert"` and `role="status"` are persistent lines rendered beside the
control that produced them, and they are styled as banners.

*Ruled by the implementer during the 2026-08-30 UI loop, on the owner's
explicit direction ("Apple's Liquid Glass"), no human available to consult on
the details. No migration: nothing persists a stylesheet.*

## D68 — A judge is dispatched to by what it can run, and a job nobody can run stays queued and says so

Scaling to a second judge was documented (docs/runbook.md, "Adding a second
judge container") and untested: the steps ended "not built — these are the
exact steps, not a tested procedure", the second node had to be inserted with
a hand-typed `insert ... encode(sha256(...))`, and `DmojDriver` picked a
connection by **idleness alone**. Idleness is the right rule for a fleet whose
members are identical and the wrong one the moment they are not — the first
judge configured differently gets sent a language it has no executor for and
answers `internal-error`, which reaches the student as a permanent IE.

**The ruling: capability is part of scheduling, and the queue is honest about
what it cannot run.** Four parts.

- **A judge's capabilities come off its own handshake.** DMOJ's handshake
  carries `executors`; `BridgeServer` now keeps that set per connection and
  writes it to `judge_nodes.capabilities` — a column that had existed since
  the first schema draft and was written by **nothing** (D47's report says so
  in as many words). `concurrency` is recorded as **1**, not read from the
  wire, because the wire does not carry it: one grade per connection is D29's
  ruling, and recording it makes an operator able to read the number instead
  of having to know it. Executors are handshake-only — judge-server
  re-announces problems (`supported-problems`) but never executors — so a
  judge that gains one must reconnect, which it does anyway.
- **Dispatch routes; the claim loop filters.** `DmojDriver` picks an idle
  connection *that can run the job's language*, waits while every capable one
  is busy, and rejects with `NoCapableJudgeError` when judges are connected
  and not one of them can run it — re-checked on every wake, so the only
  capable judge disconnecting wakes the parked dispatch instead of leaving it
  to the grading ceiling. An **empty** fleet still parks, deliberately: a
  judge restarting empties the bridge for a second or two, and failing every
  in-flight job over a routine `podman restart judge` is worse than the wait
  `tryAcquireSlot` already prevents callers from entering. Above
  it, `Worker` passes `driver.supportedLanguages()` into `JobStore.claim`,
  which filters **inside the oldest-first pick**. That ordering is the whole
  design: claiming a job and then refusing it would have the same query
  re-claim the same row on the next turn, forever, starving everything behind
  it. Filtered out, it simply stays `queued`.
- **`blocked_reason` is a nullable text column, not a new state.** A blocked
  job IS queued — it becomes runnable the instant a capable judge connects —
  so a `grading_job_state` value would need a sweeper to undo, and would make
  every existing query that reasons about `queued` wrong. `JobStore.claim`
  clears it in the same UPDATE that claims (being claimed disproves it), and
  `markBlocked` reconciles it in **both** directions when a claim comes back
  empty, at most once per five seconds per loop. It is skipped entirely when
  no judge is connected: "nobody speaks your language" is the wrong diagnosis
  for a queue whose real problem is that the fleet is down.
- **`grading_jobs.judge_node_id`, written on dispatch** (migration 0027,
  `on delete set null`), from the bridge connection the request actually went
  to — carried to the writer on the `dispatched` event, which now names its
  node. D47 declined this join for a deployment running one judge of each
  kind; a second judge is exactly the condition it named. A driver that cannot
  name a node (every in-process double) writes nothing rather than a guess.

**`revoke` burns the token, it does not delete the row.** `scripts/judge-node.ts`
(`add` / `list` / `revoke`) replaces the runbook's hand-typed SQL, and `add`
generates the token itself — no `--token` flag, because an operator-chosen
judge token is the one credential nobody ever rotates and argv is shell
history. Revoking overwrites `token_hash` with `revoked:<old hash>`: not valid
hex, so `verifyJudgeCredential`'s length check fails it closed before
`timingSafeEqual` ever runs, still unique under `judge_nodes_token_idx`, and —
the actual point — the row survives, so the `judge_node_id` join above keeps
naming the machine that graded each submission.

**`last_seen` now follows any packet, throttled.** The design specified
handshake and `ping-response` (§8), which under-reported a judge two minutes
into a grade and streaming test-case packets. Any decoded packet may refresh
it, at most once per 15 s per judge — a sixth of D47's 90 s offline threshold,
and far short of one UPDATE per test case.

**Left open, deliberately.** `tryAcquireSlot` counts judges, not per-language
slots, so on a heterogeneous fleet a claimed job can be one only a *busy* judge
can run while an idle incapable judge holds no work. That is a parked dispatch,
safe since D29 (a cancel while parked rejects), but it weakens D29's "a claimed
job is always immediately runnable" to "always runnable by some connected
judge". Per-language slots need the driver to know the claim's language before
the claim, which is a bigger change than this bought. Also: the executor↔language
map is a bijection only because every key today is its executor lowercased
(`cpp17` ↔ `CPP17`); both directions are written as one pair in
`apps/judged/src/main.ts` so a language like `python3` → `PY3` has one place to
extend, not two to drift.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F11 brief),
no human available to consult. Migration 0027.*

## D69 — Security response headers are set at the edge, and the CSP allows inline styles because KaTeX needs them

The deployment served **no** security response headers at all. Verified
against the live stack: `curl -sD - http://localhost:8080/` carried no
`Content-Security-Policy`, no `Strict-Transport-Security`, no
`X-Content-Type-Options`, no `Referrer-Policy` and no `X-Frame-Options` —
and the SPA's `index.html` is the one document that runs author-controlled
statement HTML through `dangerouslySetInnerHTML` (`apps/web/src/markdown.ts`).

**They go in the `Caddyfile`, not in `app.setup.ts`.** The SPA document is
served by Caddy's `file_server` and never touches Node, so a header the API
set would miss exactly the response that matters. The always-on four
(`HSTS`, `nosniff`, `Referrer-Policy`, `X-Frame-Options`) are site-level;
the CSP is scoped to the SPA `handle` block, because the Scalar docs viewer
at `/api/v1/docs` needs a laxer one and the JSON API needs none.

**The CSP, and the one concession it makes.** `script-src 'self'` with **no**
`'unsafe-inline'`: the Vite build emits only external hashed module scripts
and no inline script (see `apps/web/index.html`), so an injected `<script>`
cannot run even if it survived DOMPurify. `style-src` **does** carry
`'unsafe-inline'`, and that is forced rather than lazy — KaTeX writes an
inline `style="…"` attribute on essentially every rendered formula, so
without it every statement's maths renders unstyled, which per
`markdown.ts`'s own comment means the MathML copy renders *as well as* the
visible one: wrong content, not merely ugly content. The concession is on
`style-src` only and never reaches `script-src`, which is where it would
matter. `img-src 'self' data: https:` admits the data-URI and remote images
statements legitimately embed; `object-src 'none'`, `base-uri 'self'`,
`frame-ancestors 'none'` and `form-action 'self'` close the plugin, `<base>`
hijack, clickjacking and cross-origin-form doors.

**Why not `helmet`.** It would set the app-level half and still leave the
`file_server` response bare, so the CSP would have to be duplicated at the
edge anyway — one place is better than two that can disagree.

Pinned by `apps/api/test/security-headers.spec.ts`, which reads the
`Caddyfile` the way `proxy-keepalive.spec.ts` does, and verified empirically
against a throwaway `caddy:2-alpine` container serving this exact file.

*Ruled by the implementer during the 2026-08-30 security loop (B10 brief),
no human available to consult. No migration.*

## D70 — The WebSocket upgrade checks `Origin`; a missing one is a non-browser client

`SubmissionsGateway` authenticates a browser by its **session cookie**, and a
`new WebSocket()` from an attacker's page is not subject to CORS — the
handshake is a plain HTTP upgrade the browser will happily send cookies on.
The only thing standing between a malicious origin and a victim's live
submission feed was that the cookie is `SameSite=Lax`. That is one control,
and it is a real one; it is not the standard *second* one, and the gateway's
own header comment already concedes that everything it does about
authentication is "load-bearing rather than defence in depth".

**The rule: a present-but-wrong `Origin` is refused with 403.** A real
browser always stamps `Origin` on an upgrade, so a wrong one is a cross-site
attempt with no legitimate reading.

**A MISSING `Origin` is allowed**, and that is the deliberate half. The `oj`
CLI, the judge agent and every test client are non-browser callers: they set
no `Origin`, they carry no ambient cookie for an attacker to abuse, and they
authenticate with a bearer token in a header a hostile page cannot set. This
is exactly the shape CORS itself has — a header-less request is not a
cross-origin one — and refusing it would break every programmatic client to
guard against an attacker who, by construction, cannot reach this path.

The permitted origin is `publicOrigin`, injected as `ALLOWED_WS_ORIGIN`
rather than read from config in the gateway, so a test can pin the bound
without standing up a second deployment — the same shape `MAX_SUBSCRIPTIONS`
(and `MAX_UNPACKED_BYTES`, D53) already uses.

*Ruled by the implementer during the 2026-08-30 security loop (B10 brief),
no human available to consult. No migration.*

## D71 — A contest's results are exported by the people who run it, at any hour, and a disqualified row is carried and flagged

Three routes, all `Contests`, all gated on the one predicate `canRunContest`
— the contest's creator or a global admin, the same test `canEdit` reports:

- `GET /contests/{key}/results.csv` — the final standings as a spreadsheet.
- `GET /contests/{key}/results.pdf` — the same board typeset landscape.
- `GET /contests/{key}/certificates.pdf?top=N|username=…` — one A4 landscape
  "GIẤY CHỨNG NHẬN" per participant.

**Who, and when: the person, never the clock.** The brief asked for "after
`end_time`, or the organiser at any time". That reads as two gates and is one,
because of what these documents are: every one of them is folded from the
**live, unfrozen** board. `getScoreboard` hands a privileged caller the board
with no clock at all (D22), which is the only thing that makes a results sheet
a results sheet — a final standings that hides the last hour is not one. So a
"after the end, anyone may export" clause would publish through a `.csv`
exactly what D22 and D23 spend the scoreboard and the submission list hiding,
for any contest whose freeze window is still open, and for a virtual entrant
still inside their own window it would keep doing so past `end_time` (D22's
per-participation clause). The API's gate is therefore the person. The
**web** is where "after the end" lives: `contests.tsx` offers the two links
only when `canEdit && phase === 'finished'`, because that is when an organiser
wants them and offering them mid-contest invites printing a board still moving.

**403 `contest_forbidden`, not 404.** `loadVisible` has already shown this
caller the contest, so there is no existence left for the 404-over-403 rule to
protect — the same reading `answerClarification`, `announce` and D56's
`contest_org_required` already take.

**A disqualified row is exported, and flagged.** D37 keeps an expelled
competitor ON the record — the record of what happened is the row — so the CSV
carries them with `disqualified,true` and the PDF marks them `[DQ]`. Dropping
them would produce a file describing a different contest from the one the
scoreboard shows. `virtual` is exported as the **number** (`0` live, `n` the
n-th replay), not a boolean: which replay it was is a fact a flag destroys,
and spectators (`-1`) are never ranked so they never appear.

**A certificate is an award, not a record — so it inverts that rule.**
Disqualified rows and virtual replays get none, and `top=N` counts down the
ranking *after* that exclusion, so `top=3` is three certificates rather than
two and a gap. A `username` naming an ineligible or unranked competitor
answers 404 `contest_participant_not_found` without saying which of the three
reasons applied. The rank printed is the row's own rank from the board, never
its index in the filtered list.

**The issuer is the contest's organizations (D56), else the site.** A contest
run by two schools together is signed by both, joined. There is no `siteName`
config in this codebase, so the fallback is the constant `'DuckOJ'` rather
than a new configuration key invented for a signature line.

**The org column is the COMPETITOR's own organizations**, names, ordered by
slug and semicolon-joined — not the contest's. "Which school is this pupil
from" is the question a provincial results sheet exists to answer, and a
column identical on every row answers nothing. It comes from
`authz/participant-orgs.ts`, a free function in the shape
`org.visibility.ts` already uses: `org_members` is a guarded table, and the
runbook's "Reading a guarded table" forbids reaching it from a service
outside `authz/**`.

**The CSV is bytes aimed at Excel.** A UTF-8 **BOM**, because Excel does not
sniff encodings and a `.csv` without one is read in the machine's ANSI code
page — `Nguyễn` arrives as `Nguyá»…n`, which is the entire reason a Vietnamese
deployment needs this decision written down. CRLF, RFC 4180 quoting, and
ASCII snake_case headers that are **never translated**: the header row is the
file's contract with whatever script reads it next, and the Vietnamese in the
file is the data. Text fields that came from a person (`username`,
`display_name`, `orgs`) and begin `=`, `+`, `-`, `@`, tab or CR are prefixed
with an apostrophe — CSV injection, whose target is precisely this shape:
stranger-supplied text, exported by an administrator, opened in a
spreadsheet. Generated numbers are never guarded; a score cannot begin `=`,
and a guard firing on one would turn every number in the sheet into text.

**Neither PDF reads a clock, and the cache is why.** Both are cached 60 s on a
**hash of the document about to be typeset**, exactly as the booklet is (D48),
so a rejudge, a rename or a disqualification stops addressing the old entry
rather than needing an invalidation call — and there is none anywhere. A
certificate dated "now" would hash to a fresh key every second and the cache
would cost a sha256 and never hit once, so a certificate is dated by the
contest's **end**. Two prints are then the same document, which is also the
right property for a thing handed to a person. The **CSV is deliberately not
cached and not routed through the renderer**: it is a string built from an
already-2 s-cached board, and sharing a handler with the PDFs would make it
answer 501 `statement_pdf_unavailable` on a server with no typst, for a file
that needs none.

**Neither document can carry a statement (D62), by construction rather than
by a clause.** A standings sheet and a certificate are names, ranks and
numbers; a problem's LABEL appears, because it is on the public scoreboard
already, and its text has nowhere to go. `results.pdf` therefore takes no
`?lang=` — the headings are fixed Vietnamese with an English subtitle.

*Ruled during task F12 with nobody to ask. No migration.*

## D72 — Credential management is metered, and turning the second factor off costs the password

B1 found two doors left ajar by D33 and named them in its rulings section:
`POST /auth/totp/confirm` had no attempt limiter ("twelve wrong codes all
answer 422"), and `DELETE /auth/totp` demanded nothing at all. Both were
left on the argument that the caller already holds the session. That is
precisely the argument that fails: a session is the thing an intruder
steals, and both routes are reachable with exactly the stolen thing.

- **Ten confirmations per account per fifteen minutes, 429
  `totp_confirm_rate_limited` with a `Retry-After`.** A confirm attempt is a
  guess at six digits against a secret the server has just issued; unmetered,
  a scripted loop covers a meaningful share of the space in minutes. The
  meter is read BEFORE the code is checked, so a *correct* code inside a
  spent window is refused too — a limiter the winning guess walks past is not
  a limiter. `RateLimiter.allow` rather than `consumeOnce`: this is a
  nuisance bound, and `allow` records the refused attempt as well, so a
  hammering caller keeps burning their own window. Keyed on the user id, so a
  fresh session does not buy a fresh ten, and one account cannot spend
  another's.
- **`DELETE /auth/totp` carries `{ password }`; a wrong one is 401
  `invalid_credentials`, an absent one 422.** The same code and status
  `POST /auth/password/change` answers for the same mistake. A password, not
  a TOTP code: the phone is the thing that gets lost, which is why the
  recovery codes exist, and demanding the authenticator to *remove* the
  authenticator would strand exactly the user this route is for.
- **The check lives in `TotpService.disableWithPassword`, not in `disable`.**
  `AdminUsersService.resetTotp` calls `disable` to unlock somebody who lost
  their phone, and an admin does not hold that person's password. Two
  callers, two rules, one clearing routine — the recovery codes still go with
  the credential in the same transaction (D39).
- **The web replaces its `confirm()` dialog with the password field rather
  than asking twice.** A dialog proves the click was deliberate; this route
  needs proof of who is clicking, and the stolen session has the click.

*Ruled by the implementer during the 2026-08-29 feature/bug loop (F13 owed
sweep), no human available to consult. No migration.*





## D73 — The password check is metered wherever a session re-proves it

D72 closed two doors by demanding the account password, on the argument
that **a session is the thing an intruder steals** and both routes are
reachable with exactly the stolen thing. It then left the check that reads
that password unmetered, which is the same argument left half-finished: an
unmetered password check reachable from the stolen session is an unlimited
oracle for the password itself, answering 401 or 2xx on every guess, needing
no email, no second factor and no fresh sign-in. `POST /auth/login` has been
metered since B1 precisely so that door is shut; `POST /auth/password/change`
and `DELETE /auth/totp` were the way round it.

- **Ten attempts per account per fifteen minutes**, 429
  `password_check_rate_limited` with a `Retry-After` — D72's shape for the
  same class of guess, and generous for the human case it has to survive
  (somebody mistyping their own password before getting it right).
- **ONE budget across both routes**, `spendPasswordCheck` in
  `authn/password-check.ts`. Not one meter per route: a budget spent per
  endpoint grows with the number of endpoints that check a password, which
  is the wrong direction for it to grow in. Keyed on the user id rather than
  the session, so a fresh sign-in does not buy a fresh ten and one account
  cannot spend another's.
- **Read BEFORE the hash is verified**, and `allow` rather than
  `consumeOnce` — both verbatim from D72, for D72's reasons: a limiter the
  correct guess walks past is a limiter the attacker's winning guess walks
  past, and a refused attempt should burn the window it was refused by.
- **Nothing that checks no password spends it.** An account flagged
  `mustChangePassword` (D61) changes its password without presenting one, so
  that path is not metered — a class of pupils replacing the credential off
  a printed sheet must never meet this 429. Neither `resetPassword` nor
  `AdminUsersService.resetTotp` spends it either; they prove who they are
  another way.

There is a second reason for the bound that has nothing to do with guessing.
Every check is one argon2id verification at 19 MiB on the libuv thread pool
this process shares with every sign-in and every roster import (D61), so a
loop on either route is a denial of service against signing in, driven from
one ordinary session.

*Ruled by the implementer during the 2026-08-30 B-11 review loop, no human
available to consult. No migration.*

## D74 — `top=N` certificates never cut through a tie

The scoreboard ranks in competition style (`packages/contest-formats/src/
scoreboard.ts`): equal score and equal penalty share a rank, and after a
group of k tied rows the next rank jumps by k. D71's certificate selection
was `eligible.slice(0, top)`, which is a count — so a contest whose third
and fourth rows both rank **3** answered `top=3` with a certificate for one
of them and nothing for the other, decided by the order the scoreboard
happened to break a tie it does not print. Two pupils with identical results
stand in the same hall and one of them is handed a piece of paper.

**The boundary is a rank, not a count.** `top=N` certifies everybody whose
rank is at or above the rank held by the Nth eligible row. `top=3` over
ranks 1, 2, 3, 3 is four certificates, and the fourth is not an error: it
says "Hạng 3 / Rank 3", which is what the board says. An organiser who wants
exactly N sheets of paper is asking a question the board cannot answer, and
answering it anyway means answering it wrongly for the person left out.

Everything else about D71's selection stands: the disqualified and the
virtual replays are excluded first and `top` counts down what remains, the
rank printed is the row's own rank from the live board, and `?username=`
still answers 404 `contest_participant_not_found` without saying which of
the three reasons applied. A `top` larger than the eligible field still
certifies the whole field.

*Ruled by the implementer during the 2026-08-30 B-11 review loop, no human
available to consult. No migration.*

## D76 — The nav is two information architectures: a grouped desktop bar and a five-tab phone bar with an overflow sheet

The shell rendered one flat row of links. Signed in, that row was twelve
items — problems, contests, orgs, submissions, API, help, admin, tokens,
security, settings, password, the bell — plus the language toggle, the
display name and sign out. On a desktop it was a wall of equal-weight links
with no answer to "which of these is the app and which is me". At 390px it
was a sideways scroller, which D67's review flagged as its first concern: a
bottom tab bar is at most five items, and anything a reader has to swipe into
view is, for most readers, not there.

**Desktop (>700px) keeps one glass bar and groups it into three named
clusters.** `Bài tập · Kỳ thi · Bài nộp · Tổ chức` is where the work is;
`Trợ giúp · API`, plus `Quản trị` for an admin, is reference; the account
cluster — bell, display name, settings, security, tokens, password, language,
sign out — is pushed to the right rail behind a hairline. Each is a
`role="group"` with a name, so the grouping is in the accessibility tree and
not only in the pixels. Admin sits with reference rather than with the
account: it is a place in the app, not a setting on the person.

**The account cluster groups; it does not collapse.** A dropdown was the
obvious shape and is the wrong one here. On the shared school machines this
judge is aimed at, "the previous pupil is still signed in" is the default
state — that is why a sign-out control was added at all — and a way out that
costs a discovery click is a way out nobody takes. The e2e journeys encode
the same rule: they assert the sign-out button and the display name are
visible with no interaction. On a desktop there is room, so both stay on
screen; on a phone there is not, so both move into the sheet and cost two
taps.

**Phone (≤700px) gets five tabs and a sheet.** `Bài tập`, `Kỳ thi`,
`Bài nộp`, then the bell for a member (`Đăng nhập` for a visitor, because a
bell with no session behind it is a dead tab), then `Thêm`. `Thêm` opens a
glass sheet holding everything else: orgs, the profile, the four `/account/*`
screens, admin when the viewer is one, help, the API reference, the language
toggle and sign out. Every route the flat bar reached is one tap away or two
through the sheet. Each tab is an SVG icon above its own word — an icon alone
is a guess, and this app's readers are pupils meeting it for the first time —
and `flex: 1 1 0; min-width: 0` across five columns is what keeps journey 6's
`scrollWidth <= innerWidth` true without the old inner scroller.

**Which tree renders is a JS media query, not CSS.** A modal sheet with a
focus trap cannot exist as a CSS state, and rendering both trees would put
every link in the document twice — which breaks every `getByRole('link', …)`
in the suite and makes the accessibility tree lie. `usePhoneLayout` reads
`window.matchMedia('(max-width: 700px)')` and subscribes to it, so a rotation
swaps architectures without a reload. jsdom does not implement `matchMedia`
at all, so it answers *desktop* there: the whole pre-existing unit suite goes
on exercising the bar it always did, and the phone tree is reached by
stubbing the global.

**The sheet is a real modal.** `role="dialog"`, `aria-modal`, and a `Thêm`
button carrying `aria-haspopup="dialog"`, `aria-expanded` and
`aria-controls`. Focus moves into it on open, Tab and Shift+Tab wrap inside
it, Escape closes it (listened for on the document, because a backdrop click
leaves focus on `<body>` and a container-scoped listener would then be deaf),
the backdrop closes it, every item inside closes it on the way out, and
closing returns focus to the button that opened it — a keyboard reader
dropped at the top of the document after each dismissal re-walks the whole
page to get back. It renders as a **sibling** of `<nav class="shell-nav">`,
never a child: the bar carries a `backdrop-filter`, which makes it the
containing block for `position: fixed` descendants, and a full-screen
backdrop nested inside it is clamped to the bar's own 58px box. The slide-up
is `animation: … var(--dur)`, so `prefers-reduced-motion` flattens it to
0.01ms through the D67 token rather than through a rule this file has to
remember.

The backdrop is a `<button>` — a dismiss target is a control — but
`aria-hidden` and `tabIndex={-1}`: it duplicates the named close button for a
pointer, and two controls called "Đóng" is one more than a screen reader can
tell apart. Nothing focusable is hidden by it.

Every target is `--tap` (44px) or taller, the fixed bar and the sheet both
pad by `env(safe-area-inset-bottom)`, the active item in either shape is the
raised glass pill `aria-current="page"` already earns from TanStack Router,
and one new token — `--scrim` — carries the modal ground in both schemes.
The unread count is rendered twice on purpose: as a badge (`aria-hidden`)
for the eye, and inside `nav.notifications`' sentence for the ear.

*Ruled by the implementer during the 2026-08-30 UI loop (navigation IA), no
human available to consult. No migration; `apps/web` only.*


## D77 — A similarity report is an organiser's magnifying glass, never a verdict

`POST /contests/{key}/similarity` starts a source-similarity check over a
contest; `GET` returns the latest run and its pairs; `GET
/contests/{key}/similarity/{a}/{b}` serves two competitors' sources side by
side with the matching regions marked. All three are tagged `Contests` and
gated on the one predicate `canRunContest` — the contest's creator or a
global admin, the same test `canEdit` reports and D71's exports refuse on.

**The load-bearing ruling is what the report MEANS.** A high score is a
reason for a person to look at two programs. It is not evidence of guilt, and
the product never treats it as one: nothing here disqualifies anybody,
notifies anybody, or appears on any screen a competitor can reach, and the
caution saying so is on the screen rather than in a footnote. Identifiers are
erased before anything is compared, which is exactly what makes a renamed
copy detectable and also what makes two students taught the same technique by
the same teacher score high while being innocent. A report that is treated as
a finding is worse than no report.

**D27 is not weakened; its exempt set is reused.** D27 withholds a contest
submission's `source` from everyone but its submitter, the contest's creator
and a global admin — and that set is precisely `canRunContest`. The pair view
therefore hands an organiser nothing they could not already read one
submission at a time; what it adds is that they no longer have to know which
two to open. It refuses any pair the latest run did not report, so it cannot
become "show me any two competitors' code".

Ten further rulings, taken with nobody to ask:

- **The algorithm is a package, `@duckoj/similarity`, with no dependencies.**
  Language-aware tokenisation (C/C++/Python/Java: comments and whitespace
  erased, identifiers normalised to one placeholder, literals collapsed to
  `N`/`S`, keywords and operators kept), then k-gram hashing (k=5) and
  winnowing (window 4) into fingerprint sets. Winnowing guarantees that any
  shared run of `w + k - 1` tokens contributes a shared fingerprint, which is
  the property that survives a copier rewriting one line in five.
- **Two measures, and the threshold tests CONTAINMENT.** Jaccard is
  shared/union; containment is shared over the smaller set. Padding a copy
  with dead code is the first thing a copier does, and it moves Jaccard while
  leaving containment where it was. Containment is never below Jaccard, so
  this admits every pair either measure would. Both are printed, because
  0.93/0.30 (one solution buried in a longer file) and 0.93/0.85 (the same
  file twice) are different stories.
- **The default threshold is 0.6, and 0.3 is the floor.** Below that the
  table fills with independent solutions to easy problems, and a report
  nobody trusts is worse than none. The threshold is stored ON the run: a
  report keeps the number it was actually made with.
- **One submission per person per problem: their AC, else their best, ties
  to the latest.** An accepted solution is the finished work; a 90-point
  wrong answer is a draft.
- **Live participations only; disqualified rows included.** A virtual replay
  is somebody sitting a finished contest with the statements already public —
  not the fraud this feature is about, and comparing replays against the live
  board would report every competitor who later read a published solution. A
  disqualified competitor is often exactly whose code an organiser wants
  compared; that is frequently *why* they were disqualified.
- **Compared only inside a language family.** `cpp17` against `cpp20` is one
  language; Python against C++ is noise with a number on it. A language the
  package has no lexer for is skipped, and the run says so through
  `compared`, rather than failing.
- **A job row, not a request that blocks.** `similarity_runs` (migration
  0028) is inserted and committed before the work starts, and the work runs
  in the API process under `pg_advisory_xact_lock(SIMILARITY_LOCK,
  contest_id)` — per contest, so two contests are checked in parallel and one
  contest never is, across every forked worker. A second request while one is
  going answers 409 `similarity_running`; a failure writes `status: 'failed'`
  rather than leaving a row saying `running` forever.
- **Two caps, refused differently, because they are known at different
  times.** Participants above 3000 is knowable before any work: 422
  `similarity_too_large`, with the actual number in the hint. Pairs above 500
  on one problem is only knowable after comparing: the lowest-scoring tail is
  dropped, `truncated` is set, and the web says so. You cannot refuse what
  you only learn by doing.
- **`{ run: null }`, never 404, for a contest nobody has checked.** A 404
  there is indistinguishable from "no such contest".
- **The side-by-side view is a route, not a disclosure panel.** "Look at
  these two" is a URL an organiser sends to a colleague. Sources are rendered
  as React children, never as markup; matched spans are `<mark class="match">`
  over a token-tinted background, so a screen reader announces them and the
  glass surface survives.

*Ruled by the implementer during the 2026-08-30 feature loop (F-15), no human
available to consult. Migration 0028; new package `packages/similarity`.*

## D78 — The expired-rows sweep is batched, and its three predicates are indexed

`ExpiredRowsSweeper` bounds the three authentication tables nothing else
deletes from. Its own docstring ruled that no schema change was needed: *"A
DELETE by age against `rate_events_lookup_idx`'s trailing `created_at` (and
the sessions / one-time-token expiry columns) is cheap at any table size this
deployment will see."* Measured in B12, **both halves of that sentence are
false**, and this entry is the correction. Migration **0029**.

- **A btree bounds a scan by a PREFIX of its columns, and `created_at` is the
  THIRD.** `rate_events_lookup_idx` is `(purpose, key, created_at)`; the
  sweep's predicate names neither of the first two, so the index it was said
  to use could never serve it. Measured on a 1,000,000-row fixture with ~4%
  sweepable, picking **one batch**: `Seq Scan on rate_events`, **56.5 ms and
  8 084 buffers** without 0029, against `Index Scan using
  rate_events_created_at_idx`, **1.97 ms and 135 buffers** with it — 29x the
  time and 60x the pages, for one batch of 860. The parenthetical is worse than
  imprecise — `sessions.expires_at` and `one_time_tokens.expires_at` had **no
  index at all**, so it asserts two indexes that were never created. Both are
  added, and both are proved the same way at 200 000 rows.
- **The fraction is what makes the index matter, not the row count.** An
  hourly sweep deletes the hour that just fell out of a 24-hour retention — a
  sliver of the table. A fixture where the predicate matched most rows would
  let a `LIMIT`ed sequential scan stop almost immediately and the planner
  would keep choosing it *with the index present*, so the spec would be
  unfalsifiable. `expired-rows-sweeper-bounded.spec.ts` seeds ~4% (rate
  events) and 5% (both expiry columns), oldest-last, which is also how an
  append-only table sits on disk: the rows worth deleting are at the far end
  of the heap and a seq scan must walk everything else to reach them.
- **One statement is not a bounded amount of work.** The module's header
  estimates 8.6M `rate_events` rows a day under a login-stuffing run — the
  case the sweep exists for — and deleting them in one DELETE is one
  transaction holding one long lock, one WAL burst, and no progress kept if it
  is interrupted, so the next hour restarts the same 8.6M-row statement and
  fails the same way. `SWEEP_BATCH_SIZE` is 10 000: 860 short committed
  transactions instead of one long one, and an interruption costs the last
  batch rather than all of it. What the two halves are worth together: 860
  unindexed batches is **48 seconds of pure scanning** per sweep, per worker,
  against 1.7 seconds indexed.
- **`ctid in (select … limit n)`, because Postgres has no `DELETE … LIMIT`.**
  The subquery picks n physical row addresses through the new index and the
  DELETE removes exactly those. It stays inside drizzle's
  `.delete().where()`, so `affected()` still reads the driver's count and the
  sibling spec's rule — *never* `.returning()` — is untouched. The comparison
  is a drizzle `lt()` on the COLUMN, never raw `created_at < $1`: interpolated
  into a template postgres.js has no column to infer a type from, a `Date`
  fails at bind time with `ERR_INVALID_ARG_TYPE`, which this sweep would have
  swallowed as a warning line nobody reads. Caught by the spec, not in
  production.
- **The loop ends on a SHORT batch, not on an empty one.** "Zero rows
  removed" would cost one extra round trip per table per sweep on the common
  case of a table with nothing to sweep, in every worker, every hour. A table
  with nothing to sweep costs exactly one statement.
- **The fix is the pair, deliberately.** An index with no batching still
  deletes 8.6M rows in one transaction; batching with no index still scans the
  whole table once per batch. Neither half is worth shipping alone.
- **Three full indexes, and the write cost is accepted.** The predicates are
  `< now()` comparisons against a moving bound, so no partial index can serve
  them — D47's partial-index trick does not apply here. One extra index write
  per session, per one-time token and per rate event is the price; the
  alternative is a full scan of a forever-growing table every hour in every
  worker.

*Ruled by the implementer during the 2026-08-30 soak loop (B12 brief), no
human available to consult. Migration 0029.*

## D79 — `POST /submissions` stays unmetered, and the number that would change that is recorded

Every other costly write in the API is rate limited — login (D16),
registration (D26), account recovery (D13), clarifications (D63), TOTP, the
org import. `POST /submissions` is **not**, and it is the endpoint that
enqueues the most expensive work the system does: one grading job, one
container, one compile.

B12 measured what that is worth before ruling on it, because "add a limit"
without a number is how a limit ends up refusing a legitimate contest.

- **Measured judge throughput is the constraint, and it is small.** One
  `judged` worker (`JUDGED_CONCURRENCY=1`) against one DMOJ judge grades
  `tong-hai-so` — 12 tests, a 1000 ms limit — at the rate recorded in
  `load/RESULTS.md`. A single unmetered client can enqueue faster than that
  from one connection, so the queue is bounded by nothing but how fast a
  caller can POST.
- **It is not fixed here, and that is a ruling rather than an oversight.**
  A limit is a contract change (a 429 with `Retry-After` in
  `packages/contracts`), a web change (the submit button has to say why it was
  refused), and a product decision about what a legitimate contestant does —
  a room re-submitting after a failed test is exactly the burst a naive limit
  would break, on the one day it must not. That is a feature brief, not a
  perf fix, and B12's scope is measurement.
- **What the queue actually does under the load is recorded** in
  `load/RESULTS.md`'s judging-soak section: queue depth over time,
  time-to-verdict p50/p95, and whether the single judge keeps up at a
  province-shaped arrival rate. Whoever writes the limit should set its
  threshold from those numbers rather than from a guess, and should measure
  against the same soak.
- **The mitigations that already exist are real but partial.** D68 keeps a job
  nobody can run from starving the queue, the lease and its fencing token make
  a flood recoverable rather than corrupting, and `/admin/dashboard` shows the
  depth. None of them stops the enqueue.

*Ruled by the implementer during the 2026-08-30 soak loop (B12 brief), no
human available to consult. No migration, no code change — this entry is the
deliverable.*


## D80 — `POST /submissions` is metered: one per ten seconds and twenty per ten minutes, per user

D79 ruled this endpoint should be metered, deliberately did not build it, and
recorded the measurement a threshold should be set from. This is that limit.
It is the last costly write in the API that was unmetered, and it enqueues the
most expensive work the system does: one grading job, one container, one
compile.

**The numbers, and where each comes from.**

- **One every ten seconds** is a burst bound, and it is a judgement rather
  than a measurement. What it stops is the double-clicked button and the
  script in a loop — neither is malicious and both cost a container per press.
  Ten seconds is longer than anyone means to wait between two *different*
  solutions and shorter than anyone notices after reading a rejected one.
- **Twenty every ten minutes** is the sustained bound and it IS the
  measurement. B12 recorded 35.3 verdicts a minute out of one judge, with the
  queue reaching 23 and a p95 time-to-verdict of 39 s (`load/RESULTS.md`). Two
  a minute per person means eighteen people can submit continuously before one
  judge is the constraint — comfortably past what a room does. Somebody
  submitting twenty times in ten minutes is debugging against the judge, and
  the twenty-first attempt is worth ten seconds of thinking.

The case that must NOT break is the one D79 named: a room re-submitting after
a failed test. That is one submission per person at the same moment, and it
meets neither bound — a per-user meter cannot be tripped by a room's size.

**Organisers and admins are metered on the same terms — no exemption.** The
thing being bounded is a grading container, and a container costs the same
whoever enqueued it: an admin looping on `/submissions` starves a contest
exactly as a contestant would. An exemption would also put the one account
most likely to be scripted outside the only bound on the queue. Bulk grading
has its own door, `POST /admin/rejudge`, metered as its own thing.

**Keyed on the USER.** Not the session (signing out and in would buy a fresh
budget), not the token (`POST /auth/tokens` mints them freely, so the meter
would bound one token and nothing else), and above all not the IP: a school
computer room is one address, and metering it would refuse thirty pupils for
the actions of one. D16 pairs its per-IP window with a per-identifier one
precisely because each catches what the other cannot; there is no second
window to pair with here, because an authenticated submission has exactly one
identity behind it.

**`retryAfterSeconds` + `record`, never `allow`** — login's split (D16), for
login's reason turned around. `allow` records the attempt it refuses. With a
limit of ONE that is fatal: a double-clicked button would extend its own
cooldown on every refusal, and somebody leaning on the key would never be
allowed to submit at all. So the window is spent only by a submission that was
actually created, and a refusal costs the caller nothing.

**Where each half sits in `create`, and why:**

- The **check runs first**, before a single row is read — D26's rule for
  `register`, where the meter runs ahead of the argon2id hash. A refused caller
  costs this process nothing, and a 429 decided without consulting the problem
  can leak nothing about one.
- The **record runs last**, after every other refusal and before the
  transaction opens. After validation, so a mistyped problem code does not cost
  a contestant ten seconds of cooldown for a submission the judge never saw;
  before the transaction, so a failure to record can never leave a created
  submission this meter did not count.
- `record` is handed the **ten-minute** window, never the ten-second one. It
  deletes this key's rows older than the window it is given, so the burst
  window would sweep away the rows the sustained count is made of on every
  submission — a limiter that passes every test about its short window and
  enforces nothing. A test pins the row count for exactly this reason.

**`Retry-After` is the LONGER of the two windows** when both are spent. A
caller who has used their ten minutes and is told to come back in ten seconds
comes back fifty times to be refused again, which is a limiter generating the
load it exists to prevent.

**What the two clients do with it.** The web submit page reads the header,
disables the button for that many seconds and counts down in the reader's own
language (`submit.rateLimited` / `submit.cooldown`, vi and en) — "wait a
moment" with no number is the message that gets pressed again immediately.
`oj submit` prints the wait in its refusal line, because somebody driving the
CLI in a loop is exactly who needs the number.

*Ruled by the implementer during the 2026-08-30 B-13 leftovers loop, no human
available to consult. No migration — `rate_events` takes a new `purpose`
without one, which is that column's whole design.*

## D81 — A revoked judge loses its socket within five seconds, and the check is a POLL

`verifyJudgeCredential` runs exactly once per connection, in the handshake.
`judge:node revoke` (D68) burns the token hash in `judge_nodes` and there is
nothing on the bridge socket to announce that it happened — so a judge
revoked while connected **kept its connection**, kept answering pings, and
kept being chosen by dispatch. B11 recorded it as "handshake-only
verification; its package fetches 401, so the work fails rather than
completing", which is not a mitigation: it is every submission sent to that
judge failing instead of being graded, which is strictly worse than the judge
not being there at all.

`BridgeServer` now re-checks its connected set every **five seconds** through
`@duckoj/db`'s `admittedJudgeNames`, and closes and retires anything the
answer omits. Five seconds against a table holding one row per machine ever
registered; the brief asked for ten and this leaves margin for a slow query
inside it.

**A poll, not `LISTEN`/`NOTIFY`.** NOTIFY is the better shape for a hot
table, and this is the coldest table in the schema: a row is written when a
judge is registered and rewritten when one is retired, perhaps twice a year.
Paying for it in a dedicated long-lived `LISTEN` connection — which needs its
own reconnect logic, its own "did I miss a notification while disconnected"
answer, and a trigger plus a migration to emit from — buys nothing a
five-second `select` over a handful of names does not already give, and adds
three failure modes that are silent when they break. The poll's failure mode
is one log line and a stale-by-five-seconds answer.

**The poll fails OPEN.** A rejection from the query leaves every judge
connected. This is the deliberate inverse of `verifyJudgeCredential`'s
fail-closed `catch`, because the two failures are not the same failure: that
one would admit an unauthenticated judge, this one would disconnect
authenticated ones — turning a transient database blip into a fleet-wide
grading outage on the day the database is already unhappy. A judge that
should have been dropped stays connected for one more poll instead, which is
the direction to be wrong in.

Three details that are each a way this could have been wrong instead:

- **Nothing connected, nothing asked.** An idle bridge runs no query.
- **Never two polls at once**, so a slow query cannot stack one connection
  per tick against a database already struggling.
- **The connection is re-read from the map before it is closed.** A judge that
  redialled while the query was in flight sits under the same id on a *new*
  connection, which the reply says nothing about; closing that one would
  disconnect a live judge on a stale answer.

Dropping goes through `retire`, not a bare delete, so whoever was grading on
that socket hears about it exactly as they do for a judge that died — and
removal from `connections` is what "never dispatched to again" means, since
every dispatch path (`connectionIds`, `sendTo`, `supportedLanguages`) reads
that one map. A revoked judge redialling is already refused by the handshake.

*Ruled by the implementer during the 2026-08-30 B-13 leftovers loop, no human
available to consult. No migration.*


## D82 — Every cookie-authenticated state change must name an allowed origin

B10 cleared CSRF and wrote the clearance down as **single-layer**:
`SameSite=Lax` withholds the session cookie from every cross-site unsafe
method, every state change here is an unsafe method, and so Lax's
top-level-GET allowance grants an attacker nothing. That argument is correct
and it rests entirely on one browser feature behaving as documented — no
token, no second check, nothing that fails independently of it. D70 made
exactly this argument for the WebSocket upgrade and added an Origin check
anyway; this is the same check for the other half of the surface.

`CsrfOriginGuard`, one global guard, one rule: **a state-changing request
that carries a session cookie must say where it came from, and where it came
from must be ours.**

- **The allow-list is `wsAllowedOrigins`** — `PUBLIC_ORIGIN` plus
  `WS_EXTRA_ORIGINS`, D70's list, unchanged and not duplicated. A deploy that
  may open a socket from an origin but not write from it is a configuration
  nobody wants and everybody would eventually produce by editing one variable
  and not the other.
- **A negative method list**: `GET`, `HEAD` and `OPTIONS` are skipped and
  everything else is checked. The positive `POST`/`PATCH`/`DELETE` is what
  exists today, and a `PUT` added next month would be silently exempt from it.
  `OPTIONS` is skipped so a CORS preflight — which carries no cookie and asks
  permission for the request that follows — is never itself refused.
- **Cookie PRESENCE, not validity.** The question is not "is this caller
  signed in" but "could the browser have attached ambient credentials", and a
  cookie the server will reject was still attached by the browser.
- **Neither header, with a cookie, is a refusal.** This is the deliberate
  opposite of D70's WebSocket ruling, which ALLOWS a missing `Origin` because
  the clients that send none — `oj`, the judge agent — "carry no ambient
  cookie". Here the cookie is the premise. `Origin: null`, which a sandboxed
  iframe sends, fails list membership like any other stranger.
- **`Referer` is a fallback, reduced to its origin first.** A `Referer`
  carries a path, and a path is not a trust boundary: a check that matched the
  whole header, or a prefix of it, would admit
  `https://evil.example/http://localhost:5173`.
- **Bearer requests are not checked**, even with a cookie riding along:
  `AuthGuard.attachActor` authenticates by the token and never reads the
  cookie, and no page can set an `Authorization` header without a preflight
  this API answers only for its own origin. Every machine client has no origin
  to send and must not be refused for it.
- **Registered FIRST, ahead of `AuthGuard`.** It reads no actor, so it needs
  nothing `AuthGuard` produces, and running it first is what makes a
  cross-site request refused as what it is — `403 csrf_origin` — rather than
  reaching `AuthGuard`, resolving the victim's perfectly valid cookie, and
  being judged on the merits of a request they never made. A test pins that
  precedence against a stale cookie: 403, never 401.

**Nothing is registered per-route in `packages/contracts`.** This 403 is
cross-cutting exactly as 401 is — it can happen to any unsafe route and is
about the caller's browser rather than the endpoint — and adding it to every
`registerPath` would be churn across a dozen files for a response no correct
client can provoke.

**What it costs, and who pays it.** Node's `fetch` sends no `Origin`, so the
three `scripts/e2e-*.ts` — which drive the live stack through a session
cookie — now send one naming `E2E_BASE_URL`'s origin, which must therefore be
`PUBLIC_ORIGIN` or one of `WS_EXTRA_ORIGINS` (on the live host it is
`http://localhost:8080`, already listed). `supertest` sends none either, so
`app.harness.ts` stamps `Origin` on a request that named neither header —
making the browser simulation faithful rather than turning the guard off. The
suite's four-hundred-odd cookie-authenticated writes therefore exercise the
ADMIT path on every run, and `csrf-origin.spec.ts` — the one file that opts
out of the stamp — owns the refuse path.

*Ruled by the implementer during the 2026-08-30 B-13 leftovers loop, no human
available to consult. No migration.*

## D83 — Progress is what has already been decided: a run nobody is running is failed, and a live room counts for nothing until it closes

Two things F16 shipped, and one rule joins them: this judge only reports what
is **finished**. A similarity run whose process died is finished (badly), and
a contest still being sat has decided nothing yet.

### The reaper (F15's first concern)

`ContestSimilarityService.start` commits a `running` row before the work
begins, so a deploy or an OOM kill between the two left that contest's button
answering `409 similarity_running` for the life of the installation.
`SimilarityRunReaper` sweeps every five minutes on `ExpiredRowsSweeper`'s
shape — an `unref`'d interval, no sweep at boot, every failure a log line.

- **Two staleness predicates, both gated on the contest's advisory lock.** A
  `running` row older than fifteen minutes, or one whose `started_at`
  predates this process's boot, is a *candidate*; it is only marked when
  `pg_try_advisory_xact_lock(SIMILARITY_LOCK, contest_id)` succeeds. `execute`
  holds that lock for its whole transaction, so the lock — not the clock — is
  what tells "nobody is running this" from "this contest is large". Fifteen
  minutes alone would cancel a slow report; the lock alone would never fire
  on a row whose contest is idle. The lock is also what makes the
  process-start branch safe on a forked cluster (`API_WORKERS`), where a
  sibling worker may legitimately be running a row this worker never started.
- **`status = 'failed'`, `error = 'abandoned'`**, distinct from
  `similarity_run_failed`: the organiser learns that nothing is wrong with
  their contest and pressing the button again is the whole fix. No migration
  — `similarity_runs.status` is plain text by design.
- **The UPDATE restates `status = 'running'`.** A run that lands between the
  candidate query and the write must not have its finished report stamped
  over. (The service's own `.catch` can still write `similarity_run_failed`
  over an `abandoned` row afterwards: terminal over terminal, harmless,
  recorded rather than fixed.)

### What a progress page counts

`GET /users/me/progress` (session or `users:read`, mirroring `/users/me`;
there is no `profile:read` scope in this build) and `GET /users/{u}/progress`
(`@Public` + `users:read`, mirroring the profile it hangs off).

- **D49's window exclusion is the one rule for every outcome** — the bars and
  the streak — reused as `contestWindowOpenWhere`, never transcribed. Not
  D23's freeze mask, for two independent reasons: D23 never masks a submitter
  from themselves, so on your own page that predicate is constant `false` and
  "a frozen contest's late verdicts don't count until reveal" would not bind
  at all; and the answer is cached, so a viewer-dependent predicate would
  poison one cache entry for every other viewer (D49's own argument). It is
  **D35's mask for free**: a live room's problem contributes no tag and no
  difficulty to anybody's bars until that window closes. Accepted
  consequence: a pupil mid-contest does not see today's solves in their own
  bars — the calendar below is where that day shows up.
- **The heatmap and `recent` are deliberately NOT excluded.** A heatmap
  counts that a submission exists, which is exactly what D23 says a freeze
  never hides and what `UserStats.submissionCount` already publishes
  unfiltered; `recent` is the reader's own verdicts, which D23 never masks
  from their author.
- **Public counts public problems only; your own page counts every problem
  you submitted to.** The first is `UserStats`' §3/§4 rule unchanged — a
  number that moved with the reader would leak, by arithmetic, that a private
  problem exists. The second is the province's actual student, whose week is
  mostly school-visible homework; it is their own work, and the public route
  serves a *narrower object* rather than the same one masked, so nothing
  leaks by forgetting a field.
- **The public route serves the bars and the heatmap and nothing else.** No
  streak, no recent verdicts, no contests, no homework: a rival's calendar is
  already implied by `GET /submissions`, but where they go to school and what
  they owe on Friday is not (D8/D23/D66).
- **A day is a day where the SUBJECT was standing** — `users.timezone`,
  `NULL` → `Asia/Ho_Chi_Minh` (D57's mail precedent: a server has no
  `navigator.language`) — bucketed in SQL with `at time zone`, and the zone
  travels on the answer so no client re-buckets it. Bucketing in the browser
  would make a teacher in Hanoi and one abroad disagree about which day a
  pupil worked.
- **A streak is consecutive days with a counted `AC`, alive if the last one
  is today or yesterday**, over the heatmap's twelve months. Dying at
  midnight would zero every reader before their first submission of the day.
- **Homework completion is the pupil's own view, not the teacher's grid**:
  every `AC` counts, on time or late, with no window exclusion — D66 exempts
  the pupil's own page explicitly, and its "a late solve is shown beside the
  on-time one rather than instead of it" is the same instinct. The deadline
  is printed beside the count so nobody reads it as a mark. Sets come only
  from schools the reader belongs to, D66's membership gate.
- **Sixty seconds in Redis, one key per user per shape**
  (`duckoj:progress:v1:me:<id>`, `…:user:<id>`), through `ScoreboardCache`'s
  read-through — generic since D48. Both objects are viewer-independent by
  construction, which is what makes a per-user key correct rather than a
  cache with a mask baked into it. **No migration**: every aggregate here is
  led by `submissions.user_id`, which `submissions_user_problem_points_idx`
  already covers.

*Ruled by the implementer during the 2026-08-30 feature/bug loop (F16 brief),
no human available to consult. No migration.*

## D84 — The submit box is a real editor: CodeMirror 6, a per-(problem, language) draft, and a starter that only ever fills an empty buffer

The one screen this whole judge exists for handed a pupil a bare
`<textarea>`: no line numbers, no highlighting, Tab moved focus out of it,
and a reload threw the work away. On the shared school machines D76 was
written for, "the page reloaded" is not a rare event.

- **CodeMirror 6, composed by hand, not `basicSetup` and not a React
  wrapper.** `@codemirror/{state,view,language,commands}` plus the three
  grammars this judge could plausibly run (`lang-cpp`, `lang-python`,
  `lang-java`). `basicSetup` adds autocompletion, search, folding and lint —
  four panels nobody opens in a submit box — and an `@uiw`-style wrapper adds
  a second lifecycle on top of the one `EditorView` already has. The six
  extensions in `src/editor/code-editor.tsx` are the entire feature set.
- **It is code-split.** The editor and its grammars are 505 kB (171 kB
  gzipped) and are reached through `React.lazy` from `src/editor/lazy.tsx`,
  the only module allowed to import `./code-editor.js`. Nobody reading a
  statement, a scoreboard or a submission list downloads it; the entry chunk
  grew 5.7 kB (1.6 kB gzipped) for the form logic that stayed behind.
- **`Prec.highest` on Ctrl/Cmd+Enter is load-bearing.** `defaultKeymap`
  already binds `Mod-Enter` to `insertBlankLine`, so the shortcut a pupil is
  told to press would otherwise insert a line. Verified by moving the binding
  after `defaultKeymap` and watching the test go red.
- **Language keys map to grammars by PREFIX, not by a table.** `cpp17` is
  still the only seeded language, but `cpp20`/`py311`/`java21` highlight on
  the day they are added with no web deploy. `c*` is C++ (Lezer's C++ parser
  reads C, and a C program highlighted as C++ is right about every token it
  contains) with `cs*` explicitly carved out, and anything unrecognised is
  plain text rather than a wrong grammar.
- **Drafts are keyed `(problem, language)`, saved 500 ms after the last
  keystroke, restored on return, and cleared only on an ACCEPTED submit.**
  `SubmitForm.onSubmit` now answers `boolean` for exactly that reason: a
  submission the API refused — a closed window, a dead network — must not
  also cost the pupil their code. `clear()` cancels the pending debounce as
  well as removing the key; without that, the timer resurrects the draft the
  submit just cleared. Every `localStorage` access is wrapped, as
  `i18n/index.tsx`'s is.
- **A starter template is inserted only into an EMPTY buffer, and a draft
  always outranks it.** The rule that resolves the brief's tension between
  "templates for each language" and "a language switch keeps the content":
  switching language keeps whatever is there; only if the editor is empty
  does it take on that language's draft, or failing that its template. The
  templates are the boilerplate that decides verdicts — the two fast-IO lines
  in C++, `sys.stdin` in Python, and the class name `Main`, which the Java
  driver requires rather than prefers.
- **A write the PAGE made is annotated, so it is not mistaken for typing.**
  A restored draft, a starter template and an uploaded file all reach the
  buffer through `props.value`, and CodeMirror's update listener cannot tell
  them from a keystroke — so a template inserted on a language switch was
  filed as a draft 500 ms later, and the next visit greeted the pupil with
  "Khôi phục bản nháp" over code they never wrote. Every catch-up transaction
  now carries an `External` annotation the listener skips. Drafts are the
  pupil's own work, and this is what makes that true.
- **The size counter reads its ceiling off the contract**
  (`CreateSubmissionRequest.shape.source.maxLength`), and counts UTF-16 code
  units exactly as Zod's `.max()` does. A byte count would disagree with the
  server the moment a pupil writes a Vietnamese comment. Past the limit the
  submit button is disabled and an `alert` says why, instead of a 422.
- **Colour is a third semantic scale in `app.css` (`--syn-*`), painted onto
  `@lezer/highlight`'s `tok-*` classes.** It earns its place the way D46's
  rank ramp did, and it deliberately shares nothing with the verdict hues: a
  `wa` red on the word `return` would teach the reader that red means wrong
  here too. The MATERIAL — the inset well, the hairline, the mono face —
  comes from `tokens.css` through `EditorView.theme`, so dark mode and D67's
  solid twins arrive for free. Height is a stylesheet decision, not a prop:
  22rem on a desktop, 40vh at D76's 700px breakpoint, where a soft keyboard
  is already taking half the screen; a font-size stepper sits above it.
- **No hidden `<textarea>` fallback.** The contenteditable carries
  `aria-label` and the old `id="source"`, the visible `<label>` stays, and
  every test that typed into the textarea now drives the `EditorView`
  directly (`e2e/journey.spec.ts` fills `.cm-content`). A second, silently
  diverging copy of the buffer would be a correctness hazard, not an
  accessibility win.

*Ruled by the implementer during the 2026-08-30 feature loop (F17 brief), no
human available to consult. No migration, no API change.*


## D85 — A build whose every worker dies inside a minute makes the primary exit non-zero

The 2026-08-30 outage lasted fifteen minutes, and roughly fourteen of them
were spent not knowing. A provider Nest could not resolve killed every api
worker milliseconds after boot; `runPrimary` re-forked them on a doubling
backoff, forever. Because the primary is what binds port 3000, everything
above it saw a healthy system: `podman ps` said `Up`, the container's
`restart: unless-stopped` had nothing to restart, and the compose healthcheck
opened a connection that the primary accepted and no worker ever answered —
so it did not fail fast, it hung until its own 5 s timeout, six times.

- **The rule.** If the primary reaches **zero live workers within 60 s of its
  own start** (`CRASH_LOOP_WINDOW_MS`), it logs one line saying this build
  cannot boot and calls `process.exit(1)` instead of scheduling another fork.
- **Zero live workers**, not "a worker died": one crashed worker out of four
  is what a supervisor exists for, and re-forking it stays exactly as it was.
- **Measured from primary start**, not from the last death. A process that
  served for a day and then loses its whole fleet at once is a different
  incident — an OOM sweep, a host hiccup — and re-forking is the right answer
  to that. This rule is only about a build that never booted.
- **60 s** is long enough that a slow first boot cannot be mistaken for it: a
  worker waiting on a cold Postgres is alive while it waits. It is short
  enough that `scripts/deploy.sh`'s 45 s poll and the restart policy both see
  a real exit code rather than a hang.
- **A shutdown is exempt.** SIGTERM sets `shuttingDown` first, so a recreate —
  which is also every worker dying inside the window — is never reported as a
  failed boot.
- **Cost, stated.** A genuine boot failure now takes the container down in a
  restart loop rather than leaving it up and mute. That is the point: a loop
  of visible failures is diagnosable and an up-but-empty container is not.

`runPrimary` gained seams (`cluster`, `now`, `exit`, `schedule`, `onSignal`)
so `apps/api/test/cluster.spec.ts` can drive a fake stream of worker exits
against a fake clock; forking four real processes that die on purpose would
mean waiting out `MAX_BACKOFF_MS` for a flaky test of exactly the timing it
exists to pin.

*Ruled by the implementer during the 2026-08-30 deploy-safety loop (B-15
brief), no human available to consult. No migration, no API change.*

**Amended 2026-08-31 (B-19, D103):** "zero live workers" is not enough on its
own. At `API_WORKERS=1` it is the same event as "a worker died", so one
transient crash rolled a healthy build back. The breaker now also requires two
exits inside the window from workers that never reached `STABLE_UPTIME_MS`.
See D103.

## D86 — The api healthcheck must be ANSWERED by a worker, and must count them

`node:cluster` has the **primary** bind port 3000 and hand accepted
connections to workers. So "the port accepts" and "the application answers"
are different facts, and on 2026-08-30 they came apart for fifteen minutes:
every worker dead, the primary holding the socket, `podman ps` reporting `Up`.

The probe in place could not tell:

    fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1))

Its connection was accepted by the primary and never answered, so the fetch
never settled — no timeout, no `.catch`. It did not fail; it hung until
compose killed it at the service's own 5 s `timeout`, six times, a probe with
no verdict of its own. Measured: against a socket that accepts and says
nothing, this command still had not exited after 30 s.

- **`/healthz` now answers `{ status: 'ok', workers: n }`.** The body is the
  point: only a process that can run a route produces one, so an accepted
  connection with nobody behind it cannot fake it.
- **`n` is the primary's own count of live workers**, pushed over the cluster
  IPC channel on every fork and every death
  (`apps/api/src/worker-count.ts`). It is the one fact only the supervisor
  knows, and the healthcheck reads it rather than inferring it.
- **A worker that has not yet heard reports 1, never 0.** It is itself alive,
  and `API_WORKERS=1` never forks a primary at all. The number is a floor,
  never an overstatement.
- **The compose probe parses the body, requires `workers >= 1`, and carries
  `AbortSignal.timeout(4000)` plus a `.catch`.** All three are load-bearing:
  the parse defeats an accepting-but-silent port and a misrouted 200 (an SPA
  fallback, a proxy error page); the count fails closed against an image too
  old to send the field; the timeout makes a hang a FAILED probe at 4 s
  instead of one killed mid-question at 5 s.
- **`readyz` is unchanged** and still owns dependency health. Liveness must
  stay answerable while Postgres is down.

`apps/api/test/healthcheck-probe.spec.ts` extracts the command from
`docker-compose.yml` and runs it with the same `node -e`, against the real
`HealthController` and against each failure above — a restated copy of the
probe would drift from the compose file, which is exactly how the old one
survived looking right.

*Ruled by the implementer during the 2026-08-30 deploy-safety loop (B-15
brief), no human available to consult. No migration; `/healthz` is not in the
OpenAPI registry, so no contract regeneration.*

## D87 — A problem's test data is authored in the browser, one file at a time, and built into a package on the server

Every path to a graded problem ran through a shell: `polygon:import`,
`package:build`, `curl` an archive at `POST /packages`, `curl` a revision.
A provincial setter who has never opened a terminal could write a statement
in the web app and then could not give it a single test. This closes that,
without reopening the door the 7a ruling (2026-08-22) shut.

- **No zips, in either direction.** 7a refused server-side archive ingestion
  — zip-slip and zip-bomb surface nothing needs — and a file picker is not a
  loophole in it. A bulk add is MANY INDIVIDUAL FILES, paired by stem in the
  browser (`apps/web/src/testdata/pairing.ts`); the only archive in the story
  is the tar+zstd the server builds at the end, from files it wrote itself.
- **A draft is a directory, and the build is the same `buildPackage`.**
  `POST /problems/{code}/drafts` opens one, `PUT .../files/{name}` fills it,
  `POST .../build` runs the function `package:build` runs, over that
  directory. `buildPackage` moved out of `scripts/lib` into
  `@duckoj/package-format` for exactly this — `apps/api` cannot import from
  `scripts/`, and a second implementation of "what does this directory hash
  to" is how a seed registers one hash while the CLI prints another. The
  built package then goes through `PackagesService.upload`, which re-unpacks
  and re-derives the hash rather than trusting the one just computed in the
  same process: there is ONE place a package becomes storable, carrying the
  collision rule, D60's completeness rule and the idempotent insert.
- **Names are flat and narrow: `^[A-Za-z0-9._-]+$`, with `.` and `..`
  refused by name.** The class ADMITS both of those (`.` and `-` are members),
  and they are the whole traversal vocabulary on a POSIX filesystem — the
  pattern alone is not the rule. Neither is reachable over HTTP anyway (every
  client resolves a dot segment away before writing the request), which is
  precisely why the guard cannot rest on that: this endpoint is reachable by
  anything that speaks HTTP. `FilesystemDraftStore` re-checks the name itself
  rather than trusting the pipe that already did.
- **There is no drafts TABLE.** A draft is bytes on the volume every
  `API_WORKERS` process shares, by necessity; a row beside them would be a
  second source of truth for one object, with a window where one exists and
  the other does not. `meta.json` lives OUTSIDE the `files/` subtree — inside
  it, `buildPackage` would tar the author's user id into the problem's
  package and change its hash.
- **Expiry is enforced at ACCESS time; the sweeper only reclaims disk.** 24
  hours, read off `meta.createdAt` on every request, so a dead draft is
  unreachable the instant it dies rather than at the next hourly tick — a
  rule only the sweeper applied would keep accepting files into it for an
  hour. An unreadable or unparseable meta counts as expired: nothing can ever
  open it again, and treating "unreadable" as "fresh" would make a corrupt
  directory immortal.
- **Caps: 500 files and 512 MiB per draft, plus the existing 256 MiB wire cap
  per request** (`readRawBody`, now shared with `POST /packages` rather than
  copied), and D53's 1 GiB unpacked ceiling still applies to the package the
  build produces. A re-PUT is measured as a REPLACEMENT: a setter fixing one
  wrong answer file must not be told the draft is full because the version
  being replaced is still counted.
- **A refused build leaves the draft intact and carries `buildPackage`'s own
  message verbatim** (422 `draft_build_failed`). "The manifest names files
  this package does not contain: 02.out" is the sentence that makes the next
  act obvious; flattening it to "invalid package" would cost the whole
  feature its usability. A successful build deletes the draft *after* the
  attach, never before. The web client discards its own draft on any failure
  regardless — it holds every byte in memory and will simply send them again.
- **A sample is `points: 0` in group 0.** The manifest has no `sample` field
  and is not gaining one: a zero-point case runs exactly as any other and
  awards nothing, which IS what a sample is, and Polygon's own `samples`
  group already arrives here as 0 points (`content/README.md`). The web's
  sample checkbox therefore DISABLES the points box rather than ignoring it.
- **`problems:publish`, not `packages:write`.** A draft exists to become a
  revision, so it carries its neighbour `POST /problems/{code}/revisions`'s
  scope; a token allowed to edit a statement but not to touch what grades
  submissions must not get there through this door. Authorization is
  `PATCH /problems/{code}`'s, through a new public
  `ProblemAccessService.loadEditableProblem` rather than a second hand-rolled
  copy — 404 for a problem the caller may not see, then 403. A draft's
  `problemId` is checked against the URL's problem as well: without it, an
  editor of A holding a draft id minted against B could fill B's draft and
  build it into A.

*Ruled by the implementer during the 2026-08-30 feature loop (F18 brief), no
human available to consult. No migration — the filesystem is the whole
record.*


## D88 — Reuse copies the WORK, never the history: an authoring round trip, a problem clone, a contest clone

D87 gave a provincial setter a browser to write test data in and no way to
read any back, so their second problem — and next year's contest — started
from an empty form. Three copies close that, and they share one rule:
**what is copied is the artefact; what is not is everything that happened to
it.**

- **`POST /problems/{code}/drafts/from-revision/{version}`** unpacks a
  revision's package and fills a fresh draft with it. Two losses are
  deliberate. **Names are flattened**: a package says `tests/01.in`, a draft
  is flat (D87), so every file is copied under the canonical name the
  authoring tab itself generates — `draftCaseStem`,
  `DRAFT_CHECKER_FILE_NAME`, both moved into `@duckoj/contracts` so the two
  sides cannot drift. Keeping the original paths would make every re-PUT
  from the browser land *beside* the old file instead of replacing it, and
  `buildPackage` tars whatever it finds. The cost is that even a no-edit
  round trip produces a NEW hash. **Only what the manifest names is
  copied**: a generator, a validator or a statement riding in a Polygon
  package is left behind, because a draft is the test data a problem grades
  against, not an archive of how it was made, and this endpoint's caller can
  edit only the former. A sample is inferred as `points === 0 && group === 0`
  — the exact mirror of what the tab writes — so a deliberately zero-point
  ungrouped case comes back marked as a sample; it grades identically either
  way. The caps are D87's, checked before the draft is created.
- **`GET /problems/{code}/drafts/{draftId}/files/{name}`** answers raw bytes
  under the PUT's authorization: a draft's files are a private problem's
  test data. The browser uses it to fill the table, then **discards the
  draft** and builds through a fresh one — everything on that screen lives
  in memory until the build, so keeping the read draft would leave a second,
  diverging copy on the server for 24 hours. An API client, which does not
  hold the bytes, may instead PUT one corrected file into the pre-filled
  draft and build it in place. A file over the browser's 1 MiB ceiling is
  refused by name with nothing loaded, so a CLI-built set with huge tests
  cannot be round-tripped through a textarea — stated, not fixed.
- **`POST /problems/{code}/clone`** copies the statement, the editorial, the
  tags, the difficulty and the current published revision's package as
  revision 1 (a `draft`, pointing at the same content-addressed bytes — no
  re-upload, no re-verification). Not copied: submissions, statistics,
  members, organization shares, `sourceAccess`, and every publication
  decision — the copy is private and its editorial unpublished whatever the
  source's was. **Two permissions.** The caller must be able to EDIT the
  source, because a clone hands them its unpublished editorial and its whole
  test set and a reader of a public problem may see neither; and they must
  be able to create problems, so a demoted setter keeps no side door.
  `problems:publish`, not `problems:write`, for the same reason.
- **`POST /contests/{key}/clone`** copies the format and its config, the
  points precision, the freeze, the time limit, the problems with their
  labels, points, partial flags and order, and the organizations that may
  enter (D56). Not copied: participations, submissions, clarifications,
  similarity runs, `isRated`, and the visibility — the copy is private, so a
  contest nobody has scheduled does not appear on the public list the
  instant it exists. Guards mirror `update`: `canRunContest` → **404** (not
  403, exactly as `PATCH /contests/{key}` answers a caller who can see the
  contest), then `canCreateContest` → 403. D38 does not apply — the clone
  has not started — but the NEW window is validated as an edit would be, so
  a freeze the source stores that no longer fits is `contest_freeze_too_long`
  rather than an unreadable scoreboard later. Problems and organizations are
  copied **by id**, never re-resolved: the codes are already on the source's
  page in front of this organiser, and a problem whose visibility narrowed
  since it was attached would otherwise make last year's round uncopyable —
  the same exemption `resolveOrgIds` already grants an already-attached
  organization. `order` is renumbered from the read order, because a
  format uses the sequence and an edited list can have gaps.
- Both clones answer **409** on a taken code/key, from the unique violation
  their `create` neighbour already turns into one, never a pre-check.
- The web offers each as a link rather than a redirect where there is
  unsaved work to lose: "Nhân bản" on the problem edit screen links to the
  copy, and "Nhân bản kỳ thi" on a contest page goes to `/contests/new
  ?cloneFrom=` — which asks for the four things a copy cannot inherit (key,
  name, start, end) and shows the rest read-only. That screen cannot express
  `pointsPrecision`, `timeLimitSeconds`, `formatConfig` or a problem's
  LABEL, so a "prefilled create form" would silently drop all four on every
  clone; the server copies them instead.

*Ruled by the implementer during the 2026-08-30 feature loop (F19 brief), no
human available to consult. No migration — every copy is rows and files in
tables that already exist.*

## D89 — The MCP server is read-only until told otherwise, and admin is not a switch away

`apps/mcp` puts DuckOJ behind the Model Context Protocol: an agent gets
nineteen tools, four resources and two prompts over stdio, authenticated by
one personal access token. The question that needed a ruling is not which
routes to expose — it is what an agent may do with them while nobody is
looking.

- **Read tools are on; write tools are OFF unless `DUCKOJ_MCP_WRITES=1`.**
  Not a per-call confirmation, not a scope check at call time: the write
  tools are NEVER REGISTERED, so they do not appear in `tools/list` and an
  agent cannot call something it was never told about. A tool an agent can
  see is a tool it will spend a turn trying, and "the server refused" is a
  worse answer than "there is no such tool" because it reads as a transient
  failure worth retrying. The switch is `=== '1'` exactly — `true`, `yes` and
  a stray space are all off, because every value that is not the documented
  one is a typo, and a typo must fail closed.
- **"Write" means the route changes server state, which is exactly the set
  whose scope ends `:write` or `:publish`.** So `submissions_submit` is
  behind the switch alongside the authoring tools. It enqueues a grading
  container, it is the one route in the API with its own meter (D80), and a
  contest submission is a scored, irreversible act attributed to the token's
  owner. The gate is not about danger to data; it is about an agent acting on
  somebody's behalf in a session they are not watching.
- **Admin tools are absent, not withheld.** There is no `DUCKOJ_MCP_ADMIN`.
  Every `/admin` route is `@SessionOnly` and this server authenticates with a
  bearer token, which `SessionOnlyGuard` refuses (D50) — an admin tool could
  only ever return 403, so registering one would advertise a capability that
  does not exist. A future admin surface would need a session, which is a
  different credential model and a different ruling.
- **Every tool declares its scope, in its own description.** The scope is a
  field on the tool table (typed as `Scope` from `packages/contracts`, so a
  typo does not compile) and `defineTool` appends "Requires the `x:y` token
  scope" to the prose. A 403 from a token minted without `submissions:write`
  is otherwise indistinguishable from a permissions problem on the judge, and
  the fix — mint a wider token — is not something an agent can guess.
- **Tool names are underscored (`problems_search`), never dotted.** A host
  does not expose a server's tool name unchanged: Claude Code composes
  `mcp__<server>__<tool>`, and the Anthropic API's own tool-name rule is
  `^[a-zA-Z0-9_-]{1,128}$`. A dot makes the composed name invalid and the
  failure lands on the host, at request time, naming a tool nobody typed.
  `TOOL_NAME_PATTERN` refuses one at construction instead.
- **One line of prose, then compact JSON, in one text block.** A host renders
  the first line in its transcript and the model reads all of it: a
  summary-only result is unusable by the model, a JSON-only result is
  unreadable by the person watching. The JSON is a PROJECTION of the API
  response, not the response — an agent choosing a problem needs the code,
  the name, the difficulty and the tags, and handing it `hasPublishedRevision`
  and `orgSlugs` on every row buries those four.
- **A refusal carries `code`, `detail` and — for D80 — `retryAfterSeconds`.**
  The `Retry-After` header becomes a number in the JSON, for the reason `oj`
  learned it: "submission refused" with no wait tells something driving the
  API in a loop nothing about how to stop being refused, and an agent loops
  harder than a person does.
- **`submissions_watch` answers `timedOut: true` rather than failing.** `oj
  watch` polls 150 times and only then complains; an MCP host cancels a tool
  call that outlives its patience, and a cancelled call teaches the agent
  neither the verdict nor that it should ask again. So the deadline is an
  argument, the timeout is a normal result, and the summary says to call
  again. A 401/403/404 is still immediate: retrying a refused credential five
  times only delays the message.
- **Samples are parsed out of the statement, and say so.** The API models no
  `samples` field anywhere — the examples live in a Markdown table in the
  prose. An agent needs them as data, so `problems_get` returns
  `samples: { source, items }`, where `source: 'none'` means "read the
  statement yourself", NOT "this problem has no samples". The extractor knows
  exactly the table every DuckOJ statement uses and returns nothing for
  anything else: a wrong sample sends an agent hunting a bug in a correct
  program, which is worse than no sample at all.
- **The credential is `oj`'s.** `DUCKOJ_URL`/`DUCKOJ_TOKEN` win, otherwise
  `~/.config/duckoj/config.json` is read, so somebody who has run `oj login`
  manages no second copy of their token — and `oj mcp` launches the server
  with it directly. `apps/mcp` duplicates that ~25-line reader rather than
  importing it, because `oj mcp` makes `@duckoj/oj` depend on `@duckoj/mcp`
  and importing back would close the cycle. A base URL that names only an
  origin gains `/api/v1`: pointed at the origin, the SDK asks Caddy for
  `/problems`, which falls through to the SPA and answers `200 text/html` —
  a success that is not an error anywhere and a parse failure five frames
  away.

*Ruled by the implementer during the 2026-08-30 feature loop (F20 brief), no
human available to consult. No migration — the server holds no state.*

## D90 — `prepare` publishes through `POST /packages` + `/revisions`, and one directory has one hash

`packages/prepare` (`corepack pnpm prepare:problem <problem-dir>`) is the gate a
prepared problem passes before it reaches a stack, and the publisher that puts
it there. Two doors existed into a live problem and it takes exactly one.

- **The packages path, not D87's drafts, even though drafts need fewer
  privileges.** Drafts carry one scope (`problems:publish`); this carries two
  (`+ packages:write`). That is the only respect in which drafts are cheaper,
  and it loses to representability. `DraftFileName` is flat by contract —
  `^[A-Za-z0-9._-]+$`, no separator, "so the package a draft builds names its
  tests `01.in`, not `tests/01.in`" — and **every** Polygon import plans
  `tests/NN.in` and, when it has a checker, `checker/check.cpp`. Publishing
  through a draft would mean flattening every path, which changes the archive,
  which changes the hash. One directory would then register a different hash
  through `prepare` than `polygon:import` + `package:build` print for it —
  precisely the two-hashes-for-one-directory drift D87 moved `buildPackage`
  into `@duckoj/package-format` to prevent. It would also break the
  idempotency below, which IS a hash comparison, and drafts always attach a
  new revision.
- **Re-running is idempotent by hash.** The revision list is read first and a
  revision already carrying this package attaches nothing new; the statement,
  tags and difficulty are patched every run, because those are the things a
  setter edits between runs. A package that has not changed must not spend a
  version number.
- **The manifest and the copy plan for a Polygon directory come from
  `planImport` itself**, never from a second reading of `problem.xml`. What
  `prepare` reads out of the XML on its own is only what `planImport` does not
  return and the package does not contain: group NAMES and the `<solutions>`
  list.
- **The blocker in `flags.json` is exactly one thing**: an unresolved HIGH
  `statement-ambiguity`, which is the one hard stop `reviewing-problems` names
  for itself. Everything else in that register is flag-and-continue by
  construction, and a gate that failed on a `timing-band` note would make the
  whole register unusable. `flags.py` writes no resolution field, so a
  resolved ambiguity is `"resolved": true` added to the record by hand.
- **A statement is Markdown or it is not a statement.** The skills produce
  vnolymp `.tex`, which `problems.statement` cannot store, so a `.tex`-only
  directory is refused with the two file names that would fix it
  (`statement.md` with an `## English` section, or `statement.vi.md` +
  `statement.en.md`). D10 wants both locales and the column is still one
  column; the gate enforces the pair inside it.
- **The stock testlib checkers `wcmp` and `ncmp` ARE `{"kind":"standard"}`;
  every other stock checker is vendored into the package as a testlib source
  checker (D40).** `rcmp6`'s tolerance, `yesno`'s case-insensitivity and
  `lcmp`'s line semantics are not token equality, and a package that claimed
  they were would grade differently from the problem that was set.
- **Subtask points are split across a subtask's tests so the batch sums to
  exactly what was declared**, because `renderInitYml` gives a batch
  `points = sum(member points)` — rounding it away would silently change the
  ladder. Subtask `depends_on` is refused outright, the same refusal
  `@duckoj/polygon-import` makes for Polygon's `<dependencies>`, and so is
  file IO, which a DuckOJ package cannot express at all.
- **The gate is `timeout` + `ulimit -v`, and says so.** It is not the sandbox:
  it runs the setter's own code on the setter's own machine to answer a
  question before anything is uploaded. TLE is wall-clock at 2× the limit. An
  address-space kill is indistinguishable from any other crash from outside,
  so a declared `ML` is satisfied by an observed `RE` — reported, not hidden.
- **A stress generator is `<gen> <seed>` writing ONE case to stdout.** The
  `gen.py` files under `content/problems/` regenerate a whole `tests/`
  directory and do not satisfy this; the contract is stated rather than
  assumed, and the two solutions are compared through the problem's own
  checker so a problem with several correct answers is not reported broken.
- **`prepare` is also an npm lifecycle script name.** `pnpm install` runs the
  root `prepare` script every time, so `scripts/prepare.ts` exits 0 in silence
  on zero arguments, and checks that BEFORE importing anything from
  `@duckoj/*` — at install time `packages/prepare/dist` does not exist yet, and
  a static import would make a fresh install crash. `--help` prints the usage
  the lifecycle invocation deliberately does not.
- **Library first, CLI second.** Nothing under `packages/prepare/src` prints or
  exits; `cli.ts` is the only file that does either, so `apps/mcp` can expose
  the same pipeline as tools without shelling out and parsing stdout.

*Ruled by the implementer during the 2026-08-30 feature loop (F21 brief), no
human available to consult. No migration.*




## D91 — The test harness serves the application the container serves

B-15's audit recorded it and did not fix it: `apps/api/test/app.harness.ts`'s
`buildApp` applied `cookieParser` and a `ProblemFilter` **by hand** and nothing
else, and `TEST_CONFIG` was a hand-written `AppConfig` object literal. So the
~900 API specs ran against an app that shared two lines with the one `main.ts`
boots — **no `/api/v1` prefix, no CORS, no body limits, no keep-alive tuning**
— and `loadConfig` had exactly one caller in the whole suite.

- **`buildApp` (and `buildAppWithRealtime`) now call `configureApp`**, the same
  function `main.ts` calls, with no subset and no copy. The `browserOrigin`
  stamp stays, installed first: it is a *browser simulation* supertest lacks,
  not application wiring.
- **Every spec path gained the prefix, mechanically** (867 call sites, 68
  files). The exceptions are deliberate and small: `/healthz` and `/readyz`
  (`configureApp` excludes them — they are infrastructure contracts, not API
  surface), `app.smoke.spec.ts`'s two *off*-the-prefix negative tests, and the
  seven specs that build a bare `Test.createTestingModule` app of their own to
  exercise one guard or one filter, which never had a prefix to begin with.
- **`TEST_CONFIG = loadConfig(TEST_ENV)`**, where `TEST_ENV` names the same
  variables `docker-compose.yml` sets. The old literal was demonstrably *not* a
  config `loadConfig` would produce — `port: 0` (`PORT` is `min(1)`) and
  `logLevel: 'silent'` (absent from the `LOG_LEVEL` enum) — and nothing could
  notice, because the two were never run against each other.
- **`LOG_LEVEL` now admits `silent`.** It is one of pino's own levels and the
  only one the enum omitted, so `LOG_LEVEL=silent` in a `.env` crashed the API
  at boot with `Invalid environment configuration`. Admitted so the harness can
  go through the parser at all, and so an operator who wants a quiet container
  gets one instead of a boot loop.
- **`test/harness-realism.spec.ts` is the guard**, asserting the prefix, the
  CORS exposed-header list, the 100 KB body limit's 413, `x-powered-by` off and
  the keep-alive pair — against an app from `buildApp`, deliberately not one
  the file wires itself, because what is under test is what the other 900
  specs are handed.

The cost is that a harness app now carries CORS and body limits that most
specs do not care about; that is the point. The benefit is that a route which
works in every spec and 404s behind Caddy is no longer a shape the suite
cannot see — the same class of gap the 2026-08-30 boot outage came out of.

*Ruled by the implementer during the 2026-08-30 bug-hunt loop (B-16 brief), no
human available to consult. No migration.*

## D92 — `GET /problems/{code}` says WHICH revision is live, not merely that one is

F-21's live probe reported `publishedVersion: null` for every problem on the
deployment and the loop ledger carried it forward as a bug. It was not a
mapping fault, a stale column or a cache: **the field did not exist**. `jq`
prints `null` for a key that is not in the object, so a missing field and a
null field are one string on the wire, and the projection that "found" the bug
was asking for something no contract had ever declared.

The gap it pointed at is real, though. `ProblemDetail` carried
`hasPublishedRevision: boolean` and nothing else about the live revision; the
number lived only behind `GET /problems/{code}/revisions`, which
`canViewRevisions` restricts to members and admins. A setter's own tooling —
`packages/prepare`'s idempotency check, the authoring tab's "open a draft from
revision N" (D88) — has to ask "which one is live" and had to be a problem
member to get an answer.

- **`publishedVersion: number | null` on the DETAIL, not the summary.** No list
  row renders it, so putting it on `ProblemSummary` would be payload on every
  page of every search to answer a question only the problem's own page asks.
- **`hasPublishedRevision` stays**, and is not re-derived from it: it is the
  boolean a list row does render, and collapsing the two would make every
  caller write `publishedVersion !== null` instead.
- **It nulls with the other four revision-derived fields.** `timeMs`,
  `memoryKb`, `testCount`, `totalPoints`, `checkerKind` and now
  `publishedVersion` all come from the same left join, whose `state =
  'published'` term is what makes them honest — a problem whose
  `currentRevisionId` were parked on an archived revision reads as one that has
  never shipped rather than reporting a stale version number as live. That
  state is unreachable through `publishRevision` today and is written by hand in
  `problem-reads.spec.ts`, which is the test the file's own `testCount` comment
  said no fixture could build.
- **Both detail builders**: `getVisible` and `loadDetailById` (which backs
  `POST /problems` and `PATCH /problems/{code}`) each carry it, so a create or
  a patch answers what the next `GET` will say.

Not a leak: a version number says how many times a setter re-published, which
is not a hint about the problem's content, so it is not on D35's mask.

*Ruled by the implementer during the 2026-08-30 bug-hunt loop (B-16 brief), no
human available to consult. No migration.*

## D93 — A draft's caps are read-modify-write, so a draft is locked while one is decided

D87 bounds a draft at 500 files and 512 MiB, and both are checked the same
way: `stats()` the directory, decide, then write. Two PUTs in flight against
one draft both measure the state BEFORE either wrote, so both are admitted —
the caps bound a one-file-at-a-time client and nothing else. Nothing noticed
because the authoring tab uploads one file at a time; the API is a public one,
four `API_WORKERS` share the volume, and a scripted bulk upload is exactly the
caller a cap on shared disk exists for. Measured: two concurrent PUTs at the
499-file boundary both answer 200 and leave 501 files.

- **The lock is a directory (`.lock`) beside `meta.json`**, taken with a bare
  `mkdir` — one syscall that both tests and takes it, with no window between
  the two — and it lives outside `files/` for the reason the `.tmp-…` file
  does: `buildPackage` tars everything it is given and `stats` counts
  everything it sees, so a lock inside `files/` would change the package's
  content-addressed hash. It is on the shared volume, so it holds ACROSS
  workers, which an in-process mutex would not.
- **A lock older than two minutes is taken over, not waited on.** The holder
  can die — a killed worker, a restart mid-PUT — with nothing left to release
  it, and a frozen-for-24-hours draft is the one state nothing recovers from
  on its own. Same reasoning `read()` applies to an unreadable `meta.json`.
  The age is the directory's own `mtime`, set by the `mkdir`, so there is no
  second write that could be missing when a waiter looks.
- **Authorization stays outside the lock.** `resolve` is a database read that
  can refuse, and a caller who may not touch this draft must not be able to
  make its owner's uploads queue behind them.
- **The build holds it only across `buildPackage`.** That step reads the
  directory listing and then the files in it, so a PUT landing between the two
  decides what the package contains — and therefore its hash — without the
  setter who asked for the build having any say. The upload, the attach and
  the publish that follow touch the database and the package store, not the
  draft, and holding a lock across them would let a slow write block the next
  upload.

- **The sweeper skips a held draft rather than waiting for it.** `sweep` is `rm -r` of the
  whole directory, lock and all, so a draft crossing its 24 hours while a build reads it was
  yanked out from under `buildPackage` — and the setter got the raw `ENOENT` quoted verbatim
  into a 422, for a build that had already passed the expiry check when it started. Skipped
  rather than waited on: the sweep runs hourly over every draft on the volume, and blocking
  each one for the lock's timeout would let a single held draft stall the whole pass. The
  next tick reclaims it, an hour is nothing against a 24-hour TTL, and a lock held past
  `DRAFT_LOCK_STALE_MS` is not held by anything alive. Expiry is unaffected: the draft stays
  unreachable through the API the instant it expires — the skip is about the disk.

**Two rulings recorded rather than changed.** A build whose package hash equals
the current revision's still attaches a NEW revision: `attachRevision` is a
version allocator, not a deduplicator, `submissions.revisionId` pins history
per revision rather than per hash, and a caller that wants idempotency compares
hashes against the revision list — which is what `packages/prepare` does (D90).
And a draft whose problem is deleted needs no rule: nothing in this API deletes
a problem.

*Ruled by the implementer during the 2026-08-30 bug-hunt loop (B-16 brief), no
human available to consult. No migration.*

## D94 — Samples are a field on the problem, read out of the package; a statement's table is hidden only when it is provably a duplicate

`GET /problems/{code}` modelled no samples at all. The input and the output
of every worked example lived inside `problems.statement`, as a Markdown
table, and every machine client scraped them back out of the prose — F20's
`apps/mcp` most visibly, with an extractor that knows one table shape and
answers `none` for anything else, honestly but silently. Meanwhile the files
the judge actually grades against were sitting in the published revision's
package, unread. `ProblemDetail.samples` is those files.

- **A sample is still DERIVED, never flagged — but the rule D87 wrote finds
  none of them.** D87 ruled "`points: 0` in group 0", which is exactly what
  the browser authoring tab writes and is NOT what the other authoring path
  produces: Polygon marks its samples explicitly and puts them in a *named*
  group (`points="0" group="samples"`, which is what every `problem.xml`
  under `content/problems` says), so `@duckoj/polygon-import` numbers that
  group 1 and every seeded problem's samples sit at `points: 0, group: 1`.
  The rule that covers both, and only those, is `isSampleTest`: **worth
  nothing, in a group that is worth nothing.** Group 0 means "ungrouped,
  every case stands alone", so a zero-point case there is a sample
  regardless of its neighbours; a real batch is a sample group only when the
  WHOLE batch scores nothing — load-bearing, because `distributePoints`
  splits ten points over twelve tests and hands two of them a 0, and
  publishing one of those would hand out jury test data. D87's ruling that
  the manifest gains no `sample` flag stands; this widens how the flagless
  manifest is READ, and `POST /drafts/from-revision` now reads it this way
  too (it was returning every imported problem's samples as graded cases).
- **`samples[].explanation` annotates a sample by its INPUT PATH.** Not an
  index into the derived list — inserting one test above a sample would
  silently move every explanation down one problem — and not a field on
  `TestCase`, so nothing about a test's scoring row changes. Optional, so
  every package built before this parses unchanged and `schemaVersion` does
  not move. `parseManifest` refuses an explanation on a non-sample and a
  path explained twice: prose that renders nowhere reads, to the setter who
  wrote it, as work silently thrown away.
- **The reader derives its file list from `tests` and JOINS annotations onto
  it, never the reverse.** Everything in a package that is not a sample is
  jury data, and a stored blob predates this schema's validation: a reader
  that opened whatever `samples[]` named would let a manifest nominate a
  jury answer, or a checker's source, as public.
- **12 samples, 8 KiB per file, `truncated: true` when a file was cut.** The
  count is derived, so nothing bounds it that a setter had to think about —
  a package that scores nothing anywhere would make every test a sample.
- **Cached under the PACKAGE HASH, with no invalidation call anywhere.** The
  brief asked for a key per problem+revision invalidated on publish; this is
  the same thing with the invalidation deleted, which is `bookletCacheKey`'s
  precedent (D48) and its reasoning: a revision has exactly one immutable
  package, so a publish does not invalidate the entry, it stops addressing
  it. There is no path on which a publish can forget, and a clone (D88)
  shares the entry rather than folding the same archive twice.
- **Every failure answers `[]`.** A lost blob, an unparseable manifest, a
  Redis outage: the samples sit on top of a statement that still carries its
  own table, and a problem page that 500s over them is strictly the worse
  outcome. The throw happens inside the cache's fold, so nothing bad is
  cached. `getStats`/`getEditorial` build on a private `loadVisible` so
  neither pays a round trip for samples it never renders.
- **The statement's table is hidden ONLY when it says exactly what is being
  rendered** — same samples, same order, same explanations, compared after
  normalising line endings and trailing whitespace, because a test file ends
  in a newline and a table cell is trimmed prose (a literal byte comparison
  would never match and the rule would be dead code nobody noticed). When a
  table goes and it was the entire body of the heading above it, the heading
  goes too. A table that differs at all stays: showing a reader the same
  example twice costs nothing; hiding their only copy of a third costs
  everything. A truncated or capped sample set therefore never hides
  anything, which is the right degradation.
- **The MCP scraper is demoted, not deleted, and lives in
  `@duckoj/statement-samples` now.** An MCP server is routinely pointed at a
  DuckOJ older than the SDK it was built against, and dropping the fallback
  would turn "your API is a version behind" into "this problem has no
  samples". It is a package because the web needs the same reading of the
  same convention to answer the duplicate question, and a second copy of a
  narrow parser is how two consumers quietly stop agreeing.
- **`prepare`'s `samples` check `skip`s a package that declares none.** The
  gate answers "does this package deliver the samples it declares"; turning
  "publishes no worked example" into a blocking failure is a judgement about
  the problem, not the package, and would fail every problem prepared before
  this.

*Ruled by the implementer during the 2026-08-30 feature loop (F22 brief), no
human available to consult. No migration — the package is the record, and
`problem_revisions.package_hash` was already there.*

## D95 — The contest-day monitor is one organiser-only snapshot, cached for exactly as long as its page waits

`GET /contests/{key}/monitor` (tag `Contests`, `contests:read`, no `@Public()`)
answers one question — *is this contest running properly right now* — with
seven panels in one response: per-problem attempts / accepted / distinct
solvers / still-queued, the grading queue scoped to this contest with the age
of its oldest job, judge liveness, the last fifty submissions with their real
verdicts, the questions nobody has answered, how many of this contest's
competitors have a live socket open, and how many submissions D80's meter
refused in the last ten minutes. `apps/api/src/authz/contest.monitor.ts`,
`apps/web/src/routes/contest-monitor.tsx`, migration **0035**.

**One response, not seven** — D47's reason, unchanged: a queue backing up
reads one way beside a live judge and another beside a silent one, and a
five-second refresh of seven routes is seven times the load for one page.

**Who may see it: `loadVisible` then `canRunContest`** — 404 for a contest the
caller may not see, 403 `contest_forbidden` for one they can see but do not
run. Exactly the pair the similarity report already publishes (D77), and the
same two gates in the same order, because they are the same question.

- **Nothing is frozen, and that is the point.** D22 hands the contest's
  creator and a global admin the live scoreboard; D23 exempts the same set
  from the submission mask. The gate here IS that set, so the feed shows real
  verdicts inside a freeze window. An organiser who could not see what the
  judge was doing during the last hour of their own contest would have no
  monitor at all.
- **Cached five seconds in Redis, through `ScoreboardCache`** — where D47's
  dashboard deliberately caches nothing. The difference is who is holding the
  page open: one admin there, every organiser and invigilator in a province
  here, during the two hours the deployment is busiest. Five seconds is the
  page's own poll interval, so the cache collapses a room of organisers into
  one fold per tick and nobody ever reads a number older than their own
  refresh. One key per contest (`duckoj:monitor:v1:<id>`) — no view and no
  freeze phase in it, unlike D25's, because there is one audience and no
  freeze to be on either side of. **No invalidation**: every write that would
  move these numbers is a submission or a verdict, and D25 already records
  that the API never handles the verdict. `generatedAt` is inside the cached
  body, so a hit says honestly when it was folded.
- **"Participants online" is connected users ∩ this contest's participations,
  and it is a floor, not a roster.** Neither half knows the whole thing: the
  gateway knows who is CONNECTED and cannot know which contest they are here
  for — D31 gave the contest page no socket of its own, and a competitor's
  socket watches a *submission* — while the database knows who holds a
  participation and nothing about sockets. So `SubmissionsGateway` writes
  every authenticated connection's user id into one Redis sorted set
  (`duckoj:ws:presence:v1`, scored by the instant of the last sighting,
  refreshed on the existing 30 s heartbeat sweep, trimmed to five minutes on
  every write) and the monitor intersects it with `contest_participations`.
  One set for the deployment rather than one per contest, because a per-contest
  key would need a contest the gateway was never told. A competitor reading a
  statement with no socket open is not counted; nobody is counted twice for
  two tabs. Redis-backed for D25's reason — `main.ts` forks workers, and an
  in-process registry is one registry per worker.
- **Judge liveness reuses `JUDGE_SILENCE_SECONDS` (90 s), not the brief's
  "last minute".** 90 s is judged's own rule (`PING_INTERVAL_MS ×
  MISSED_PING_LIMIT`), and it is what `/admin/dashboard` calls offline. A
  monitor that buried a judge thirty seconds early would have organisers
  reporting an outage the operations page says is not happening. It is a
  fleet count, not a per-contest one: a judge serves every contest, and the
  drill-down is the dashboard, which already lists each node.
- **The refusals count is deployment-wide, and that is a ruling.** D80 keys
  the submission meter on the USER — deliberately, because a school computer
  room is one IP — so a refusal carries no contest. Showing it anyway is the
  honest trade: during a contest almost every submission in the system is that
  contest's, and an organiser watching the number climb is watching somebody's
  script, which is the thing the panel exists to surface. The purpose string
  is composed from `REFUSAL_PREFIX` + `SUBMISSION_PURPOSE`, never typed out,
  so a rename moves the count instead of silently zeroing it.
- **The clarifications panel is a work queue, so it lists the newest five
  UNANSWERED**, not the newest five. A contest whose last five questions were
  all answered while twenty wait is exactly the state where the other choice
  shows nothing worth showing. `answer is null` is the whole predicate, and
  D31's CHECK is what makes it safe: an announcement has no question and its
  text in `answer`, so it can never appear here.
- **Every query is bounded by the CONTEST, not by a time window** — D47's
  amendment, in its own words: a window bounds the rows a query returns, only
  an index bounds the rows it scans. **Migration 0035** adds
  `contest_submissions (contest_problem_id, id)`, because there was no index
  into that table from a contest at all and every panel scanned every contest
  submission the deployment had ever taken (D11 keeps them forever); and
  `contest_submissions (participation_id)`, a **missing foreign-key index
  under `ON DELETE CASCADE`** — the same bug D47's amendment paid for on
  `grading_jobs (submission_id)`. The feed is a `LATERAL` top-50 per problem,
  so it reads at most `50 × problems` rows however large the contest grows,
  rather than sorting the whole contest to discard all but fifty. The queue
  panel is driven from `grading_jobs` under `grading_jobs_active_idx`'s
  predicate, spelled `state <> 'done'` word for word so the planner can prove
  it applies. `oldestPendingSeconds` is `null` for an empty queue, never `0`
  — D47's rule, for D47's reason.

**Live updates: a five-second poll, and a WebSocket that beats it.**
`{ type: 'watch-contest', key }` enrols a socket in a contest's fan-out,
authorized by `ContestMonitorService.assertMayWatch` — the same two gates as
the route, asked rather than answered, because `AuthGuard` never sees a
WebSocket upgrade and a second opinion about who runs a contest is how the two
would eventually disagree. The gateway then publishes
`{ type: 'contest-activity', key }` to those sockets whenever `notify` fires
for a submission in that contest, over the Redis channel `judged` already
uses. Three rulings inside that:

- **The submission→contest lookup runs only when this worker holds a
  watcher.** `judged` publishes one id per state change and knows nothing
  about contests, so the mapping is a query; paying it on every verdict
  forever to serve a page nobody has open is a cost the ordinary judging path
  must not carry. With no watcher the fan-out returns before touching the
  database.
- **The frame carries the key and nothing else** — D23's rule that a realtime
  push is a signal, never data. The page re-fetches through the ordinary
  authorized read, which re-decides everything.
- **The page's socket is an accelerator, never a dependency.** A refused watch
  stops reconnecting rather than retrying: a caller the server said no to will
  be told no again, and an organiser's tab hammering an upgrade for three
  hours is the one way this screen could hurt the deployment it watches. With
  no socket at all the page is exactly its five-second poll, and it says so.

Web: `/contests/{key}/monitor`, a route rather than a panel — it is the screen
an invigilator leaves open for hours, a URL is what you send to the colleague
in the other room, and its five-second poll must not ride along on the contest
page every competitor has open. The link on the contest page is gated on
`canEdit`, which is `canRunContest`'s own answer.

*Ruled by the implementer during the 2026-08-30 F-23 loop, no human available
to consult. Migration 0035.*



## D96 — A problem statement is untrusted input, and `solve-problem` renders it inside a marked region

`apps/mcp`'s `solve-problem` prompt fetched a problem and spliced its
statement straight into a **user-role** message — the one place a host shows
text to a model as though the person at the keyboard had typed it. A DuckOJ
statement is written by whoever set the problem: on a province deployment that
is every teacher in the province and any account holding `problems:write`, and
a statement arriving through `polygon:import` was written somewhere else
entirely. Spliced in raw, it was indistinguishable from the prompt's own
prose, so a statement that opened `## How to finish` wrote the section that
tells the agent what to do next — and the agent it was instructing might be
running with `DUCKOJ_MCP_WRITES=1`.

- **The statement and its samples go inside `<<<DUCKOJ-UNTRUSTED-CONTENT>>>`
  … `<<</DUCKOJ-UNTRUSTED-CONTENT>>>`, and the content's own copies of those
  markers are defanged.** Markers rather than a Markdown fence because the
  content IS Markdown and carries fences of its own. Defanged rather than
  refused, because a statement that happens to contain the string is still a
  statement and showing it inert beats showing nothing.
- **The markers are named, never spelled out, in the sentence that explains
  them.** Delimiters with nothing explaining them are decoration; the guard
  sentence is what tells the model the region is data. Writing the literals
  inside it would put a second copy of each in the message, and "the region
  runs from the marker to the marker" would stop being something a reader —
  or a test — could locate.
- **The instructions come BEFORE the region.** A forged heading inside it is
  then a second copy of a section the model has already read, arriving from a
  place it has just been told is data.
- **A title is flattened to one line.** `problem.name` and the tag slugs are
  rendered outside the region because they are a title and a vocabulary, not
  prose — and a title with a newline in it can write a heading, which is
  exactly how this message distinguishes an instruction from content.
- **A code fence is one backtick longer than the longest run inside it**
  (CommonMark's own nesting rule). This became load-bearing when the prompt
  started rendering D94's sample FILES: a sample is arbitrary test data, and a
  line of three backticks in one is a line of three backticks.
- **The samples come from `resolveSamples`, not from the statement table.**
  D94 put the graded sample files on `GET /problems/{code}`; this prompt — the
  one surface whose whole job is handing a model a runnable example — was
  still scraping the prose beside them, so it gave a trimmed copy where
  `problems_get` gave the real bytes, and "no sample table could be parsed"
  for every statement shaped differently. Two readings of one question inside
  one server is the drift D94 exists to end.

None of this makes a model immune; no delimiter does. What it buys is that the
boundary is unambiguous and stated, so a statement that tries to cross it is
visible as an attempt rather than invisible as a section.

*Ruled by the implementer during the 2026-08-30 B-17 bug-hunt loop, no human
available to consult. No migration.*

## D97 — `prepare` stores an editorial on every run and publishes it only with the revision

`publishProblem` sent `editorial.md` with `editorialPublished: true` on every
run, including runs that published nothing. That is the wrong default in the
one situation the command is most used for: `prepare publish <dir>` **without**
`--publish` is how a setter stages next year's package on a live problem — the
revision lands as a `draft` for a person to publish, which D87 and D90 both
state — and D43 serves a published editorial to *any* viewer who may see the
problem, anonymous included. So the command whose entire promise was that it
published nothing handed the room the solution write-up.

- **The editorial is stored on every run and published only when this run
  published the revision.** A PATCH carrying `editorial` alone leaves
  `editorial_published_at` exactly where it was (only an explicit
  `editorialPublished` moves it, `problem.access.ts`), so re-running on a
  problem whose editorial is already live updates the text and keeps it live,
  and re-running on one that is staged keeps it staged.
- **Publishing an editorial is a decision, not a side effect.** D88 already
  rules this for the problem clone, which carries the editorial "but never
  carried as PUBLISHED" because "the source's readers were let in by its
  author, and cloning is not that decision being made again by someone else".
  A publish run is where that decision is made here, and `--publish` is how it
  is spelled — the same flag, the same act.
- **`--no-editorial` still means "send nothing".** It is the flag for a
  directory whose `editorial.md` is a working note; the new behaviour is about
  what a sent editorial does, not about whether it is sent.

*Ruled by the implementer during the 2026-08-30 B-17 bug-hunt loop, no human
available to consult. No migration.*

## D99 — A team is one participant: one participation, one row, one name on the board

"Thi đồng đội" — the ICPC shape. `teams` and `team_members` under an
organization, `contests.participation_mode` (`individual` | `team`) and
`contests.max_team_size`, and `contest_participations.team_id`. Migration
**0036**; `apps/api/src/authz/team.access.ts`, `contest.teams.ts`,
`apps/api/src/orgs/teams.controller.ts`, `packages/contracts/src/teams.ts`,
`apps/web/src/routes/teams.tsx`.

**The load-bearing sentence is the title.** A team participation is ONE row of
`contest_participations`, held by whichever member pressed Join; every
member's submissions with `?contest=` land on it; the scoreboard shows one
row and prints the team's name. Nothing in `@duckoj/contest-formats` learned
what a team is, and nothing had to: `ParticipantSpec.name` is only what the
row prints and `participation_id` is what `lower()` matches on (D36), so a
team is a participant with a different label. All 27 goldens and the 23
replays are byte-identical, untouched.

- **One participation per team, ever** — a partial unique index on
  `(team_id, contest_id)`, which is also the foreign-key index the
  `ON DELETE RESTRICT` needs (the missing-FK-index bug D47 and D95 each paid
  for once). The teammate who presses Join second reads the row back if they
  are the account that made it (`join`'s existing idempotency) and otherwise
  gets 409 `contest_team_joined`. **There is therefore no virtual replay for
  a team**, and a team that never entered is refused after the end with 409
  `contest_team_no_virtual` rather than given `virtual = 1`. That is the
  honest shape: a virtual attempt is a person re-sitting a finished paper,
  and "the team re-sits it" is a different team every time its roster
  changes.
- **ONE resolver for "which participation does this person act under"**:
  `actingParticipations` in `participation.ts` — their own rows, plus the
  rows their teams hold. Four call sites asked that question as `user_id = ?`
  (join's short-circuit, `GET /contests/{key}/me`, `resolveContestTarget`,
  `ContestClarificationsService.ask`), and four independent widenings would
  be four chances to reintroduce the split-predicate bug D22, D23 and D25
  each record. The brief's "clarifications by any member" falls out of it for
  free. It orders highest `virtual` first then lowest id, so the tie a
  mid-contest roster edit can create resolves the same way on every request.
- **A person holds at most one participation per contest**, enforced at join
  (409 `contest_already_joined` when any member of the joining team already
  competes, under their own name or on another team's row). Two rows for one
  person would make the resolver above pick between them, would make
  `setDisqualified` — keyed by username (D37) — move both, and would put one
  competitor on the board twice with the same work counted each time.
- **Disqualification needs no new route.** `PATCH
  /contests/{key}/participants/{username}` takes the username of the member
  whose account holds the row (the `captain`), and D37's "every participation
  that user holds in this contest moves together" then moves exactly the team
  row. The scoreboard's sidecar carries `captain` so the web can drive the
  existing button; sending the team's NAME there answers 404 `user_not_found`,
  which is a test in both suites.
- **Two teams of the same name may not compete in one contest** (409
  `contest_team_name_taken`, case-folded). The ranking row carries no
  participation id — D36 declined to add one, and the goldens are why — so
  every consumer downstream keys on the NAME: the board's `teams` sidecar,
  the results sheet, the certificates, the similarity report's `{a}/{b}` pair
  links. One check at the one moment the collision can be created costs a
  query; teaching five readers to disambiguate a name would cost a response
  shape. **Checked wherever the name can change**, which is `join` AND a
  rename: `PATCH /orgs/{slug}/teams/{teamSlug}` refuses a new name already
  competing on a board this team is on, because a rename is the same
  collision arriving by the back door — an ordinary PATCH any admin of any of
  the contest's schools can make while the round runs. The consequence is not
  cosmetic: two rows sharing a name collapse to one sidecar entry, and then
  the scoreboard's disqualify control moves the WRONG team and the results
  sheet prints the wrong roster against one of the two rows. **The
  same-instant race is now closed** (F-25): the whole of `join`'s tail runs
  in one transaction that first takes
  `pg_advisory_xact_lock(contest_id, hashtext(lower(team.name)))`. The key is
  the NAME, not the team, and that is the entire point — the two rows racing
  are two DIFFERENT teams, so a per-team lock never collides for them, while
  the name they share is exactly what makes them a collision. It serialises
  two teammates entering one team as a free side effect (same name, same
  lock). An advisory lock rather than a row lock because there is no row to
  lock: the thing being made unique is a name that is not on the board yet.
- **The board's `teams` is a camelCase sidecar, absent for an individual
  contest.** Built inside `computeScoreboard` from the same participation
  rows the fold consumed, so it rides D25's two-second cache and cannot
  describe a different board than the one beside it, and so `frozen` /
  `frozenAt`'s precedent (D22 — DuckOJ's own additions are camelCase in a
  snake_case object) covers it. Absent rather than `{}`, so no individual
  contest's response changed at all.
- **A team contest names at least one organization** (422
  `contest_team_orgs_required`, on the merged state at create and at edit).
  Teams are org-scoped, so a team contest attached to no school is one nobody
  can name a team for — and it makes D56's join gate coherent in team mode,
  where the team's school is one of the contest's own.
- **`participation_mode` and `max_team_size` freeze at the start** (409
  `contest_started`), D38's rule for D38's reason, compared by VALUE so an
  edit form that PATCHes the whole body back is a no-op. Nothing can have
  joined before the start, so a pre-start edit is always safe and is never
  refused.
- **The roster's ceiling and the contest's cap are different numbers.**
  `TEAM_MAX_MEMBERS = 12` bounds the table; `contests.max_team_size` (three
  by default, the ICPC roster) is what a contest admits, checked at join
  (409 `contest_team_too_large`). One squad can then enter two contests with
  different limits instead of being copied per contest.
- **Teams are managed by an owner OR an admin of the school.** The brief said
  "owner creates"; an organization `admin` is the rank that exists to do the
  owner's day-to-day work, it is the rank D66 already gives a school's
  homework, and D61's owner-only rule is about minting *accounts*, which this
  does not. Reads are staff, a global admin, or somebody on the team — anybody
  else gets 404 `team_not_found`, because a squad list read off the API the
  morning of the round is reconnaissance.
- **A roster edit during a running contest is REFUSED** — 409
  `team_locked_during_contest` — unless the caller runs every contest the
  team is mid-round in, or is a global admin. *(Amended F-25; this bullet
  used to allow it.)* The original reasoning — membership is read, never
  frozen, so nothing already recorded changes — is true and is not the
  danger. The danger is who may make the edit: an org admin at ANY of the
  contest's schools could swap a stranger onto a team mid-round and hand them
  the participation and every point on it, through an ordinary PATCH, and
  nothing would say so afterwards. The one legitimate mid-round edit is the
  pupil who did not turn up, and that is made by the person running the
  round, which is who the exemption names. **All** the running contests, not
  any: an organiser of round A has no standing to reshuffle a roster that is
  mid-round in B. A **rename** is not covered — it has its own rule (the
  board-ambiguity check above), and a typo fixed during a round harms
  nobody. `TeamSummary.inRunningContest` is served so the org page can WARN
  before a teacher opens a form, rather than refusing after they filled it
  in.
- **A team contest is never rated** (409 `contest_team_unrateable`).
  Glicko-2 rates a person against the people they were measured with, and a
  team row is three people sharing one result: crediting the captain rates
  one member for the work of three, crediting all three rates each for a
  performance none produced alone. Refused inside `setRated`, which is the
  only writer of `is_rated`, so the replay is safe by construction rather
  than by a filter that could drift.
- **The exports follow the row.** The results sheet prints the team's name
  and — only for a team contest — a `members` column (D71's header row is the
  file's contract with whatever reads it next, so an always-present empty
  column would break every file already exported). The `orgs` column is the
  TEAM's school, not the captain's own memberships: "which school is this
  entry from" is the question the column exists to answer. A certificate is
  one per team listing its people, and `?username=` matches the team's name
  **or any member's account** — an organiser reprinting a lost certificate
  knows the pupil, not necessarily which name holds the row.
- **The similarity report labels by team, and therefore never reports a team
  against itself.** D77 compares one submission per participant per problem;
  a team is one participant, so three teammates' independent attempts at one
  problem are one entry rather than three suspiciously similar competitors.
  Teammates sharing code is what a team contest IS.

### D99 amended, 2026-08-31 (F-25) — the four gaps F-24 left open

- **`GET /users/me/teams`** — every team the caller is on, across every
  school, in ONE request. The join picker issued `GET /orgs/{slug}/teams`
  once per organization the contest named: fine at two schools, twenty round
  trips at twenty, on the page a province opens at the same minute. It asks
  no visibility question because every row is a team the caller is ON, which
  is the strongest membership the team read already accepts. `orgs:read`, not
  `users:read`: what comes back is a school's rosters, and a token holding
  only the profile scope must not reach them through a route named after the
  caller. Not paged (`MY_TEAMS_LIMIT = 200`, `truncated` says so) — a person
  is on a handful of teams and a picker that had to page would carry a bug
  nobody reproduces.
- **`?contest=` annotates each team with `eligible` and
  `ineligibleReason`**, and every code is one `POST /contests/{key}/join`
  would refuse with. A screen that explained a refusal in words the server
  would not use disagrees with the server the first time either changes. Both
  fields are `null` without a `?contest=` — never `true`, because "may this
  team enter" has no answer without a contest, and `true` would make a picker
  that forgot the parameter look like it worked. It is a snapshot, not a
  promise: the same-instant races are settled by the lock, and no picker can
  be.
- **A team has its own page**, `/orgs/{slug}/teams/{teamSlug}`, listing its
  members and the contests it entered. F-24 argued a team was "a name and
  three usernames"; what changed is that a team now has a RECORD. It carries
  no RANK, deliberately: ranking means folding the contest's scoreboard —
  a cached two-second fold per contest (D25) — which would make one team page
  cost one of those per row, and a rank means nothing for a round still
  running. The contest and its board are links, which is where a standing
  lives.
- **`POST /contests/{key}/participants` `{ teamSlug }`** lets the organiser
  enter a team, D61's spirit one rank up. On contest day the member who
  should press Join is a fifteen-year-old whose password was issued that
  morning; the organiser can already disqualify that team, answer for it and
  export its results, and the gap gets filled today by an invigilator
  borrowing a pupil's account. Every check `join` makes, under the same lock,
  plus two decisions this route has to make itself: the participation is held
  by the **lowest user id on the roster** (the row's `user_id` is NOT NULL
  and is the captain D37's disqualify route is keyed by; nobody pressed a
  button, so the choice is deterministic rather than whoever the query
  returned first — an empty roster is 422 `contest_team_empty`), and seeding
  BEFORE the gun is allowed with `startTime = max(now, contest.startTime)`,
  because preparing the room is the whole point. After the end it is refused:
  a team has no virtual replay. There is deliberately **no way to seed an
  individual** — a person entering a contest is a person choosing to sit it.

*Ruled by the implementer during the 2026-08-30 F-24 loop, no human available
to consult. Migration 0036. Amended during the 2026-08-31 F-25 loop.*


## D100 — The monitor's per-problem panel is a counter, not an aggregate

D95's monitor answered "how is each problem going" with a grouped outer join
over `contest_submissions` and `submissions`. B-17 measured what that cost on
a fixture holding 100 000 rows for a DIFFERENT contest and 200 for the one
being watched: `Seq Scan on contest_submissions (rows=100200)` **and** `Seq
Scan on submissions (rows=100200)`, 30.9 ms, to produce ten rows — on a page
every invigilator in a province holds open at a five-second refresh. Two
`LATERAL` rewrites drove `contest_submissions` through migration 0035 and
measured *worse* (98 ms), because the planner's ~5010-rows-per-problem
estimate hashes `submissions` ten times over.

**The cost was never in the query.** An aggregate over every submission ever
made cannot be made O(problems) by rewriting it; it is a schema decision. So
migration **0037** adds `contest_problem_stats` (`contest_problem_id` PK,
`submitted`, `accepted`, `solvers`, `pending`, `updated_at`), maintained on
write, and the panel reads one row per contest problem. Measured on the same
fixture: no node in the plan reads more rows than the problem catalogue holds
(21), and it runs in **0.126 ms** — 245× faster, and bounded by the CONTEST'S
PROBLEM LIST rather than by the deployment's history, which is exactly what
D47's amendment says an index is for. Pinned by
`apps/api/test/contest-monitor-plan.spec.ts`, which runs BOTH statements on
one fixture so the improvement is measured rather than remembered.

- **`solvers` is a SET, not a counter** — `contest_problem_solvers
  (contest_problem_id, user_id)`, second table, same migration. A distinct
  count cannot be maintained by adding one: the first `AC` a person lands
  must move it and every later one must not, and the only other way to know
  which is to ask "has this user solved it before?", which is a scan of that
  problem's submissions **on judged's hot path** — the cost this migration
  exists to remove. `INSERT … ON CONFLICT DO NOTHING RETURNING` answers it in
  one index probe, and `contest_problem_stats.solvers` moves exactly when a
  row was actually inserted. `user_id` rather than `participation_id` because
  a person may hold a live participation and any number of virtual attempts
  in one contest, and D95's panel counts people.
- **Three writers, one copy of the arithmetic**, in `packages/db/src/
  contest-stats.ts` — `reclaimExpiredLeases`'s reason exactly: `apps/judged`
  and `apps/api` both need it and neither may import the other, and a second
  hand-written copy of a delta is the kind of thing that later disagrees with
  the first about what "pending" means. Each function takes the caller's
  transaction handle and opens none of its own, so a counter moves if and only
  if the write it describes commits. Lock order is `submissions` →
  `contest_problem_solvers` → `contest_problem_stats` in every path.
- **judged's terminal writes are now transactional, and the deltas apply only
  when the FENCE matched.** `EventWriter.writeTerminal` reads the prior
  outcome `for update`, applies the fenced UPDATE with `.returning()`, and
  moves the counters only if a row came back. A superseded attempt's write
  matches nothing — that is what the fence is for — and a counter that moved
  anyway would drift by one for every stale packet a partitioned judge
  eventually delivers. `apply`'s "after `write` resolves means after commit"
  contract survives, because the transaction is inside `write`.
- **A rejudge RECOMPUTES the contest problems it touched; it never
  decrements.** A requeue moves verdicts in every direction at once — a
  hundred `AC`s become `null`, one competitor's only `AC` on a problem
  disappears while another's survives on a submission the rejudge did not
  touch. Every decrement rule that would have to be right about that is a rule
  that can be subtly wrong forever, and silently. Recomputing is
  arithmetic-free, bounded by 0035's index, and happens inside the requeue's
  own transaction so a monitor refreshing between the two never reads counters
  describing verdicts that no longer exist. The same door catches the one
  judged-side case that could decrement (`AC` → not-`AC` on one submission):
  it recomputes that one problem instead of guessing.
- **`GET /contests/{key}/monitor?recompute=1`** is the repair, and it is on
  the monitor rather than behind an admin route because the person who notices
  "problem C says four solvers and I can see six on the board" is the
  organiser looking at the panel — making them find an administrator is making
  them not fix it. It runs after both of D95's gates (404 unseen, 403
  seen-but-not-run), so the write is one only the people who run the contest
  can make, and it **replaces** the five-second cache entry rather than reading
  through it: rebuilding the counters and then serving the snapshot taken
  before the rebuild would show the organiser exactly the numbers they pressed
  the button to correct. `ScoreboardCache.put` exists for that.
- **A missing counter row is zero, not an error.** Reads `left join`, every
  writer upserts. A contest problem added after 0037's backfill therefore
  needs no backfill of its own, and no write path has to know whether the row
  exists yet. The migration still backfills every existing contest problem, so
  "no row" means "created since the deploy" rather than "possibly missed".
- **`pending` is a submission-side count and the queue panel stays
  job-side.** They can honestly disagree — a swept-away `grading_jobs` row
  leaves a submission still un-judged — so the per-problem column now has one
  source (`contest_problem_stats.pending`, submissions not yet terminal, where
  terminal is `done` or `errored`) and `queue` keeps the one question only
  `grading_jobs` can answer: how deep the backlog is and how long its oldest
  entry has waited. `queue()` no longer groups by problem at all.

*Ruled by the implementer during the 2026-08-31 F-25 loop, no human available
to consult. Migration 0037.*

## D101 — Being on a team is what lets you ACT for it; having competed on it is what lets you READ it

D99 gave a team one participation, held by whichever member pressed Join, and
said two things that the code then asked with one predicate: every member's
submissions land on that row, and "a member removed mid-round stops being able
to submit for the team from that moment". Four surfaces answered "does this
person compete here?" and three different things were wrong at once. **The
rule is that there are TWO questions, and they take different answers.**

- **Acting for the team — submitting, asking a clarification, reading
  `GET /contests/{key}/me` — requires CURRENT membership.**
  `actingParticipations` matched `user_id = you OR team_id in (your teams)`,
  and the first half never expires: the captain is the one member a roster
  edit could not remove, because the row is on their account. That is the
  likeliest person to be taken off (they are sitting at the machine that
  entered) and the exact case D99 says must stop. `user_id` now matches only
  rows that are NOT a team's; a team row is reached only through membership.
- **Reading the round's problems does NOT.** `inJoinedContest` is the clause
  that makes a contest's private problems readable to the people sitting it,
  and D99 broke it in the other direction: asked as `user_id = you`, it was
  false for every member of every team except the one who pressed the button,
  so two of three teammates got 404 from `GET /problems/{code}`, an empty
  booklet (D62 filters it through `visibleProblemsWhere`), and 404 from
  `POST /submissions`. It is now "your own row, or one your team holds" — and
  deliberately **not** narrowed to current membership, because that predicate
  is already not gated on the contest window still being open: after a round
  you may re-read what you competed on, and a pupil taken off a roster
  competed on it.
- **One predicate for the read, declared once.** `actingParticipationWhere`
  in `problem.visibility.ts` serves both the row-wise `loadProblemContext`
  and the list-query `visibleProblemsWhere`. The two live eight lines apart
  precisely because they must agree, and a team clause written into one of
  them is the split-predicate bug D22, D23 and D25 each record paying for.
- **"Participants online" counts PEOPLE, not rows.** D95 intersects the
  presence set with `contest_participations.user_id`, which names one person
  per squad; the invigilator's "is the room here" number was a third of the
  room, and fell to zero when captains closed tabs. It is now the union of
  the two ways a connected user competes here — they hold the row, or they
  are on the team that holds it. D95 calls the number a floor rather than a
  roster, which is about a competitor with no socket open, not about two
  thirds of the entrants being structurally invisible.
- **The invariant D99 enforces at join is enforced wherever it can be
  broken.** "A person holds at most one participation per contest" was
  checked at `join` and nowhere else, so `PATCH /orgs/{slug}/teams/{teamSlug}`
  — an ordinary roster edit any admin of any of the contest's schools can
  make mid-round — could add a pupil who was already competing, on their own
  row or another team's. This is the same back door D99 closed for the team
  NAME and left open for membership. `assertAddedMembersFree` closes it, 409
  `contest_already_joined`, scoped to the contests this team competes in and
  excluding this team's own rows so a captain removed by mistake can be put
  back.
- **The report labels by team, so the web must not treat the label as an
  account.** The scoreboard already refused to make a team's name a
  `/users/{name}` link; the similarity pair table and the side-by-side view
  did not, on the screen an organiser opens when they think somebody cheated.
  One `CompetitorLabel`, used by both.

**Residuals, stated rather than fixed.** A pupil removed from the team that
holds a row still cannot join another team in that contest: `assertMembersFree`
sees their `user_id` on the row they left, and refuses. That is the safe
direction — one person, one entry — and unpicking it would mean deciding
whether a mid-round transfer is a thing a contest allows, which is a product
question and not a defect. `setDisqualified` still keys on the captain's
username (D99's own ruling) and answers 404 `participation_not_found` for any
other member, which is honest; the board's `captain` sidecar is what the web
drives it with.

*Ruled by the reviewer during the 2026-08-30 feature/bug loop (B-18 whole-diff
review), no human available to consult. No migration.*


## D102 — While `must_change_password` is set, the API mints no token and honours none

D61 put the forced password change on the web alone, and said why: gating the
API "would mean auditing every endpoint for a new refusal code that a client
can already avoid, in exchange for stopping a pupil who would have to be
driving the API by hand to reach it." That last clause was true when it was
written. It is not true now — `oj login` and the MCP server (D89) are the
documented way to drive this API by hand, and they take an access token that
`POST /auth/tokens` hands out to any session, including the session a pupil
opens on the password printed on a classroom sheet. The exposure is not the
token; a change revokes every one of them. The exposure is that the change
then never happens: the pupil has what they came for.

- **`POST /auth/tokens` is `409 password_change_required` while the flag is
  set.** 409, not 403: nothing is wrong with the credential or the caller's
  rights — the account is in a state that this request conflicts with, and the
  state is one the caller can leave.
- **The check is in `TokenService.issue`, not in `TokensController`.** The
  controller is not the only door: anything that later mints a token for a
  user passes through this method, and a rule written one layer above it is a
  rule the next caller forgets. The same argument D61 itself makes for
  `org-import.core.ts`.
- **A token that already exists is refused too, on reads as well as writes.**
  With the mint closed, the only way to hold a token and the flag at once is
  to have minted it BEFORE this rule — a token predating the deploy. That is
  precisely the population the mint check cannot reach, and it is the whole
  incident: a pupil who ran `oj login` once keeps a credential the forced
  change was supposed to have ended. `TokenService.resolve` therefore throws
  the same refusal. Reads are refused with writes because a token is ONE
  credential, and splitting the refusal by HTTP verb would make every new
  write route inherit its protection from its method — the exact shape the
  deny-by-default `AuthGuard` exists to avoid.
- **The session is deliberately untouched.** It is how the change is made:
  `PasswordGate` needs `GET /auth/me` to know it must swap the page, and
  `POST /auth/password/change` is `@SessionOnly`. Listing and revoking tokens
  stay available too — revoking a credential is never the thing to block
  while an account is in a state this defensive.
- **Nothing new had to be published for the bearer flow to LEARN the
  obligation.** `LoginResponse` is `{ user: MeResponse }` and `MeResponse`
  has carried `mustChangePassword` since D61, so a non-browser client is told
  at login and again on every `/auth/me`. Pinned by a test rather than
  assumed, because it is now load-bearing rather than incidental.
- **The refusal names a browser, because no client that can see it is one.**
  `oj` gave each command its own guess at a failure — "check your token",
  "could not list problems", "submission refused" — and every one of those
  guesses sends the reader to fix the wrong thing. One `refuse()` answers
  D102 ahead of the guess, in `whoami`, `problems`, `problems show`,
  `languages`, `submit` and `watch`; `watch` needed it most, since a 409 was
  otherwise five polls and ten seconds before a message about a flaky judge.
  The MCP server needed no change — B-17's `asHandlerError` already carries
  `code` and `detail` through all three doors — and now has a test saying so.
- **The WebSocket upgrade reports a refusal with its own status.** The
  gateway's `.catch` turned any throw from `authenticate` into `500 Internal
  Server Error`, which for a ruling tells a client to retry the one thing
  that can never work. An `AppError` now writes its own status line.

**What is not gated, and why that is the whole audit.** D61 feared "auditing
every endpoint". No endpoint was audited, because the gate is not on
endpoints: it is on the two operations that make a token exist and make a
token work. Every route reached by a token is covered by construction, and no
route reached by a session is affected at all.

*Ruled by the implementer during the 2026-08-31 leftovers loop (B-19 brief),
no human available to consult. No migration, one new refusal code.*

## D103 — The crash-loop breaker needs two failed boots, not one dead fleet

D85's rule is "zero live workers within 60 s of primary start". It was reasoned
about with four workers in mind, where a build that cannot boot produces four
exits and the rule reads exactly right. `API_WORKERS=1` is a supported mode —
`resolveWorkerCount` documents it as "no clustering", and it is what a single
small deployment runs — and there "a worker died" and "every worker is dead"
are the same event. One transient crash in the first minute therefore exited
the primary, and `scripts/deploy.sh`, whose entire job is to notice a non-zero
exit, rolled back a healthy build.

- **The breaker now needs `CRASH_LOOP_MIN_EXITS` (2) failed boots inside the
  window, as well as an empty fleet.** A build that cannot boot dies again
  about a second later, so the deploy still sees a real exit code well inside
  its 45 s poll. One crash is an incident; two in a minute is the pattern the
  next fork will repeat.
- **A "failed boot" is an exit before `STABLE_UPTIME_MS` (30 s)** — the
  threshold already in this file, the one that decides whether a death resets
  the re-fork backoff, rather than a second number meaning nearly the same
  thing. A worker that served for half a minute and then died is not evidence
  that the build cannot boot: it demonstrably did. This makes the breaker
  slightly *narrower* than D85 in one more case — a fleet that booted, served,
  and then died all at once inside the first minute is now re-forked — which
  is what D85's own text asks for ("a process that served for a day and then
  loses its whole fleet at once is a different incident"); the only thing
  special about the first minute was that D85 had no way to tell the two
  apart.
- **Multi-worker behaviour is unchanged**, deliberately: four workers dying on
  boot is four exits, so the fleet-size case D85 shipped for still trips on
  the death that empties the fleet. Pinned by a test that starts four.
- **Counted from primary start, still.** D85's reason holds: this rule is
  about a build that never booted, and a window anchored on the last death
  would slide forward forever under a slow crash loop.
- **The log line names the count**, because the number is the evidence: "after
  2 failed boots" is what distinguishes this from the transient exit the same
  line used to report.

*Ruled by the implementer during the 2026-08-31 leftovers loop (B-19 brief),
no human available to consult. No migration, no API change; amends D85.*

## D104 — A seat is a row: one pupil, one entry per contest, decided by the database

D99's rule is "a person holds at most one participation per contest", and the
board depends on it completely: `actingParticipations` has to choose between
two rows for every submission, `setDisqualified` (keyed by username, D37)
moves both, and one pupil's work is counted twice under two names. It was
enforced by two checks — `assertMembersFree` at `join`, and, after B-18 found
the back door, `assertAddedMembersFree` at the roster PATCH. B-18's own report
recorded what neither check could reach: the two run in separate transactions
that do not serialise, so a PATCH and a `join` each read a world in which the
other has not happened, each says yes, and both write.

- **There is nothing to put a unique index on, so the fact is materialised.**
  For a team row `contest_participations.user_id` is only the captain and the
  people it seats live in `team_members`; the uniqueness spans two tables, and
  no index, `EXCLUDE` constraint or `CHECK` can state it. `contest_seats
  (contest_id, user_id) PRIMARY KEY`, with `participation_id` naming the row
  the person competes on, is that statement — the same move D100 makes with
  `contest_problem_solvers` for a distinct count a counter cannot maintain.
- **Live rows only (`virtual = 0`).** A virtual attempt is a replay and the
  identity index deliberately admits several per person; seating them would
  break a working feature to fix a rule that is only ever about the live
  board.
- **The checks stay, and are still the primary gate.** They are what produce a
  refusal naming the PUPIL — "anh is already competing in a contest this team
  has entered" — which a unique violation cannot, because at that point the
  loser of a race knows a seat was taken and nothing about by whom. The index
  is the backstop, and its violation maps to the same `409
  contest_already_joined` so a client has one code to branch on either way.
  Never a 500.
- **Three writers, one module.** `contest.seats.ts` is the only thing that
  writes the table: `join` (individual, now inside a transaction so the row
  and its seat are one write or neither), `enterTeam` (**every member**, which
  is what makes a team one participant), and `TeamAccessService.update`, which
  reseats the roster inside the same transaction that replaces it.
- **A roster change DELETES seats as well as adding them.** D99 rules that a
  member taken off stops competing for the team from that moment; a seat left
  behind would bar that pupil from the rest of the contest on a row they have
  no part in. Keyed on the participation as well as the person, so a roster
  edit can only ever release the seats its own row holds.
- **`onConflictDoNothing` is deliberately absent from the seat insert.** A
  conflict here IS the race this table exists to catch; swallowing it would
  restore the bug with extra steps.
- **The backfill uses `ON CONFLICT DO NOTHING`, and that is a ruling.** The
  defect has been reachable since D99 shipped, so a live judge may already
  hold a double seat — and `runMigrations` runs at boot, so a unique violation
  in the backfill is an API that will not start rather than a data problem
  reported. The backfill therefore seats the first row it finds and leaves the
  second unseated; the app-level checks go on refusing that pupil everywhere
  else in the contest, and repairing the duplicate gets the seat for free on
  the next write. The table is a guarantee about the future, not a proof about
  history, and it says so here rather than in a comment nobody reads.
- **The race is pinned by a test, on two connections against a committed
  database.** It cannot be driven through the two HTTP routes — each service
  opens and commits its own transaction before returning, so nothing outside
  can hold one open across the other's read — so the test issues the two write
  sets in the order that defeats both checks. Remove the primary key from
  migration 0038 and both transactions commit and the pupil is seated twice;
  with it, exactly one is refused.

- **One interaction, checked rather than assumed.** An organiser may seed a
  team before the gun (D99 as amended by F-25) and may swap
  `participationMode` right up to the start, so a contest CAN hold team seats
  and then become individual. A pupil already seated on that team row is then
  refused their individual join with `409 contest_already_joined` — which is
  the true answer, since the seeded row is still on the board. The stale team
  participation itself is D99's gap, not this table's, and the seat now makes
  it visible instead of silently double-counting the pupil.

*Ruled by the implementer during the 2026-08-31 leftovers loop (B-19 brief),
no human available to consult. Migration 0038.*

## D105 — The monitor's feed names the pupil who submitted, and the team beside them

Found by probing the live stack as two real pupils (B-19): `bh19-b1` submitted,
and the invigilator's feed said `bh19-a1`. D95's feed joins `users` through
`contest_participations.user_id`, which was the submitter until D99 made a team
ONE participation held by whoever pressed Join. From then on the feed named the
captain for every teammate's work — a pupil who may not have touched a keyboard
— on the one screen whose purpose is deciding which machine to walk to.

- **`submissions.user_id`, not the participation's.** The submission knows who
  wrote it; the participation knows which row it scores on. They are different
  questions and the feed had been answering the second while labelling it with
  the first's column name.
- **`team` is added beside the name, not instead of it.** The board is keyed by
  team (D99), so the username alone cannot say which row a submission landed
  on; the team alone cannot say who to talk to. An invigilator needs both, and
  every other screen that had to choose (the scoreboard, the similarity report)
  chose team because it is *ranking*. This one is not ranking anything.
- **`null` in an individual round**, from a `left join`, rather than the
  competitor's own name repeated: a client can then tell "no team" from "team
  whose name happens to match the pupil".
- **The web prints the team as plain text, never a `/users/{name}` link.** A
  team name is not an account — the 404 B-18 found twice on the similarity
  screens.
- **Not frozen, unchanged.** D22 gives the people running a contest the live
  board and this route is gated on exactly that set.

*Ruled by the implementer during the 2026-08-31 leftovers loop (B-19 brief),
no human available to consult. No migration; one added contract field.*

## D106 — CI runs the suites fully serially, and boots the compiled app, because a loaded runner is the only place the tests flake

Finding #1 of the consolidation loop (c1). `.github/workflows/ci.yml` ran
`pnpm -r test`, which lets pnpm run workspace packages concurrently and lets
each package's `vitest run` run its spec files in parallel worker threads.
Every package passes when run alone and serially — the loop reports say so
over and over (B-9 needed six attempts, F-6/F-9/F-13 each record a *different*
random pair of untouched web specs flaking, B-1/B-3/F-1 the scoreboard-cache
TTL spec) — and every one of those flakes is a symptom of the same cause:
`apps/api` alone is 121 spec files and **each one starts its own
Testcontainers Postgres** (`apps/api/test/db.harness.ts`), so under file
parallelism a loaded runner has dozens of Postgres containers racing to start
at once and a container-start timeout reds a spec that never ran a line of the
code under test. That is the "CI is failing/flaky" this loop was told to fix.

- **CI now runs `pnpm run test:ci` = `pnpm -r --workspace-concurrency=1 test
  -- --no-file-parallelism`.** `--workspace-concurrency=1` runs the packages
  one at a time; the forwarded `--no-file-parallelism` (which lands on every
  package's `vitest run`, all twenty of which end in exactly that command —
  verified) runs each package's spec files one at a time. One Testcontainers
  Postgres exists at any instant. This is the invocation the loops have been
  proving green by hand all along (`vitest run --no-file-parallelism`), now the
  CI default. **Local dev is untouched** — `pnpm test` stays fully parallel and
  fast; only CI pays the determinism tax.
- **A dedicated boot step runs before the suite: `pnpm run test:boot`.** It
  `tsc -b`s `apps/api` and runs `app.boot.spec.ts` (B-15's test) against the
  compiled `dist/` — the only place `emitDecoratorMetadata` is real, so the
  only place a `Nest can't resolve dependencies` break like the 2026-08-30
  outage is visible; a spec importing `src/` cannot see it. It boots the real
  `AppModule` with `NestFactory.create` against a fresh migrated Postgres and
  asserts every controller resolved and `/healthz`, `/readyz` and the
  deploy-poll route answer. The spec already runs inside the api suite; the
  named step fails fast and legibly, in ~7 s, before the ~100-file run.
- **`timeout-minutes` raised 25 → 60.** Serial-everything is deliberately
  slower than the old parallel run; the local `test:ci` wall time is recorded
  in the c1 report, and 60 is cheap insurance on a slower GitHub runner.
- **Why not a shared `vitest.config` gated on `process.env.CI`?** It was one of
  the brief's three offered shapes. The CI-only command is the least invasive:
  no package gains a config file it did not have, the existing per-package
  `test` scripts are untouched, and the exact flag the loops already trust is
  what runs. `vitest.workspace.ts` stays as-is (an unused convenience for a
  root `vitest` invocation).

*Ruled by the implementer during the 2026-08-31 consolidation loop (c1 brief),
no human available to consult. No migration; CI + root `package.json` only.*

## D107 — A fresh deploy is proven: migrate applies clean, drizzle-kit reports no drift, the goldens are byte-identical

Consolidation-loop (c1) evidence that a brand-new deployment stands up from an
empty database, re-established because so much schema landed since B-9/B-12
(teams 0036, monitor 0035, problem stats 0037, contest seats 0038). Run
2026-08-31 against a throwaway `postgres:16-alpine` on a spare port, then torn
down.

- **`scripts/migrate.ts` (`pnpm --filter @duckoj/db migrate`) applied every
  migration cleanly on the empty database.** `drizzle.__drizzle_migrations`
  held **33 rows** afterwards and `public` held **40 tables**.
- **The migration set is 33 SQL files, journal idx `0000`–`0038`.** The count
  is not 39: the journal has *deliberate gaps* — `0020` (reserved by a sibling
  task, never filled — B-4/F-4 record it) and `0030`–`0034` (reserved across
  the F-loops, never needed). Drizzle applies by the journal's `when`
  timestamp, not by filename number, so the gaps are inert; B-18 already
  cleared the journal as monotonic. This is why "0001→0038" in prose means 33
  files, not 39.
- **`drizzle-kit generate` reports `No schema changes, nothing to migrate` and
  writes no new file** (`migrations/*.sql` count 33 before and after). The
  TypeScript schema (`src/schema/index.ts` + `src/schema/guarded.ts`) and the
  committed migrations are in sync — there is no un-captured drift a fresh
  deploy would miss.
- **The `@duckoj/contest-formats` goldens are byte-identical** — `goldens.spec`
  27/27 green — so the scoring/format fixtures a contest depends on match the
  code that produces them, unchanged by any of this loop's or the recent
  feature loops' work.
- **The boot spec is the fresh-deploy proof at the app layer** (D106): it boots
  the real `AppModule` against a *freshly migrated* Testcontainers Postgres and
  the deploy-poll route answers 200. Migrate-clean plus boot-clean is exactly
  what `scripts/deploy.sh` does in production, minus the image build.

*Ruled by the implementer during the 2026-08-31 consolidation loop (c1 brief),
no human available to consult. No migration added; a verification, not a
change.*

## D108 — Standing accepted limitations (the index, so they stop being re-discovered)

B-19 burned a whole leftovers item re-investigating something B-9 had fixed
ten loops earlier, because no ruling ever closed it. This is the opposite
list: the things every bug-hunt keeps re-finding that are **deliberate standing
choices, not defects** — each recorded here once, with its report origin, so
the next hunt reads the ruling instead of re-opening the investigation. None
of these is a bug on the province-contest path; each is an accepted bound with
its upgrade path named where one exists. (Items already *fixed* by a later
loop are not here — they are closed, listed as verified-closed in
`loop-c1-consolidation-report.md`.)

**Unbounded / unpaginated reads — safe at province scale, indexed, small
result sets.** All correct today because the tables are tiny; the upgrade path
is pagination when a deployment outgrows it.
- `GET /users/{u}/rating` history is unpaginated (B-7).
- `listMembers` / `rosterOf` for an org are unpaginated (B-6).
- The clarification feed is uncapped on read; the ask-limiter bounds the
  growth rate, not the total (F-1).
- The problem-set CSV export is one un-streamed response; nothing meters set
  creation (F-9). The results/certificate exports are bounded at 20,000 but
  proved only at 3, and are still one response rather than a stream (F-13).
- `similarity` holds one advisory lock for the whole comparison in a single
  transaction — a 3000-entrant run holds a connection for its duration (F-15).
- `rejudgeProblem` requeues a problem's every submission in one unbounded
  transaction; `JobStore.reclaimExpired()` is called by nothing outside tests
  (B-3).
- `/users/me/progress` runs seven aggregates on a cache miss, per user,
  unmeasured at province size; the heatmap's `at time zone` day is not
  sargable (F-16).

**Metering gaps — a caller who already holds a credential.**
- `POST /auth/totp/confirm` has no attempt limiter: twelve wrong codes all
  answer 422, but the caller already holds the session (B-1).
- The submission meter (D80) costs two `rate_events` selects per submission on
  the hot write path, indexed but unmeasured under load; its 20/10 min and
  1/10 s thresholds come from one judge's throughput, not observed
  contestants — the first real contest should confirm them (B-13; c1's soak
  re-confirmed the throughput input, see load/RESULTS.md).

**Masking softness — the D35 family (the vocabulary being masked is public
anyway).** A contest's tag mask (D35) and editorial gate (D43) key on the
contest's real window, so a virtual attempt after `end_time`, or simply
signing out, sees them (F-2, F-4). Accepted: tags and editorials are public
once a contest ends, and the value of hiding them is organiser discipline, not
a security boundary.

**Test-harness fidelity (B-15's audit).** `app.harness.ts::buildApp` imports a
hand-maintained module subset and does not run `configureApp`, so ~900 specs
run unprefixed with no CORS / body limits; `cache.harness.ts` builds the cache
by hand. `app.boot.spec` + `config.spec` are the whole cover for both gaps —
which is why D106 promotes the boot spec to its own CI step. The route-marker,
i18n-parity and source-is-text guards are the other cross-cutting nets.

**Judge / ops capacity — operational, tuned per deployment.**
- One judge has a throughput ceiling; a room whose *sustained* aggregate
  exceeds it needs a second judge (F-11's multi-judge path is built). c1
  measured the current single judge comfortably serving 40/min (RESULTS.md).
- Redis `maxmemory` is 0 with `noeviction`: nothing is capped, which is safe
  *only because every key expires* — a future cache write without a TTL would
  have no second line of defence (B-12, reasoned in B-13 §3).
- `clientIp` trusts the leftmost `X-Forwarded-For` — correct for Caddy today
  (runbook), but a second proxy layer would make D16/D26 bypassable (B-10).
- `deploy.sh`, `compose-up.test.sh`, `restore.test.sh` are outside
  `pnpm -r test` and are not exercised by CI (F-14).

**Web / UX bounds.**
- The `/help` guides are bundled at build time, so a guide edit reaches the
  site only on a rebuild (F-10, F-14).
- Tables are the scroll container, so a WCAG 2.1.1 keyboard-scroll fix needs a
  wrapper refactor, not a one-liner (m21, B-4); the authoring forms render to a
  signed-out visitor and are refused only on save (B-4).
- `prepare --token <t>` puts a token in `argv` (B-18).
- A soft read-degradation remains where a *secondary* list failing shows empty
  rather than an error: the tag filter bar (`allTags`) and the progress page's
  error state (spinner, not alert). The primary data reads all surface errors
  via `read()` (B-9/B-19 closed those); these two are cosmetic and low-stakes.

**Team gaps (D99 residuals not closed by F-25 / B-19).** The team-name join
race is unguarded at the last millisecond — two same-named teams joining in
the same instant both land (named in D99; the ordinary second-join and rename
paths are refused). There is no "my teams" endpoint, so the join picker issues
one query per org the contest names; rosters are read live, never frozen, with
no teacher-facing warning; there is no team detail page, no team-scoped
notifications, no organiser team-seeding UI (F-24).

*Indexed by the implementer during the 2026-08-31 consolidation loop (c1
brief), no human available to consult. A pointer entry; no migration, no code.*

## D109 — A comment is a discussion that can leak the solution, so the thread is withheld from the room still solving it

Problems grow a flat discussion (`problem_comments`, migration 0039) — a
top-level thread with exactly one level of replies (a reply's parent must
itself be top-level, else 422 `comment_bad_parent`). `GET
/problems/{code}/comments` is visible to anyone who may see the problem
(keyset by id, D58); the three writes are authenticated and reuse
`problems:write`, exactly as a contest clarification reuses `contests:write`
— a user comment is not authoring, but there is no discussion scope and one
is not worth minting for this. Bodies are raw Markdown rendered client-side
through the same DOMPurify path as statements (`apps/web/src/markdown.ts`);
the API never emits HTML for a comment. Writing is metered at 10 per user per
hour (429 `comment_rate_limited`, with `Retry-After`), checked *after* parent
validation so a malformed reply never burns the window.

**The spoiler rule.** While a viewer is competing in a running contest that
uses this problem — D35's own hidden-set predicate, now shared out of
`problem.visibility.ts` so the mask cannot drift from the one that hides tags
and stats — the discussion is withheld from them *entirely*: a comment is a
discussion that can leak the solution. The read returns an empty page, and
every write is refused 403 `comment_hidden_contest` — a participant who
cannot read the thread must not be able to post into it and leak the solution
to everyone outside the room. Organisers (the contest's creator) and admins
are never hidden anything, and after the contest ends the thread appears.

**The read is signalled (`hiddenDuringContest: true`), the one place this
breaks D35's "blank, never distinguishable" rule** — justified because the
viewer already knows they joined a contest that contains this problem (that
is what let them open the statement at all), so the flag discloses nothing
new, and the web needs it to show a note rather than an empty thread the
brief requires.

**Rulings made building it** (no human to consult):
- **Deletion is a soft delete** (`deleted_at`), author or admin only — not a
  curator: a comment is its author's words, and moderation beyond the author
  is an admin act, not an authoring one. Editing (`edited_at`) is author-only.
- **A deleted comment is a tombstone only while it anchors a visible reply**;
  with none it is omitted from the list outright — a tombstone anchoring
  nothing is noise. A deleted *reply* is always omitted (it anchors nothing).
  Replying to a deleted parent is refused.
- **A reply notifies the top-level comment's author** (D14,
  `problem_comment_reply`), never on a self-reply.
- **The keyset cursor is the walk position** (the last top-level row
  examined, not displayed), so an omitted tombstone never skips or repeats a
  comment across pages.

*Ruled by the implementer during the 2026-08-31 feature loop (f26 brief), no
human available to consult. Migration 0039.*


## D110 — A form that fails validation announces it and moves focus: the Focusable Error Summary

The register form already attributed each objection to its field
(`aria-describedby`, `aria-invalid`) — correct, but silent: a screen-reader
or keyboard user who pressed *Đăng ký* on an invalid form was told nothing
and left nowhere. Inline field errors are a *description* a reader only hears
if focus is already on that field, and a failed submit moved focus onto
nothing.

So a failed submit now raises a **Focusable Error Summary** at the top of the
form: `role="alert"` (the failure is announced), `tabIndex={-1}` and focused
programmatically (a keyboard reader lands on the list of problems), with each
item a link that puts focus on the field it names. It **complements** the
inline errors, never replaces them — the pattern's whole point is that a
reader gets both the overview and the per-field objection.

- **Focus moves once per failed attempt, never mid-typing.** `fieldErrors`
  changes only inside `handleSubmit` (editing a field touches `values`, not
  the errors), so an effect that focuses the summary whenever it is non-empty
  cannot steal focus while someone types. A `submitCount` bump on every
  attempt is what makes a *second* submit with the identical set of errors
  re-take focus — the errors object reference alone would not have changed.
- **The links carry a real `#field` fragment for a pointer AND an `onClick`
  that focuses the input.** A hash href alone does not move DOM focus (and
  jsdom does not act on it at all), so the handler is what actually carries a
  keyboard reader to the field.
- **Neutral chrome, not a verdict hue.** D67 reserves colour for verdicts and
  the rank ramp; the summary is an inset well with a hairline, so it stands
  out without borrowing a meaning it does not have.

Two catalogue keys (`auth.errorSummaryTitle`, vi+en) and the `.error-summary`
rule in `app.css`. The banner for an *unattributable* server refusal
(`setError`) is unchanged and stays a separate `role="alert"`.

*Ruled by the implementer during the 2026-08-31 a11y loop (b20 brief), no
human available to consult. `apps/web` only; no migration.*


## D111 — A submission diff is server-computed, both sources visibility-gated, and stores nothing

The submission page could show a viewer their own two attempts only as two
separate screens: no way to see what changed between a rejected try and the
fix. `GET /submissions/{id}/diff?against={otherId}` and
`GET /submissions/{id}/previous` add that, without a new table and without
shipping a diff library to the browser.

**The diff is computed in the API.** A plain LCS line diff
(`apps/api/src/submissions/line-diff.ts`), emitted as unified hunks
(`context`/`added`/`removed`). `@duckoj/similarity` was considered and does not
fit: it fingerprints k-grams to score *how alike* two files are (chống gian
lận, D77) and winnows away exactly the line-level alignment a diff needs — a
different question. The web renders the hunks and ships nothing.

**Both sources are gated by the SAME predicate the `source` field already
uses.** `diff` runs each id through `getVisible` and refuses (404) unless BOTH
come back with a non-null `source`. That single `source === null` check is
exactly the D23+D27 gate and not a coincidence: `maskHiddenSource` (D27) nulls
`source`, the freeze mask (D23) never touches `source`, and the source-hidden
set is a *superset* of the frozen set (same four escapes — ctx-null, owner,
admin, contest-creator — plus D27 covers the whole window, not just its last
minutes). So a masked-during-freeze contest submission is refused via the
source-null path already; a separate freeze check here would be redundant and
is deliberately omitted. This is why the route can never become a way to read a
rival's live contest source that D27 withholds — unlike the organiser-only
`/contests/{key}/similarity/{a}/{b}`, which D77 explicitly exempts.

**No storage, no cache.** The diff is cheap and recomputed per request; there
is nothing to invalidate. `previous` is one indexed `ORDER BY` and the diff is
two `getVisible` reads plus an in-memory LCS.

Three rulings made while building it, no human available to consult:

- **"Previous" is by id, not by clock.** `submissions.id` is the monotone
  order every other submission read pages on; `previous` returns the caller's
  own most-recent submission to the same problem with `id < {id}`, **same
  language preferred, falling back to any** (one `ORDER BY (language = base)
  DESC, id DESC LIMIT 1`).
- **A diff across two different problems is a 422 (`diff_problem_mismatch`),
  not a 404.** Both submissions are already visible to the caller, so comparing
  their problem codes leaks nothing — an honest "that's a mistake" beats
  another indistinguishable 404.
- **A DP size cap.** `GET /diff` is an unmetered read (only `POST /submissions`
  hits D80), and a source may be ≤64 KiB of one-character lines, so an
  unguarded O(n·m) LCS is an authenticated CPU/memory sink. Above
  `DIFF_MAX_DP_CELLS` (4M) the changed middle is emitted as a whole-file
  replace instead — the same shape of guard the similarity run uses
  (`similarity_too_large`).

Web: a "So sánh với lần nộp trước" toggle on `/submissions/{id}`, offered only
when the viewer can read this source and has an earlier own attempt. Each
added/removed line carries a +/− glyph as real text and an `.sr-only` label —
never colour alone (B-20/D77) — over a tint mixed from the verdict palette.
i18n vi+en; no migration.

*Ruled by the implementer during the 2026-08-31 feature loop (f27 brief), no
human available to consult.*

## D112 — A comment page honours the caller's limit; the replies on a page are fetched whole, and that is a province-scale bound

Found in the b21 comments cross-cut loop. `GET /problems/{code}/comments`
advertises `PaginationQuery` (`limit`, 1..100), and the controller parsed the
value and then dropped it: every page was a fixed 25 top-level threads
whatever the caller asked for. The fix passes `limit` through, defaulted to 25
and clamped to the schema's 100 in `pageLimit` — a caller may now ask for a
smaller page (a hot thread on a phone) or a larger one, never for an unbounded
one.

- **The ceiling on top-level rows is what bounds the reply fan-out.** A page's
  replies are fetched in ONE query for every parent on the page (never one
  query per parent), with no per-parent cap — a top-level comment with two
  hundred replies returns all two hundred. Bounding *that* would mean
  paginating replies and adding a "xem thêm phản hồi" affordance with its own
  cursor, which is a feature, not a fix. At province scale a thread is read by
  a class, the write path is metered at ten comments per user per hour, and
  the table is indexed by `parent_id`; the result set is small and the read is
  fast, exactly the D108 "unbounded but safe at province scale" family. The
  upgrade path, when a deployment outgrows it, is per-parent reply pagination
  keyed on the same `(parent_id, id)` index.

*Ruled by the implementer during the 2026-08-31 b21 loop, no human available
to consult. No migration; a bugfix plus a recorded bound.*


## D113 — "Is this person in this contest?" has one predicate, and a source-scan guard keeps it that way

The same bug was found three times. A read keys a `contest_participations` row
on `user_id = you` to answer "is this person IN this contest, what may they
see, count them" — and in a TEAM contest (D99) that row belongs only to the
captain, the member who pressed Join. Every other member competes on the SAME
row, so keyed on `user_id` the read silently excludes two thirds of every
team: B-18 was a 404 on the round's private problems for non-captains, B-19 a
monitor that named the captain, B-21 a spoiler thread and a broadcast that
reached captains alone. B-21 introduced `actingParticipationWhere` as the
correct clause — the actor's own row, OR one a team they are on holds.

- **One sanctioned predicate, exported.** `actingParticipationWhere`
  (`apps/api/src/authz/problem.visibility.ts`) is now the single "does this
  person compete here?" READ clause. It is deliberately NOT narrowed to
  current membership (unlike `actingParticipations`, the ACT-now resolver in
  `participation.ts`): a removed member may still re-read, and see on their
  own pages, the round they competed in. `apps/api/src/authz/progress.access.ts`
  `upcomingContests` — the last surviving `user_id` read of this family — now
  routes through it, so a non-captain's My-progress page lists the round they
  are sitting.
- **A source-scan guard, in the shape of `route-marker-coverage.spec.ts`.**
  `apps/api/test/team-participation-invariant.spec.ts` scans every non-spec
  source file for `contestParticipations.userId` and raw-SQL `part.user_id`
  participation reads. Each must be in the sanctioned module
  (`problem.visibility.ts` / `participation.ts`) or in the test's ALLOWLIST,
  keyed by `file::function` with the reason it is team-correct or genuinely
  individual-only. A NEW un-audited read fails the test and is told the two
  legal moves (route through the predicate, or add an audited entry); a
  removed one fails as a stale entry, so the allowlist stays an honest census
  of the seam. The class cannot silently return.
- **The allowlist is the census.** Team-aware already (`computeScoreboard`,
  `assertMembersFree`/`assertAddedMembersFree`, `broadcastRecipientsQuery`,
  `participantsOnline`, similarity `loadCandidates`, the team-join paths).
  Genuinely individual-only, correct as-is: `setDisqualified` (DQ of a named
  person, D37), `rankedFieldFor` (per-user Glicko-2; a team has no rating),
  `loadParticipantOrgs` (skipped for team contests), similarity
  `countParticipants` and `contest-stats` solver counts (one per participation
  = one per team, which is the unit). The submission FREEZE escape
  (`frozenSubmissionsWhere`) keys on `submissions.user_id` and stays
  individual: a teammate cannot read another member's contest submission at
  all today (`visibleSubmissionsWhere` has no team clause), so widening the
  freeze escape would be unobservable without first deciding whether teammates
  see each other's submissions mid-round — a product question, left open.

*Ruled by the implementer during the 2026-08-31 b22 team-seam loop, no human
available to consult. No migration; one bugfix, one exported predicate, one
guard test.*

## D116 — The theme is a manual light/dark/system choice, per device, applied before first paint

Until now the interface followed the OS alone (D67's
`@media (prefers-color-scheme: dark)`). A reader can now override it: a
three-way control — Sáng / Tối / Hệ thống (Light / Dark / System) — sets
`data-theme="light"|"dark"` on `<html>`; **System removes the attribute** and
hands the decision back to `prefers-color-scheme`.

**Per device, not per account — the deliberate opposite of D57.** Language and
time zone live on the account because a reader wants the same ones on every
machine they sign in from. A DISPLAY choice is the other way round: the phone
read in bed wants dark, the classroom projector wants light, and the same
account is behind both. So the theme lives in `localStorage['duckoj.theme']`
(try/catch on every access, so a locked-down webview still switches for the
page view it just cannot persist) and never touches the server. A signed-out
visitor can set it too.

**Defined once, applied by both triggers — no contrast regression.** `data-theme`
has to reach the SAME palette the media query already did, and the dark `--rte`
correction (D67) must not be made twice. So both `tokens.css` (material) and
`app.css` (verdict/syntax/rank) now hold the dark values ONCE as `--dark-*`
source aliases, and two thin trigger blocks — the OS media query and
`:root:where([data-theme="dark"])` — alias the live tokens to them. The bodies
are byte-identical (`test/app-css.spec.ts`-style guard), so the measured
D67/B-20 AA pairs hold in all three modes by construction. The attribute
triggers are wrapped in `:where()` on purpose: it keeps them at `:root`'s own
(0,1,0) specificity so the solid-twin collapse blocks (reduced-transparency,
`@supports not backdrop-filter`) still win on source order — a bare
`[data-theme="dark"]` would be (0,2,0) and would keep translucent glass for a
forced-dark reader who also asked to reduce transparency.

**Applied before first paint.** The `--bg` wash paints when the stylesheet
loads, before the deferred bundle runs, so a tiny blocking inline script in
`index.html` reads the key and sets the attribute — no light-then-dark flash.
`src/theme.tsx` owns the write side (a module store read through
`useSyncExternalStore`, so the nav control and the `/account/settings` control
agree instantly with no provider). The control is 44px, keyboard-reachable,
uses `role="group"` + `aria-pressed` (not colour), and is translated vi/en.

*Ruled by the implementer during the 2026-08-31 f28 loop, no human available
to consult. No migration: a stylesheet and a browser-local preference.*


## D117 — A team is one entity: members share visibility of their team's own contest submissions

Standard ICPC — one team submits as one competitor. D99 gave a team one
participation held by whichever member pressed Join; D101/D113 then made the
whole roster ACT and READ that participation everywhere except one place, which
loop-b22 recorded open in its own "Concerns": `visibleSubmissionsWhere` and the
freeze escape keyed on `submissions.user_id` alone, so a teammate could not see
another member's contest submission at all — not its verdict, not its source.
This closes that, scoped strictly to the same team's same-contest submissions.

**The rule.** A submission mapped (via `contest_submissions ⋈
contest_participations`) to a participation whose `team_id` is one the viewer is
a member of is visible to that viewer as if their own: they may LIST it, read
its verdict/points, and — extending D27's own-source rule to teammates — read
its SOURCE while the contest runs. It widens nobody else's visibility, and the
freeze (D23) still hides other TEAMS' late verdicts from this team exactly as
before.

- **One predicate, reused — no fourth idiom.** Every team clause routes through
  `actingParticipationWhere` (D113), the sanctioned participation-read
  predicate: `visibleSubmissionsWhere` gains `submissions.id IN (submissions of
  a participation I act on)`; the row twin `canViewSubmission` gains
  `viewerOwnsViaTeam`, loaded the same way, so the list and the detail 404 gate
  agree. The D113 source-scan guard stays green — the clause never writes
  `contest_participations.user_id` outside the sanctioned module.
- **The freeze escape is `IS NOT TRUE`, not `NOT (...)`.** A member's own team's
  submissions are never frozen from them. In SQL the conjunct is
  `(actingParticipationWhere) is not true`: the predicate is `user_id = me OR
  team_id IN (my teams)`, and for a stranger's INDIVIDUAL entry `team_id` is
  NULL, so once the viewer holds any team the `IN` is NULL, the OR is NULL, and
  a plain `NOT NULL` (= NULL) would drop the conjunct and unfreeze every
  stranger's late verdict. `IS NOT TRUE` maps NULL/FALSE to TRUE, so only a
  genuine team match stands the freeze down. Pinned by the two-forms agreement
  test and a discriminating case: a team member viewing an unrelated individual
  entrant's inside-freeze row stays frozen.
- **`GET /submissions?contest=` suffices; no `team=` filter added.** With the
  team clause in `visibleSubmissionsWhere`, a member filtering by the contest
  already sees the team's submissions. A separate `team=` param would be a
  second way to ask the same question — kept small on purpose.
- **The web names who submitted.** `SubmissionSummary` already carried
  `username`; `SubmissionDetail` gains it (a submission page is no longer only
  ever the viewer's own), and both gain `teamName`, so the list and the page
  render "nộp bởi <member> (đội <team>)" and a teammate can open a team
  submission.

*Ruled by the implementer during the 2026-08-31 f29 loop, no human available to
consult. No migration: two shared predicates widened, one display field added.*

## D118 — The contest header carries a live per-second countdown, as plain text

The contest page header already named the window and the phase; it did not say
how long is left. A reader watching for the gun had to subtract two timestamps
in their head, once a second. The header now counts down.

- **"Bắt đầu sau …" before, "kết thúc sau …" during, nothing after.** One line
  (`ContestCountdown`), which derives the phase from `now` on every tick, so
  the label flips from starts-in to ends-in at the start instant on its own and
  disappears once the end has passed — a finished round has nothing to count
  down to.
- **It is a leaf of its own, not state on the page.** The ticking `now` lives
  in the countdown component, so one second's tick re-renders only that line —
  never the problem table, the scoreboard link, or the join panel above it. The
  `setInterval` is cleared on unmount. Every existing `ContestPage` test keeps
  passing with the line mounted.
- **Plain text — no live region, no animation.** `role="timer"`, deliberately
  NOT `role="status"`/`aria-live`: a clock read aloud every second is a screen
  reader nobody can use. There is no CSS transition, so it is
  `prefers-reduced-motion`-safe by construction rather than by a media query.
- **The number is locale-neutral `HH:MM:SS`.** `formatCountdown` (in
  `format.ts`, beside `formatPoints`) is zero-padded digits and colons — the
  same in vi and en, so it takes no locale — with hours UNcapped (a contest
  days away reads `72:00:15` rather than losing the days) and a past/non-finite
  input clamped to `00:00:00`, so the clock never prints a minus sign. Only the
  two label strings (`contest.startsIn`/`contest.endsIn`) are translated.

*Ruled by the implementer during the 2026-08-31 f30 loop, no human available to
consult. Web-only: one leaf component, one display helper, two i18n keys.*

## D119 — A team is one entity: members share their team's private clarifications

D117 made a team's contest submissions the whole roster's to read. The
clarification feed had the same seam: `list()` filtered `visibility = 'public'
OR askedBy = me` — team-blind. So when a member asked a private question and the
organiser answered it per-team without publishing to the room, only the one
member who typed it could read the reply, while the notification set
`broadcastRecipientsQuery` already unioned the whole squad (D99×D14) — the
notification promised the team a reply the read endpoint then hid.

- **The read twin of the recipient set.** `list()` now also matches `askedBy IN
  (teammates in this contest)` via `teammatesInThisContest`, two `team_members`
  joins onto the contest's participations: one pins a participation to a team
  the caller is on, the other enumerates that team's roster. Uncorrelated
  (evaluated once for the whole query, not per row), and empty for an individual
  round — the participation's `team_id` is NULL there, so the first join matches
  nothing and individual contests are untouched.
- **No cross-contest or rival leak.** The subquery is scoped to participations
  in THIS contest, so it never reaches a team's clarifications in another
  contest, and a rival — on no team the caller shares — matches nobody. The
  organiser/`canRunContest` path is unchanged; this only widens what a
  competitor may read of their own team.

*Ruled by the implementer during the 2026-08-31 B-24 rehearsal loop, no human
available to consult; found on the live stack. Recorded retroactively during the
B-26 review (commit `8cc07fb` cited D119 with no ledger entry). No migration:
one read predicate widened.*

## D120 — index.html's pre-paint theme script is allowed by its exact CSP hash, never by 'unsafe-inline'

D116 added a blocking inline `<script>` to `apps/web/index.html` that sets
`data-theme` before first paint (no dark-mode flash). The Caddy CSP was
`script-src 'self'` with no hash or nonce — written earlier, its comment still
claiming the Vite build emits no inline scripts. The two never met in a browser:
the inline script is blocked on EVERY page, logging a CSP violation and giving
dark-mode users a light flash, and the whole Playwright browser suite went red
against the live stack (the shipped smoke spec failed identically).

- **The script's sha256 in `script-src`, not `'unsafe-inline'`.** Adding the
  one script's exact hash keeps every OTHER inline script refused — an injected
  `<script>` still cannot run. The concession is one known script, not a door.
- **Pinned so source and CSP cannot silently diverge.** `security-headers.spec.ts`
  computes the hash from `index.html` and asserts it is in the CSP. B-26 added
  the built-artefact half `scripts/verify-csp-hash.ts` (run after `vite build`
  in `verify` and CI): the unit test hashes the SOURCE, but Caddy serves the
  BUILT `dist/index.html`, and a Vite transform of the inline script would move
  the served hash while the source test stayed green — the drift guard hashes
  every inline script in the built file against the Caddyfile.

*Ruled by the implementer during the 2026-08-31 B-24 rehearsal loop, no human
available to consult; found on the live stack. Recorded retroactively during the
B-26 review (commit `dd82d89` cited D120 with no ledger entry). No migration:
one CSP directive and its guards. (D121 was pre-allocated in the B-24 dispatch
note's "D119–D121" range but never became a ruling — no commit cites it.)*

## D121 — A print stylesheet turns the scoreboard, a problem and the submissions list into clean paper

A teacher prints from the browser: a finished contest's standings pinned to a
wall, a problem statement handed to a room, a submissions list checked off.
This is NOT D71 (results/certificates are server-rendered PDFs the organiser
downloads) — this is Ctrl-P on the on-screen page, which until now printed the
floating glass chrome, the theme's dark ground and half-clipped tables.

- **One `@media print` block, extended from D61's.** The credential sheet
  already had a print block; D121 widens it rather than adding a second. It
  hides the shell (`.shell-nav`, `.nav-sheet-layer`), the escape-hatch
  `.no-print`, and every interactive control (`form`, `.field`, `label`,
  `button`, `input`, `select`, `textarea`) — `summary`/`details` stay, so an
  opened editorial prints.
- **A LIGHT palette is forced by redefining the colour/material tokens on
  `:root` inside the print block**, not by an !important per element: the block
  is last in the file and `:root` is (0,1,0), so it beats both dark-theme
  triggers by source order. A dark-mode teacher gets ink on white, not white
  on white. Only tokens `tokens.css` already declares are named
  (`test/app-css.spec.ts` fails on any other).
- **Tables survive a page break**: `thead { display: table-header-group }`
  repeats the header atop each page and `tr { break-inside: avoid }` stops a
  row splitting. The phone rule (`@media max-width:700px`) turns a `<table>`
  into a block scroll-container and FIRES in print — an A4 page minus margins
  is ~680px, under the 700px breakpoint — so it is undone with
  `table { display: table !important; overflow: visible !important }`, without
  which columns clip off the right edge.
- **A print-only header names the page** (`.print-only`, shown on paper only):
  the contest/problem name plus the date, so a stack of scoreboards is not
  anonymous — the scoreboard's own h1 is the generic "Bảng điểm". One i18n key
  (`print.printedOn`, in both catalogues). The date is the render-time value,
  not a print-time one — no JS behaviour change.
- **Rulings.** Verdict badges print black (`.badge { color:#000 }`) — D67
  guarantees a glyph beside every hue, so a monochrome badge still reads.
  Link URLs are suppressed, not printed after the text (every entity is a
  hyperlink; a scoreboard of printed URLs is noise). Consequences: the
  submissions list prints only the rows already loaded ("Load more" is a
  hidden button), and the scoreboard's organiser DQ column prints as an empty
  cell. `@page { margin: 12mm }` sets A4-friendly margins WITHOUT `size`, so
  the reader's own paper choice stands.
- **The e2e proof is on the scoreboard** (`e2e/contest-day.spec.ts`):
  `emulateMedia({media:'print'})`, assert `nav.shell-nav` computes
  `display:none`, restore. jsdom never matches `@media print`, so the vitest
  assertions read the block as text — only a real browser proves it applied.

*Ruled by the implementer during the 2026-08-31 f31 loop, no human available to
consult. Web-only: one CSS block, three print-only headers, one i18n key. No
migration — nothing persists a stylesheet.*


## D122 — Default avatars are deterministic initials, computed on the client, never stored

D9 deferred avatars: `users.avatar_key` exists, nothing writes it, and no URL
scheme resolves it, so returning it would hand out a key nobody can
dereference. D122 gives everyone a default avatar anyway, WITHOUT lifting any
of that — an image upload stays deferred. The default is not an image at all:
it is 1–2 initials on a colour, computed from the one name already on screen
beside the person. Because it is a pure function of that string it needs no
DTO field, no endpoint, no storage and no migration — which is exactly why it
can ship where D9's `avatar_key` still cannot.

`<Avatar name size? label?/>` (`apps/web/src/avatar.tsx`), placed beside the
name in the nav (own name, desktop bar + phone sheet), the profile header,
scoreboard participant rows (the TEAM's name for a team row — a team is one
participant, D99), problem-page comment authors (F-26), and the submission
submitter.

- **Initials are graphemes, NFC first.** The first grapheme of the first name
  part and of the LAST part, upper-cased with `toLocaleUpperCase`: "Trần Hưng
  Đạo" → "TĐ", "đỗ quyên" → "ĐQ" (Đ/đ is one Vietnamese letter, not a
  stripped ASCII d), a single token → one letter, an empty or nullish name →
  "?". `Intl.Segmenter` groups a base letter with its marks; `Array.from` is
  the code-point fallback.
- **The colour is a fixed function of the name — and THE RECIPE IS THE
  DECISION.** FNV-1a over the NFC-normalised, trimmed, lower-cased name picks a
  hue; saturation and lightness are fixed at `hsl(hue 65% 25%)`. Lower-casing
  and normalising so a name colours the same however it is typed or composed.
  Changing this recipe recolours every avatar in the app, so it is recorded
  here rather than left as a tweakable constant.
- **The 25% lightness is a contrast constraint, not a taste call.** It keeps
  every hue's relative luminance below the ~0.17–0.21 band where NEITHER a
  near-white nor a near-ink foreground can reach AA. The foreground is then
  picked per background by measured contrast (near-white `#f8fafc` /
  near-ink `#111318`, whichever is higher). A 360-hue sweep test holds the
  chosen pair at ≥ 4.5:1 for every possible hue; the worst is **5.52:1** at
  h=60 (`rgb(104, 105, 22)` on near-white), and it is **theme-independent** —
  the initials/background pair is self-contained, so it is identical in the
  light and dark themes rather than depending on the ground behind the chip.
  That is the honest answer to "AA in both themes": the same measured pair
  holds in both by construction.
- **Solid fill, never glass.** No `--glass-*` token and no `backdrop-filter`:
  the chip renders once per scoreboard row, and D67 names a per-row backdrop
  filter the single most expensive thing this app could composite. A hairline
  `--line` border is all the depth it gets, separating a dark-hued chip from a
  dark ground. Nothing animates, so `prefers-reduced-motion` has nothing to
  flatten.
- **Semantics.** Decorative by default (`aria-hidden`) because every placement
  sits it beside the very name it is drawn from — so a screen reader reads the
  name once and accessible names are unchanged. `label` present → `role="img"`
  with that name, for a future standalone use.
- **Ruling.** The component tolerates a nullish name (falls back to "?") so one
  missing name can never crash a page carrying many avatars.

*Ruled by the implementer during the 2026-08-31 f32 loop, no human available to
consult. Web-only + this ledger: one component, one CSS block, five call
sites, no i18n key (every placement is decorative), no migration — nothing
persists an avatar. Supersedes D9's deferral for the DEFAULT case only; an
uploaded image stays deferred.*

## D123 — A readable submission source carries client-only copy and download tools

The submission detail page (`/submissions/$id`) shows the source verbatim to
anyone who may read it — its submitter, a teammate (D117), the contest's
creator, an admin, or under a problem's `source_access` (D27) — and until now
that source could only be selected by hand. D123 adds two controls beside it:
**Sao chép** copies the source to the clipboard, and **Tải xuống** downloads
it as a file. Both act only on source already on the page — no request leaves
the browser, no new route, no server round-trip, no stored state.

**Gated on the readable source, reusing one predicate.** The tools render
only when `sourceVisible` — `!sourceHidden && source !== null`, the same
variable D111's diff toggle already keys on. A masked (D27) or absent source
shows neither tool: there is nothing to copy or download.

- **Copy reuses the recovery-codes pattern (D72/security.tsx).**
  `navigator.clipboard.writeText(source)` inside one try/catch: the clipboard
  is absent over plain HTTP and in some embedded browsers, where even reading
  `.writeText` throws — caught the same as a rejected write. Success shows a
  persistent `role="status"` "Đã sao chép" confirmation (a live region, so a
  screen reader is told it worked — WCAG 4.1.3); failure shows a graceful
  `role="alert"` fallback telling the reader to select and copy by hand. The
  source stays on screen either way, so a failure is never a lost result.
- **Download is a Blob + object URL, revoked immediately.** A `text/plain`
  Blob, an object URL, a synthesised `<a download>` clicked once, then
  `URL.revokeObjectURL` in a `finally` so the handle never outlives the click.
- **The extension maps from `languageKey`, by exact key.** `cpp17`→`cpp`,
  `py3`→`py`, `java`→`java`, everything else→`txt`; the filename is
  `submission-<id>.<ext>`. Exact keys, not a prefix match: a future `cpp20`
  is its own decision, not a silent inheritance.

Both controls are plain `<button>`s — already 44px tap targets and keyboard
reachable from app.css — with vi/en labels (D18). Four i18n keys, no
`prefers-reduced-motion` surface (no animation).

*Ruled by the implementer during the 2026-08-31 f33 loop, no human available
to consult. Web-only + this ledger: two buttons and four i18n keys on one
existing page, no DTO field, no endpoint, no migration — the source the tools
act on is already in the page's DTO.*

## D124 — The api/judged image builds skip lifecycle scripts and drop the ssh2 native chain, because ssh2 is a test-only devDep (via testcontainers), not MCP's

`scripts/deploy.sh api judged` intermittently failed at the image build's
`pnpm install --frozen-lockfile` with `ssh2 … gyp ERR! find Python` /
`cpu-features: Unable to detect compiler type`. `ssh2` and `cpu-features` are
OPTIONAL native deps whose install-time `node-gyp` rebuild has no Python or
C toolchain in the `node:22-alpine` deps stage, so on a bad day the build died.

**Corrected provenance (the B29 brief's premise was wrong).** These deps do
NOT come from `apps/mcp`. `@modelcontextprotocol/sdk@1.30.0`'s dependency block
in `pnpm-lock.yaml` lists express/hono/ajv/… and **no ssh2**. `ssh2`'s only
dependant in the whole lockfile is `ssh-remote-port-forward`, whose only
dependant is `testcontainers`, which enters through `@testcontainers/postgresql`
— a **devDependency of `apps/api`, `apps/judged` AND `packages/db`**. So the
image pulls ssh2 through its own test harness, and `apps/mcp` is exonerated;
the deps stage never even copies mcp's manifest.

**The fix (Dockerfile-only, both images).**
1. Deps stage installs with `--ignore-scripts`. Nothing either image needs runs
   a lifecycle script: `tsc` is pure JS, and `@node-rs/argon2` + `esbuild`
   (which `tsx` spawns) ship their platform binaries AS prebuilt
   `optionalDependencies`, not as script outputs — verified `tsx --version` and
   an `@node-rs/argon2` import both work in the built image. This kills the
   flake at its exact mechanism, and covers any *future* native devDep too.
2. Build stage, AFTER the compile (the typecheck's test half type-references
   testcontainers), `rm -rf` the `ssh2@*`, `ssh-remote-port-forward@*`,
   `cpu-features@*`, `@types+ssh2@*`, `@types+ssh2-streams@*` dirs from
   `node_modules/.pnpm`, so the wholesale `COPY --from=build /app /app` runtime
   stage carries no ssh2 at all (`ls node_modules/.pnpm | grep -c ssh2` → 0 in
   both final images). The inert `nan`/`buildcheck` JS orphans are left as-is.

**Three remedies rejected.**
- *Filter out `apps/mcp`* (the brief's "preferred") — wrong premise; mcp is not
  the source and is not in the build context, so filtering changes nothing.
- *`pnpm deploy --prod` / `pnpm install --prod`* — `docker-compose.yml`'s
  `migrate` service hardcodes `packages/db/node_modules/.bin/tsx scripts/
  migrate.ts`, and `tsx` is a `packages/db` **devDependency**; any `--prod`
  prune deletes it and breaks migrate (the migrate image is built from
  `apps/api/Dockerfile`). Keeping the full install + `--ignore-scripts`
  preserves the tsx/migrate path untouched.
- *`ENV npm_config_optional=false` / `--no-optional`* (the brief's "belt") —
  `@node-rs/argon2` and `esbuild` deliver their platform binaries THROUGH
  optionalDependencies; disabling optionals yields an image that builds green
  and then fails at boot/migrate. Rejected outright.

The lockfile is untouched (ssh2 stays — it is legitimately testcontainers');
`apps/mcp` is untouched; the typst stage and the tsx/migrate path are untouched.
Proof is the image build, not vitest (Dockerfiles carry no unit tests): before
= `grep -c ssh2` 4 with a live `gyp ERR!` in the deps log; after = 0 in both
images, both boot to a DB/Redis-connect failure (not a module error).

*Ruled by the implementer during the 2026-08-31 B29 image-hardening loop, no
human available. Build/ops decision in the shape of D85/D86; see
`docs/superpowers/briefs/loop-b29-image-hardening-report.md`.*

## D125 — The problem list gains a per-viewer status filter, window-gated like the solved counter

`GET /problems` gains `status = solved | attempted | unsolved`, and every list
row (and the detail) now carries `myStatus: 'solved' | 'attempted' | null` for
a ✓/… marker. Both are per-viewer and read the viewer's OWN submissions —
never anyone else's — so the freeze (D23) has nothing of theirs to mask.

- **"solved" is window-gated, exactly as D49's `solvedCount` is.** An `AC`
  made inside a still-open contest window does not count as solved until the
  window closes — reusing `contestWindowOpenWhere`, the same D49 predicate the
  public counter filters by, so the marker flips at the very instant the
  viewer joins `solvedCount`. This is deliberately NOT `me.verdict`: `me` is
  "your verdict, yours the moment it grades" (D23), so a live-contest row can
  read `me.verdict === 'AC'` beside `myStatus: 'attempted'` with no
  contradiction — the personal fact and the catalogue status answer two
  different questions. An in-window `AC` is still a submission, so it reads
  **attempted**, not unsolved, meanwhile.
- **`myStatus` is folded from the two `me` laterals, not a third idiom.** A
  second `LEFT JOIN LATERAL` (`me_solved`) answers one boolean — does the
  viewer hold a closed-window `AC`? — beside the existing best-verdict lateral,
  in the SAME single statement (no N+1; pinned by a one-statement query-log
  test). The solved signal cannot be read off the best row: an in-window `AC`
  is the best row yet does not count, so it needs its own existence probe.
  `me_solved` keys on `submissions.user_id`, never
  `contest_participations.user_id`, so the D113 source-scan guard stays green.
- **Anonymous callers get 422 `status_requires_auth`, never a silent ignore.**
  `GET /problems` is `@Public()`, but a silently-ignored `?status=solved` would
  answer with problems the caller has not solved — a wrong 200. Refusing it is
  the honest answer; `myStatus` itself stays `null` for an anonymous caller,
  mirroring `me`. **In-flight-only submissions read unsolved**, mirroring `me`'s
  graded-only lateral: a queued submission is not yet a status, as it is not
  yet a `me`.
- **`status` does NOT widen the D35 hidden-problem exclusion.** That exclusion
  exists because `tag`/`difficulty` filter over the MASKED hint and would
  otherwise be an oracle for it; `myStatus` reads the viewer's own submissions,
  which D35 never masks, so a status-only filter keeps listing a hidden problem
  (blanked), exactly as an unfiltered page does. `tag`/`difficulty` keep their
  exclusion when composed with `status`.
- **Web.** A `<select>` in the filter bar, shown only to a signed-in reader
  (the API answers 422 otherwise), wired to the URL via `validateSearch` like
  the topic/difficulty filters — an unknown value is dropped, not passed on.
  The row marker is a glyph (✓/…) with an `aria-label`, never colour alone
  (B-20/D77); vi/en throughout.

*Ruled by the implementer during the 2026-08-31 f34 loop, no human available
to consult. No migration: two DTO fields, one query param, two SQL laterals
reusing existing predicates, and the web wiring.*


## D126 — A contest anybody entered cannot be deleted, and a problem's current revision must be a revision of that problem

B-31's data-integrity sweep enumerated every foreign key in the schema (67 before this
migration, 68 after) against a real migrated database and found two `ON DELETE` rules that did not say what the
repo believed they said. Migration **0040** repairs both.

- **Migration 0016's RESTRICT was reachable AROUND, not through.** It made
  `contest_submissions.contest_problem_id` `ON DELETE restrict` so "a contest
  submission's link to its contest problem must never vanish silently". But
  `contest_participations.contest_id` cascaded from `contests`, and
  `contest_submissions.participation_id` cascades from the participation — so
  `DELETE FROM contests` walked the second path, removed the children, and the
  restrict on the first was evaluated against nothing. Measured on a throwaway
  database: `DELETE 1`, `contest_submissions` left = **0**. Worse, whether the
  restrict fires at all depended on the ORDER Postgres created the referential
  triggers, i.e. on which migration last rewrote which constraint — a
  guarantee that turns on migration history is not a guarantee. So
  `contest_participations.contest_id` is now `restrict`: a contest anybody
  entered is history (D11) and is refused, loudly. **A contest nobody entered
  still deletes** — the mistyped one an organiser wants gone has no
  participations by definition. Nothing in the app deletes a contest today;
  this is about the psql session during an incident and about the endpoint
  somebody adds later.
- **`problems.current_revision_id` carried no foreign key at all** — the only
  id column in the schema without one — and it is the column that decides
  which package grades a submission: `SubmissionAccessService.create` loads
  the revision by this id alone and never re-checks whose problem it belongs
  to, so a crossed pointer would grade one problem's submissions against
  another problem's tests, silently and forever. The new key is **composite**,
  `(id, current_revision_id) REFERENCES problem_revisions (problem_id, id)`,
  because "some revision exists" is not the fact worth stating. `MATCH SIMPLE`
  leaves a NULL — a problem with no published revision — unconstrained, which
  is the intended state, and `NO ACTION` rather than `RESTRICT` so deleting a
  problem (which cascades its revisions in the same statement) still works.
  It is hand-written in the migration because drizzle cannot express it:
  `problems`' table config runs before `problemRevisions` exists, so naming
  those columns is a temporal-dead-zone error. drizzle-kit diffs the snapshot
  against the schema file, so a constraint in neither is invisible to it and
  will not be dropped by a later `generate`;
  `packages/db/test/referential-integrity.spec.ts` is where it is pinned.
- **The whole foreign-key map and every uniqueness rule are now one literal
  each in that spec**, asserted against `pg_constraint` and `pg_get_indexdef`.
  An `ON DELETE` is a decision about history and should not be possible to
  change by accident in a schema file.
- **`scripts/integrity-check.ts` is the standing audit** for what no key can
  state — a seat's participation is for the seat's own contest, a cached
  counter equals the aggregate it caches (the D100 reconcile), a solver
  actually has an `AC`, an id buried in jsonb still resolves. 23 checks, one
  list, two transports: a `DATABASE_URL` for tests and CI, and
  `--live` through `podman exec … psql` because the deployed Postgres
  publishes no host port. Both run read-only, enforced by
  `default_transaction_read_only` rather than promised in a comment. Exit 0
  clean, 1 violations, 2 could not run. Run against the live province
  database on 2026-08-31 (333 users, 714 submissions, 192 seats, 104 counter
  rows): **23/23 clean**, which is the first end-to-end evidence that B-28's
  counter-drift fix holds in production and that no seat has drifted since
  D104 shipped.

*Ruled by the implementer during the 2026-08-31 B-31 loop, no human available
to consult. Migration 0040.*
