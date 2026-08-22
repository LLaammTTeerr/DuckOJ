# Phase 3f — Email, password reset and verification: ledger

**Spec:** `docs/superpowers/specs/2026-08-22-phase-3f-email-design.md`
**Decisions:** D1, D2.

**Result:** 750 tests green (was 743). Migration `0013`. A forgotten password is
now recoverable without database access.

---

## R1 — one transport, because Resend speaks SMTP

D1 allowed "Resend or plain SMTP". Resend publishes SMTP credentials
(`smtp.resend.com`), so **one SMTP implementation satisfies both** and the
provider is configuration rather than code. No vendor SDK was added; nothing in
the codebase names Resend.

## R2 — `LogMailer` is the default, and that is deliberate

With no `SMTP_HOST`, mail is logged rather than sent. A developer must not have
to stand up a mail server to register a user, and neither must a test.

What would be unacceptable is silently dropping mail in production, so the
transport announces itself at boot (`warn` for the log transport) and **`readyz`
reports which one is live**. Reported, not asserted: `log` is a correct
configuration for a dev stack and a broken one for production, and only an
operator can tell which they are running.

## R3 — the single-table shape, and the bug it makes possible

`one_time_tokens` carries a `purpose` column rather than existing as two
tables. Expiry, hashing and single-use redemption are identical for both
purposes, and duplicating them three lines at a time is how they drift.

**The cost is that every redemption must filter on `purpose` as well as on the
hash.** A redemption that filters on the hash alone passes every happy path and
lets a verification link set a password. That is the one bug this shape makes
possible, so it has its own test in both directions — and mutating the
`purpose` clause out reddens exactly it.

Two tables would have made the bug impossible. The trade was made knowingly.

## R4 — four rules, each a known way this goes wrong

- **Only the hash is stored.** A database leak must not hand over working reset
  links. Asserted by comparing the stored column against the token from the
  mail, not merely by checking it looks like a hash.
- **Single use**, marked inside the same transaction as the effect. A link that
  works twice works after the account is back in its owner's hands.
- **Short expiry** — one hour for a reset, twenty-four for a verification. A
  reset is a live rescue; a verification is a chore someone does later.
- **Redeeming a reset ends every session for that user.** This is the point of
  a reset: the plausible reason someone is resetting is that somebody else is
  signed in as them. The test proves the session was live *before* the reset,
  so its death afterwards is attributable to the reset and not to the fixture.

## R5 — no user enumeration

`forgot` answers **202 for every syntactically valid address**. The test asserts
the two responses are byte-identical, not merely both 2xx — any difference makes
the endpoint a membership oracle for an email list.

Timing is **not** equalised. The database lookup is not the dominant cost and a
plausible attacker learns more from a response body; recorded as a deliberate
gap rather than an oversight.

## R6 — a `null`-versus-`undefined` bug my own types should have caught

The mailer factory read `config.smtp === null ? log : smtp`. The test harness
builds `AppConfig` by hand and simply had no `smtp` field, so the value was
`undefined`, the comparison was false, and **every auth test failed at boot**
constructing an SMTP transport with no host.

`AppConfig` types the field as `… | null`, so this should have been a compile
error. It was not, because `apps/api/tsconfig.json` includes only `src` — the
test directory is linted but never typechecked.

Fixed both ways: the harness now sets `smtp: null` explicitly, and the factory
tests falsiness rather than `=== null`, because a config assembled by hand (a
harness, a script) can always leave a field off.

**The untypechecked test directory is a real gap** and is left as a finding
rather than fixed here — turning it on will surface unrelated errors and
belongs in its own change.

## R7 — a global module still has to appear in the graph once

`MailModule` is `@Global()`, which made me expect it to be reachable
everywhere. It is not: three suites build their own testing modules, and adding
a mailer dependency to `AuthnModule` and `HealthController` broke all three —
14 tests.

`health.spec.ts` gets a stub rather than the module, because that suite
deliberately builds the controller with fakes so `readyz` can be driven into
failure.

## R8 — mutation evidence

| Mutation | Result |
|---|---|
| M1 redemption ignores `purpose` | 1 fail — the cross-purpose test |
| M2 a used token can be reused | 1 fail |
| M3 expiry ignored | 1 fail |
| M4 reset leaves sessions alive | 1 fail |
| M5 plaintext token stored | 4 fail |
| M6 `forgot` reveals whether an account exists | 1 fail |

Six for six, first attempt — the first phase this session where no mutation
exposed a hole in my own tests.

## Deferred

**Nothing is gated on verification.** `email_verified_at` is set and reported on
`GET /auth/me`, and no route refuses an unverified user. Turning that on
retroactively would lock out every existing account, so the flag exists for a
later phase to decide what to gate.

**No rate limiting.** Nothing stops a caller requesting a thousand resets for
one address. Each token is independent, so this is a mail-volume problem rather
than a security one — recorded as a gap.

**No notifications.** A user whose organization join request is decided still
finds out by looking. The transport now exists; the notification model does not.
