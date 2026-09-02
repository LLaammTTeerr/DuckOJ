# F-56 — A school judge decides who may sign up

## The finding

D197 chose `affiliated` over `authenticated` for a reason it stated plainly:

> Registration is open — D26 **meters** it, it does not **gate** it — and B-35
> took 482 of 482 accounts in 576 requests and 1.5 seconds from one ordinary
> session. A default whose protection ends at "make an account" is
> attribution, not protection.

That reasoning is right, and it points at the thing underneath. The controller
checked the live edge:

```
POST /api/v1/auth/register     (no cookie, no token, no invitation)
→ 201
```

There is **no registration policy in this system at all** — no setting in
`apps/api/src/config`, nothing in `.env.example`. Anyone on the internet can
create an account on a province's school judge. They cannot read children's
names (D197 saw to that), but they can hold an account, submit, consume judge
time on a fleet sized for a province, and appear wherever accounts appear.

A public judge wants open registration. **A school district almost certainly
does not** — its pupils arrive by `bulk student accounts` (D61) and
`org:import`, not by signing up.

## The shape to build

Follow D197's shape, because it worked: **one switch, one predicate, a
school-safe default, and a guard that stops a surface forgetting it.**

Decide the rungs. Plausible ones: open (today's behaviour); invitation or
org-code only; closed, so accounts exist only because an operator made them.
Argue your set against the alternatives rather than adopting mine, and say
what each costs — a province that genuinely wants a public practice site is a
real deployment too.

Things that must come out right:

- **The default must be safe for a school** and reachable by doing nothing,
  exactly as `NAME_DISCLOSURE` is. An operator who reads no documentation gets
  the protective behaviour.
- **D26's oracle is in scope now, and may become easier.** Today registration
  answers a fake 201 for a taken email so it cannot be used to test whether an
  account exists — a compromise that has been an open gap since 29 August.
  Under a closed or invitation-only rung, the honest answer to a stranger is
  "registration is not open here", which discloses nothing about any address.
  Say what your rungs do to that gap; closing it is a real prize.
- **Do not break the paths that must keep working**: bulk student creation
  (D61), `org:import`, the first-admin bootstrap (D19), password reset (D155),
  and the e2e walks, which create accounts constantly and must be able to
  continue — say how.
- **Say it on screen.** A visitor who cannot register must be told why and
  what to do instead, in both languages (D18), following D145 — a failure is
  named by its status and offers the next move. A sign-up form that 403s
  without explanation is worse than no form.

Record it as **D200**.

## Clean up two live artefacts

- **`f56probe1`** — the controller created it proving registration is open,
  and its prefix does not match `scripts/cleanup-test-data.ts`'s patterns.
- **`b35-probe-1788313721` (id 487) and its 22 `rate_events`** — B-35 left
  these because the cleaner did not cover them; F-55 widened the pattern to
  `^b[0-9]+-` but running the cleaner is a live write no slot has been
  authorised to make.

**You are authorised to run `scripts/cleanup-test-data.ts` in apply mode for
these specific accounts only**, after showing the dry-run inventory in your
report. It refuses anything real depends on, which is the guard. Do not widen
the run beyond these.

## Out of scope

Roster freezing (D99). D195's search residual — D197's `affiliated` rung is
the answer for now and your policy may narrow it further, which is a welcome
side effect, not a licence to re-litigate the meter. `judged.live`'s attempt
keying (D29).

## How you work

**The live stack is production**, deployed at `2c8617e`, CI green, seven
languages, migrations through 0049, 482 accounts.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only** except the sanctioned cleanup above.
- **Never** write to `apps/web/dist`. **Do not run the web build.** The edge
  carries the current bundle, so a browser walk is an honest instrument.
- **Never** read, print or commit anything from `.secrets/`.
- **Next migration is 0050** if you need one — check the journal.
- Anything you add to config must reach the container: `docker-compose.yml`
  **and** `.env.example`. F-40 exists because a full `SMTP_*` set was read by
  the process and passed to it by nothing.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; Playwright
`--workers=1`; no load test. **Leave no process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D200** is yours; **D201** and **D202** after it. Do not go
past D202, do not renumber.

## Report

Write `docs/superpowers/briefs/f56-report.md`: the rungs and what each costs,
the verdict on D26's oracle, how the operator-driven account paths keep
working, what the visitor is told, and the cleanup's dry-run inventory beside
what it actually removed. Return only: status, commits, the real `N passed`
line, and what you could not finish.
