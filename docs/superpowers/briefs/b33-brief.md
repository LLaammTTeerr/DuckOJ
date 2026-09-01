# B-33 — The roster edit that saves nothing

## The evidence, exactly as it stands

`apps/web/e2e/organiser.spec.ts` **journey 2** is red, deterministically,
since F-50's web half was deployed. It passed 3/3 twice before it.

```
Error: the one-seat rule answers 409, never 500
Expected: 409   Received: 200
  page.getByLabel('Thành viên').fill('fe42-a1, fe42-a2, fe42-c1');
  expect(await saveRoster(page, ALPHA)).toBe(409);
```

**The product is not the defect.** The controller reproduced the same edit
directly against the live API as an admin:

```
PATCH /orgs/fe42-truong/teams/fe42-alpha-1788289484648
  {"members":["fe42-a1","fe42-a2","fe42-c1"]}
-> 409 contest_already_joined
   "fe42-c1 is already competing in a contest this team has..."
   roster afterwards: fe42-a1,fe42-a2  (unchanged)
```

D101/D104's one-seat rule fires correctly and names the pupil.

The Playwright trace of the failing run shows **two** PATCHes to that team,
both `200`. The first is the walk's earlier legitimate roster save, and the
live database agrees with its result. The second — the one that should carry
`fe42-c1` — returned 200 with the roster unchanged, which is what the server
answers when the body asks for **nothing new**.

So the reading to start from, and to disprove if it is wrong: **what the
teacher typed did not reach the request.** The trace's `postData` is empty, so
that is inference, not proof. Get the proof.

## Why this is urgent rather than tidy

If a roster edit can silently send the pre-edit list, a teacher adds a pupil,
sees no error, and the pupil is not on the team. That is the class this
campaign has fixed three times already — F-42's stale cache prefill, B-31's
seed-once edit forms, F-48's five forms — and it would mean F-50 reintroduced
it by another door.

**It is live right now.** The controller judged that reverting the bundle
risked more than it fixed, given the API is verified correct and one earlier
save in the same walk succeeded. If you find it genuinely loses a teacher's
work on a realistic path, say so plainly and first — the controller will
revert on that finding alone.

## Where to look

- `apps/web/src/routes/teams.tsx`, `TeamForm` — its seed effect, `seededFrom`,
  `seed`, `dirty` and the D161 clause A reseed guard at the `if (!first && ...)`
  line. Read the F-48 diff `adeb842` and D176 alongside it.
- F-50 widened the teams **summary** to carry `members` (`94e0838`), and F-49
  moved the panel to `useInfiniteQuery` (`be67161`). Either can change when
  `loaded` arrives, how often the list re-renders, and whether the form
  remounts mid-edit. A remount makes `first` true, and a first seed overwrites
  regardless of `dirty` — that is the mechanism worth checking first.
- The walk edits the **same team twice**. The second edit is the one that
  fails; whether the form is fresh or reused across those two edits is a fact
  to establish, not assume.

## What a finished slot looks like

- The actual request body, captured — a route interception in the walk, a
  logged fetch, whatever gives you the bytes. **No conclusion without it.**
- The mechanism named, with a test that fails against the current code and
  passes after your fix, run against the live edge where a browser is the
  honest instrument.
- If the walk is wrong rather than the app, say so with the same evidence and
  fix the walk — F-49's slot began with exactly that shape and the answer was
  a real product defect underneath it. Either verdict is acceptable; an
  unsupported one is not.
- If a teacher can lose typed work on a realistic path, that finding comes
  first in your report, above everything else.

## How you work

**The live stack is production**, deployed at `a33aaf9`, seven languages,
migrations through 0046. **Playwright can prove your fix green** — the edge
carries F-50's bundle, so unlike the last two slots a browser walk is a real
instrument here.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- Live database is **read-only**: `SELECT`/`EXPLAIN`.
- **Never** read, print or commit anything from `.secrets/` — parse it by
  username to authenticate, never echo it.
- Live rows follow **D153** naming; `test.afterAll` in the organiser walk is
  the cleanup pattern, comment included.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch**.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; Playwright
`--workers=1`; no load test. **Leave no process running.**

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D183** is yours; **D184** after it. Do not go past D184.

## Report

Write `docs/superpowers/briefs/b33-report.md`. Return only: status, the
captured request body, the mechanism, commits, the real `N passed` line, and
whether a teacher can lose typed work on a realistic path.
