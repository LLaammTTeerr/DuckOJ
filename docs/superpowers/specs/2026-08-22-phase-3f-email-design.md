# Phase 3f — Email, password reset and address verification: design

**Status:** approved for implementation.
**Decisions:** D1 (SMTP), D2 (email first).

---

## 1. What this phase is

There is **no email subsystem at all** — no sending code anywhere in the
repository. Three consequences, in order of severity:

1. **A forgotten password is unrecoverable** without direct database access.
2. Addresses are never verified, so a typo at registration is permanent and a
   password reset would deliver to a stranger.
3. Nothing can ever be told to a user who is not looking at the site.

This phase fixes 1 and 2, and gives 3 somewhere to live.

## 2. One transport, because Resend speaks SMTP

D1 allowed Resend or plain SMTP. Resend publishes SMTP credentials
(`smtp.resend.com`), so **one SMTP implementation satisfies both** and the
provider becomes configuration rather than code. No provider SDK is added.

```ts
interface Mailer { send(message: OutboundEmail): Promise<void> }
```

Two implementations:

- **`SmtpMailer`** — production, over `nodemailer`.
- **`LogMailer`** — used when no SMTP host is configured. It logs the message
  and its link at `info`.

**`LogMailer` is the default, not an error.** A developer running the stack
must not have to stand up a mail server to register a user, and a test must not
either. What is *not* acceptable is silently dropping mail in production, so
the mailer logs which implementation it is at boot, and `readyz` reports it.

## 3. Tokens

```sql
one_time_tokens(id, user_id, purpose, token_hash, expires_at, used_at, created_at,
                UNIQUE (token_hash))
purpose ∈ {password_reset, email_verification}
```

Four rules, each of which is a known way this goes wrong:

**Only the hash is stored.** `sha256` of the token. A database leak must not
hand over working reset links, and there is no reason to be able to read one
back — nothing legitimately needs the plaintext after it is sent.

**Single use.** `used_at` is set on redemption, inside the same transaction as
the effect. A reset link that works twice is a reset link that works after the
account is back in its owner's hands.

**Short expiry.** One hour for a reset, twenty-four for a verification. A reset
is a live rescue; a verification is a chore someone does later.

**Redeeming a password reset invalidates every session for that user.** This is
the whole point of a reset — the plausible reason someone is resetting is that
somebody else is signed in as them.

## 4. No user enumeration

`POST /auth/password/forgot` answers **202 for every syntactically valid
address**, whether or not an account exists. Anything else turns the endpoint
into a membership oracle for an email list.

The same rule applies to timing only loosely — this phase does not attempt
constant-time behaviour, because the database lookup is not the dominant cost
and a plausible attacker learns more from the response body. Recorded so the
gap is deliberate rather than overlooked.

## 5. Endpoints

```
POST /auth/password/forgot   @Public   { email }             → 202 always
POST /auth/password/reset    @Public   { token, password }   → 200
POST /auth/email/verify/send  session                        → 202
POST /auth/email/verify      @Public   { token }             → 200
```

`GET /auth/me` gains `emailVerified`. `users` gains `email_verified_at`.

**Verification is not enforced anywhere.** Nothing yet refuses an unverified
user, because turning that on retroactively locks out every existing account.
The flag exists so a later phase can decide what to gate on it.

## 6. What the emails say

Plain text, no HTML, no images, no tracking. A reset mail contains one link to
`PUBLIC_ORIGIN` and says how long it lasts. There are no templates and no
template engine — two messages do not justify one.

## 7. Testing

1. **`forgot` answers 202 for an unknown address** and for a known one, and the
   two responses are byte-identical.
2. **A reset token works exactly once**; the second attempt is 400.
3. **An expired token is refused**, tested by writing `expires_at` into the past
   rather than by waiting.
4. **A token for the wrong purpose is refused** — a verification token must not
   reset a password. Tested explicitly, because both live in one table and the
   only thing separating them is a `WHERE` clause.
5. **Redeeming a reset ends every existing session**: a cookie that worked
   before the reset 401s after it.
6. **The stored value is not the token** — assert the database column does not
   contain the plaintext.
7. **`LogMailer` is used when no host is configured**, and the recorded message
   contains a link the test can then redeem end to end.
8. **Verification marks the address and shows on `GET /auth/me`.**
9. Every new test demonstrated to fail against unfixed code.

## 8. Risks

**Test 4 is the one most likely to pass against a wrong implementation.** With
one table and two purposes, a redemption that filters only on the token hash
works perfectly for every happy path and lets a verification link set a
password. It needs its own test and it is the reason `purpose` is a column
rather than two tables — two tables would make the bug impossible, but would
duplicate expiry, hashing and single-use logic three lines at a time.

**Rate limiting is out of scope.** Nothing stops a caller requesting a thousand
resets for one address, which is a mail-volume problem rather than a security
one, since each token is independent. Recorded as a gap, not solved here.
