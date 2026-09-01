# B-30 — Hunt the two slots that just shipped

Two features landed and deployed inside four hours, both touching paths that
had never carried real traffic. The loop's rule is that a feature pair is
followed by a hunt, and this is it.

**Read `docs/superpowers/briefs/f39-report.md` and `f40-report.md` first.**
They name what was built, what the implementers judged out of scope, and the
claims their briefs got wrong. The gaps they admit are the best place to
start looking, not the worst.

## What shipped, and why each part is worth suspicion

### F-39 — five languages (D154), deployed at `531119c`

For two weeks the `languages` table had one row. Every multi-language code
path in this system — the key→executor mapping, the reverse mapping from a
judge's handshake, per-language limits, the submit picker, drafts keyed by
(problem, language) — has now run for the first time, on live traffic, after
a single afternoon's work.

Places worth real doubt:

- **`effectiveLimits` runs in two processes.** `apps/api` computes it to
  DISPLAY a limit; `apps/judged` computes it to ENFORCE one. D154 claims
  integer arithmetic makes them bit-identical. Test that claim rather than
  believing it: find an input where the two disagree, including the
  boundaries — a null override column, a problem row that does not exist,
  `allowed = false`, a multiplier of 0 or a negative one if the schema
  permits either.
- **Overrides inherit column by column.** D154 says a row that pins time but
  not memory keeps the interpreter floor, because dropping it would MRE
  every Python submission. Prove that is what the code does.
- **`allowed = false` answers 404.** Check it is a 404 on *every* route that
  can start a submission, not only the one that was tested — including
  contest submission, rejudge, and anything the MCP server exposes. A
  rejudge that re-runs an old Python submission on a problem that has since
  refused Python is exactly the kind of path a feature slot forgets.
- **Language dispatch depends on what a judge ANNOUNCES.** If the announced
  executor set and `language_driver_keys` disagree — an operator narrows
  `--only-executors`, or adds a language row with no mapping — what happens
  to a submission in that language? D68's `blocked_reason` is supposed to
  cover it. Verify, and check the student is told something true.
- **Drafts are keyed per (problem, language)** (D84) and that key has never
  had a second value. Switching languages with unsaved work in the editor is
  a real user action that has never happened.

### F-40 — mail (D155, D156), deployed at `e7d782f`

- **`POST /auth/password/forgot` now answers 503 in production** when the
  transport is the no-op. D155 argues this does not reopen D26's
  account-existence oracle because the refusal is raised before the rate
  limiter and before the user lookup, so it is uniform in both content and
  timing. **Attack that argument.** Is it raised first on every path that
  can reach it? Does any other endpoint — resend verification, the admin
  reset, anything that mails — leak what this one is careful not to?
- **The admin test-mail action opens a real outbound connection** to a host
  from configuration, addressed to an address an admin types. Check the
  authorisation marker is right, that the address is validated, that the
  transport's error text reaching the screen cannot carry a credential, and
  that the action cannot be used as a relay or a scanner.
- **Nothing about mail is proven over HTTP.** The D155 refusal is unit-tested
  with a database handle that throws. That is a good test; it is not the
  same as a request.

## Scope

Find real defects. Fix what you find, with a test that was demonstrated red
against the unfixed code first. **A hunt that reports "no issues found" is a
valid result** — but it must show what it actually examined and how, because
an unsupported all-clear is worse than a missed bug.

Rank what you find by what it does to a student on contest day. A wrong
verdict outranks a wrong colour.

## How you work

**The live stack is production**, freshly deployed at `e7d782f`, six
containers healthy.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`. Only the controller deploys. Read the live database
  with `podman exec duckoj_postgres_1 psql -U duckoj -d duckoj -c '<SELECT>'`
  — **reads only, no writes**. You may `curl http://localhost:8080/...` and
  you may submit as a test account; note that you will be creating live rows,
  so use the test-artefact naming D153 defines.
- **Never** write to `apps/web/dist` — Caddy bind-mounts it.
- **Never** read, print or commit anything from `.secrets/`. You may parse it
  by username to authenticate; you may not echo it.
- The live `.env` has no `SMTP_*` values, so the stack is on the no-op
  transport. **Do not add credentials to it.** If you need a real SMTP
  conversation, start a throwaway listener you control.

**Thermal caps** (93 °C incident on this host):
- Every command under `nice -n 19`; vitest always `--no-file-parallelism`.
- Run the specs you touch, never the whole workspace suite.
- Never a container-backed spec alongside another suite.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages,
**do not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D157** is yours; **D158** and **D159** if needed. Do not go
past D159 and do not renumber.

## Report

Write `docs/superpowers/briefs/b30-report.md` — every defect with its
reproduction, its severity in terms of what a student experiences, and the
red-test output for its fix. Return only: status, commits, one line of real
test output, defect count by severity, and what you could not finish.
