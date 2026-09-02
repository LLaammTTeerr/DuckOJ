# F-57 — The walks under a closed judge

## What happened

F-56 shipped `REGISTRATION`, defaulting to **`closed`**, and the controller
deployed it. The default is right and D26's oracle is genuinely gone —
verified on the live edge, a taken and an unknown email both answer:

```
403 registration_closed
"This site does not take sign-ups. Ask your school for an account."
```

F-56 also changed `organiser.spec.ts` to seat its pupils as the admin, and
said honestly that it could not run the walks. It fixed one file. **Four
others still self-register**, so the suite is now:

```
4 failed · 14 did not run · 59 passed
  authoring.spec.ts   journey 3   register bh16-pupil-…: 403
  features.spec.ts    feature 4   register bh14-s1-…: 403
  smoke.spec.ts                   registration failed: 403 registration_closed
  journey.spec.ts     journey 1   register on the form → timeout
```

The browser suite is the campaign's main verification instrument and it is
currently half-blocked. That is the urgency here; the product is correct.

## The work

### 1. Accounts arrive the way a school makes them

Every walk that needs a pupil should mint one **the way a province actually
does** — an operator creating it (D61's bulk student accounts, `org:import`,
or the admin path) — not by self-registration. `organiser.spec.ts` at
`91a8402` is the worked example; read it and reuse its shape rather than
inventing a second one.

This is not only expedient, it is more faithful: on a school judge no pupil
ever self-registers, so a suite that mints pupils that way was testing a path
its users do not take.

### 2. `journey.spec.ts` journey 1 is different, and is the interesting one

That walk exists to test **the registration form** — the mismatched
confirmation, the Vietnamese and English copy, the whole flow. It cannot be
converted away; the flow is the subject.

Decide how a two-rung policy is walked in a browser. Options include: assert
the refusal under `closed` (a visitor is told, in their language, what to do
instead — which is now the shipped behaviour and deserves a walk of its own),
and cover the form itself under `open` by some scoped means. **You may not
change the live `.env` or restart a container**, so if covering `open`
requires the deployment to be on that rung, say so and cover what you can —
an honest gap named beats a walk that quietly stops testing the form.

Whatever you choose, the refusal path must end up walked: it is what a real
visitor to a province's judge will meet.

### 3. Then run the whole suite

Against the live edge, `--workers=1`. Quote the real `N passed` line. The
suite must end green or you must say exactly which walks do not pass and why.
Two false-green e2e runs have happened in this campaign — a bare `exit 0` and
a silently missing `axe-core` — so an exit code is not evidence.

## Out of scope

Roster freezing (D99). `judged.live`'s attempt keying (D29). The `open` rung's
D26 residual — F-56 recorded it as scoped to that rung deliberately. Do not
change the default rung to make tests pass; the default is the product
decision and the tests serve it, not the other way round.

## How you work

**The live stack is production**, deployed at `01e59f2`, registration
**closed**, seven languages, migrations through 0049, 480 accounts.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**. **Never edit the
  live `.env`.**
- Live database is **read-only**.
- **Never** write to `apps/web/dist`. **Do not run the web build.** The edge
  carries the current bundle, so a browser walk is an honest instrument.
- **Never** read, print or commit anything from `.secrets/` — parse it by
  username to authenticate, never echo it.
- Live rows you create follow **D153** naming — the cleaner now covers
  `^b[0-9]+-` and `^fe[0-9]+-`; use a prefix it matches, and delete what you
  can in `test.afterAll`.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; Playwright `--workers=1`; vitest
`--no-file-parallelism`; no load test. **Leave no process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D203** is yours if the rung-walking design needs one; **D204**
after it. Do not go past D204, do not renumber.

## Report

Write `docs/superpowers/briefs/f57-report.md`. Return only: status, commits,
the real `N passed` line for the whole browser suite, how journey 1 now covers
both rungs, and what you could not finish.
