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

## D6 — Rank titles are a placeholder behind an adapter

Deferred as a product decision, with a working placeholder in the meantime,
modelled on **Codeforces or chess.com**.

Implemented as a pure band table behind one function, so replacing the names
and thresholds is a data edit rather than a code change.

Partially closes foundation §15 question 1 — the *thresholds and names* remain
open; the mechanism does not.

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

- **Rank title names and thresholds** (D6 covers only the mechanism).
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
names, org names, usernames, and the `packages/glicko2` rank-band titles
(D6).

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
