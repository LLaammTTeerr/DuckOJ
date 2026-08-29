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
