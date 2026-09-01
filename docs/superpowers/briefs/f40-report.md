# F-40 report — Mail is real, or the province is told it is not

**Status: complete.** Four commits, not pushed. Nothing was deployed and the
live database was not written.

## Where the brief was right, and where it was already fixed

Checked before implementing, as asked.

| Claim | Verdict |
| --- | --- |
| `docker-compose.yml` passes no `SMTP_*` into `api` | **True.** Not one of the six. |
| `.env.example` may disagree with the code | **Worse than disagreeing** — it named none of the six at all. |
| Nothing logs the transport at boot | **Wrong.** `LogMailer`'s constructor has always warned `mail transport: log — no SMTP_HOST configured, mail will not be delivered`, and the live `duckoj_api_1` prints it once per worker. The brief calls this "the single highest-value line in the slot"; it already existed at `531119c`. Left alone. |
| The health endpoint does not report mail | **Wrong.** `GET /readyz` has always answered `{status, database, mail: 'smtp'\|'log'}`. What was missing was a test — no spec asserted the field, which is how a field quietly stops being sent. `health.spec.ts` now pins it. |

The names the config module actually reads, confirmed against
`apps/api/src/config/config.schema.ts`: `SMTP_HOST`, `SMTP_PORT` (default
587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` (`'true'`/`'false'`,
default false), `MAIL_FROM` (default `DuckOJ <no-reply@duckoj.local>`).

## The thing the brief could not have known

Passing the variables through is not two lines of YAML. **Compose cannot omit
a variable conditionally.** The file's own convention (`WS_EXTRA_ORIGINS:
${WS_EXTRA_ORIGINS:-}`) renders an unset variable as the *empty string*, so a
naive wiring hands the container `SMTP_HOST=`, `SMTP_PORT=`, `SMTP_SECURE=`
— which the schema reads as a zero-length host failing `.min(1)`, a port
coercing to `0` and failing `.min(1)`, and a value outside an enum. Three
refusals, one boot crash, **in production**, on any stack whose `.env` says
nothing about mail. Verified with `podman-compose config`, which renders
exactly `SMTP_HOST: ''`.

So `unsetWhenBlank` states the rule once, in the schema: a variable that is
present and empty means what an absent one means. Defaults stay in the schema
rather than being repeated inside `${VAR:-default}`.

## What shipped

1. **The wiring.** All six variables into `api` only (`judged`, `judge` and
   `migrate` untouched), by reference, never a literal — the file is
   committed and `SMTP_PASSWORD` is a credential. `.env.example` gained a
   documented block with placeholder values.
2. **Boot.** Already correct; left as it was, and reported above.
3. **Health.** Already correct; the field is now asserted, with a transport
   whose `send` throws so a 200 is itself proof `readyz` dialled nothing.
   `deploy.sh` reads neither `readyz` nor `healthz`'s new anything — the
   `/healthz` body is byte-identical and `service_builds`' awk still finds
   `api`, both re-checked after the edit.
4. **Admin (D156).** A mail panel on the D47 dashboard — transport,
   configured, host, port, TLS mode, `authenticated`, sender; no password
   field exists for one to leak into. Unconfigured renders as `role="alert"`
   naming `SMTP_HOST`, not an em dash. `POST /admin/mail/test` is the only
   place a connection is opened, bounded at 15 s, through the *injected*
   mailer, answering 200 with `delivered: false` and the transport's own
   error text verbatim. Vietnamese and English strings for every label.
5. **Honesty at the point of use (D155).** In production, with a no-op
   transport, `password/forgot` and `email/verify/send` answer 503
   `mail_unavailable` — raised before the rate limiter and before the user
   lookup, so neither the body nor the timing can vary with the address. D26
   survives structurally rather than carefully. The forgot page renders it in
   Vietnamese, worded about the site ("to this address or to any other").
6. **Proof.** `mail-smtp-delivery.spec.ts` holds a real SMTP conversation
   against a `node:net` ESMTP listener on `127.0.0.1` — envelope (`RCPT TO`)
   asserted separately from headers, RFC 2047 subject and quoted-printable
   body decoded off the wire, Vietnamese and English templates both. No
   container, no third party, no real address.

## Every new test demonstrated red

Against deliberately broken code, real output:

- **Wiring, before the change:** `Tests 8 failed | 4 passed (12)` —
  `Invalid environment configuration — SMTP_HOST: Too small: expected string
  to have >=1 characters; SMTP_PORT: Too small: expected number to be >=1;
  SMTP_SECURE: Invalid option: expected one of "true"|"false"`
- **D155, before the change:** `Tests 3 failed | 2 passed (5)` — `Error: the
  rate limiter was consulted before the refusal`
- **Delivery, with `to: message.to` → `to: this.config.mailFrom` and the
  verbatim error replaced by `'failed'`:** `Tests 4 failed | 4 passed (8)` —
  `expected [ 'no-reply@duckoj.example' ] to deeply equal
  [ 'hocsinh@truong.example' ]`, `expected 'failed' to match /ECONNREFUSED/`
- **`readyz`, with `mail` hardcoded:** `Tests 1 failed | 4 passed (5)`
- **Mail panel, with `configured: true` forced and the password leaked:**
  `Tests 4 failed | 20 passed (24)` — `expected
  '{"queue":{"queued":0,"running":0,"exp…' not to contain 're_abc'`
- **Web, with the alert removed and the error paraphrased:** `Tests 3 failed
  | 37 passed (40)` — `TestingLibraryElementError: Unable to find
  role="alert"`

## Green

```
Test Files  12 passed (12)
     Tests  85 passed (85)
```
(`apps/api`: mail-wiring, mail-smtp-delivery, mail-unavailable, config,
health, admin-dashboard, account-recovery, register-verification,
route-marker-coverage, route-contract-parity, db-spec-timeout-policy,
app.boot — all under `nice -n 19 … --no-file-parallelism`.)

`apps/web`: `Tests 65 passed (65)` (admin, account-recovery, i18n).
`packages/contracts`: `Tests 39 passed (39)`.
Typecheck and lint clean on `@duckoj/api`, `@duckoj/web`, `@duckoj/contracts`.
`openapi.json` and `packages/sdk/src/generated.ts` regenerated and committed.

## Commits

- `f63370c` fix(deploy): the SMTP_* set actually reaches the api container
- `a512ec1` feat(auth): D155 — a stack that cannot send mail refuses the reset
- `ee2b840` feat(admin): D156 — the dashboard says whether mail works, and can prove it
- `9e20073` docs: D155 and D156

D157 was not needed and is unused.

## What I could not finish

- **Not deployed, so not proven against the live stack.** Everything here is
  proven locally. The next deploy of `api` is what makes `SMTP_HOST` reachable
  on the running host, and that is the controller's call, not mine.
- **`.env` on the live host was not touched** (and not read). Until an
  operator adds real `SMTP_*` values, the deployed stack stays on the no-op
  transport — which it will now say out loud in three places instead of none.
- **Read this before deploying `api`.** D155 has an operational consequence
  the boot log, `readyz` and the dashboard do not carry: the fourth place the
  stack now says it cannot send mail is **to the user's face**. The next
  deploy flips the live `POST /auth/password/forgot` from a fake 202 to a
  503, and the forgot-password page starts showing "this site is not set up
  to send email yet", until real `SMTP_*` values are in `.env`. That is
  deliberate and it is the whole point of D155 — but pair the deploy with the
  credentials, or expect the tickets.
- **The D155 refusal is unit-tested, not driven over HTTP.** The property
  under test is "nothing else ran", and the cleanest proof is a database
  handle and a limiter that throw on any access; an HTTP variant would need a
  container to prove less. The controller only propagates.
- **Prettier drift, pre-existing and untouched.** `prettier --check` fails on
  files I never opened (`apps/api/src/mail/mailer.ts` among them), so the repo
  is not prettier-clean and `pnpm verify` does not check it. Running
  `--write` would have buried this diff in unrelated reformatting. ESLint —
  the gate CI runs — passes on everything I touched.
