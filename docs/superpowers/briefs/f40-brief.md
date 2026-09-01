# F-40 — Mail is real, or the province is told it is not

## Why this slot

`docs/PROVINCE-READINESS.md` has listed SMTP as the **first** thing a
province must supply since 29 August. D1 records the design. The mail
templates exist, are localised (D57), and are unit-tested.

And none of it can work on a deployed stack, because **`docker-compose.yml`
passes no `SMTP_*` variable into the `api` service at all.** An operator can
fill in every `SMTP_*` line in `.env`, restart, and get exactly the same
silent no-op they had before — with nothing in any log to tell them why.

The failure mode this creates is the worst kind. A teacher clicks "reset my
password", the UI says the mail was sent, and it was not. Nobody finds out
until a student is locked out on contest day.

Two things are wrong and both are in scope:

1. The variables do not reach the process.
2. **Nothing tells anyone.** A misconfigured mailer must be loud at boot and
   visible to an admin, not discovered by a user who never gets their mail.

## Scope

### 1. Wire the configuration through

Pass the `SMTP_*` set into `api` in `docker-compose.yml`, matching the names
`apps/api/src/config` and `apps/api/src/mail` actually read — check, do not
assume, and if `.env.example` disagrees with the code, the code is right and
`.env.example` gets fixed in this slot. Follow the file's existing
convention for optional variables with defaults.

Note that `judged` and the other services do not send mail; do not widen
their environment.

### 2. Make the state of the mailer knowable

Three surfaces, in priority order:

- **At boot**: the API logs, once, at a level an operator sees, which
  transport it resolved — a real SMTP host, or the no-op. The no-op case
  says plainly that **no mail will be delivered** and names the variable
  that is missing. This is the single highest-value line in the slot.
- **In the health endpoint**: mail configuration state, so
  `scripts/deploy.sh`'s poll and any monitoring can see it. Configuration
  state, **not** a live connection test on every health check — do not turn
  a health probe into an SMTP dial.
- **For an admin**: the operations dashboard (D47) shows whether mail is
  configured, and offers a **send-a-test-mail** action to an address the
  admin types. That action is the only place a real connection is opened.
  It reports the transport's actual error text on failure — an operator
  debugging TLS needs the real message, not "failed".

### 3. Fail honestly at the point of use

Today a password-reset request returns success whether or not the mail went
anywhere. Decide what it should do when the mailer is a no-op, and make the
code do that deliberately rather than by accident.

Weigh it properly: **you must not leak whether an account exists** — that is
why the endpoint is uniform, and D26 records the same reasoning for
registration. Whatever you choose must keep that property. Consider whether
the honest signal belongs in the response at all, or only in the log and the
admin surface. Argue it, decide it, and record it as **D155**.

### 4. Prove it

A no-op mailer that is *tested* against a fake is not proof the wiring
works. Prove the whole path with a real SMTP conversation against a
throwaway server you start yourself — a container, or a Node SMTP listener
in a test — and assert the message arrived with the right recipient,
subject and language. Do not send mail to any real address, and do not add
a test that requires network access to a third party.

## How you work

**The live stack is production.** Six containers up, all healthy, a fresh
deploy at commit `531119c`.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh`, or
  `scripts/deploy.sh`. Only the controller deploys. You may read the live
  database with `podman exec duckoj_postgres_1 psql -U duckoj -d duckoj -c
  '<SELECT>'`. **No writes to the live database.**
- **Never** write to `apps/web/dist` — Caddy bind-mounts it. Build to a temp
  outDir if you must build at all.
- **Never** read, print, or commit anything from `.secrets/`. If you add a
  variable to `.env.example`, its value there is a placeholder.
- **Do not put a real credential in `docker-compose.yml`.** It is committed.
  Variables reference `.env`; they do not carry values.

**Thermal caps** (this host has hit 93 °C and agents were killed for it):

- Every test command under `nice -n 19`.
- Vitest always `--no-file-parallelism`. Run the specs you touched, never
  the whole workspace suite — CI runs that.
- Never run a container-backed spec alongside another suite.

**Toolchain**: `corepack pnpm` — bare `pnpm` and `gh` are not on PATH.
Typecheck passing is not lint passing; run both on what you touched.

**Tests**: every test demonstrated **red** against deliberately broken code
before you accept it, with the real failure output pasted into your report.

**Commits**: work in this clone on the current branch, commit in coherent
units with real messages, **do not push**. Stage exact paths — never
`git add -A` on a directory, because other work may be in flight here.

**Decisions**: append to `docs/DECISIONS.md`. **D155 is yours**; take
**D156** and **D157** if you need them. Do not go past D157, do not
renumber.

## Report

Write `docs/superpowers/briefs/f40-report.md` and return only: status,
commits, one line of real test output (the actual `N passed` line, never a
bare exit code), and what you could not finish. If a claim in this brief is
wrong when you check it, say so — this is my reading, not ground truth.
