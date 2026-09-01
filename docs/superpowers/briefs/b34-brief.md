# B-34 — The team you just made cannot be edited

## The evidence

`apps/web/e2e/organiser.spec.ts` **journey 2** is red against the live edge at
`a9c83fc`. Two facts narrow it hard:

- **Journey 2b passes.** It clicks the same `Sửa` button and asserts the same
  `getByLabel('Thành viên', { exact: true })` has the right value — on a team
  that **already existed** when the page loaded.
- **Journey 2 fails** at the same assertion, on a team the walk **created
  moments earlier in the same session**:

```
Error: expect(locator).toHaveValue(expected) failed
  Locator: getByLabel('Thành viên', { exact: true })
  Expected: "fe42-a1"
  Timeout: 15000ms
  Error: element(s) not found
```

**"element(s) not found" is the shape that matters.** D183 made `TeamForm`
render no editable field until it holds the roster it is editing. So the field
is absent because **the form never seeded** — for fifteen seconds.

## What is already ruled out

- **The API is fine.** As admin, against the live host:
  `GET /orgs/fe42-truong/teams/{slug}` → `200` with a full `members` array.
  `GET .../teams?limit=1` → 200. The seat rule, the roster PATCH and the org
  member routes were all re-measured after the F-53 deploy and behave.
- **It is not the label collision.** F-51 added a search box labelled
  `Tìm thành viên`, which contains `Thành viên`; the walk's seven locators are
  now `{ exact: true }` and that failure mode is gone. This is the next one.
- **F-53's web change is in `orgs.tsx`**, not `teams.tsx`, and journey 2b
  exercises the same panel successfully.

## The hypothesis to test first, and to discard if wrong

**F-50 deleted an accidental prefetch, and D183 turned the consequence into a
visible one.** Before `94e0838`, every row's `TeamMembers` fetched
`['org-team', slug, teamSlug]` — the same key `TeamForm` seeds from — so by
the time anyone clicked `Sửa` the entry was warm. Widening the summary removed
that N+1 and the prefetch with it. B-33 already found and fixed one bug this
exposed (a form that offered boxes before it held the record).

This may be the second: for a team **created in this session**, the cache
entry under that key may be primed, empty, or never fetched at all, so the
seed never happens and D183 correctly renders nothing — forever.

Establish what actually happens: is the detail request issued? Does it resolve?
Is the query enabled? Is a create response written into that key? **Get the
network and the cache state, not a reading of the code.** B-33's method —
`page.on('request')` against the live edge — is the model.

## What a finished slot looks like

- **Say plainly whether a teacher is affected.** A teacher who creates a team
  and clicks Edit is an ordinary path, and if it hangs on an empty form that
  is user-facing and belongs at the top of your report. If it is only the
  walk's timing, say that with the same evidence.
- The mechanism named, and a test that fails against current code and passes
  after the fix. The edge carries the current bundle, so a browser walk is an
  honest instrument for the "before"; your "after" may have to be vitest, and
  if so say which is which.
- If journey 2 is wrong rather than the app, fix the walk and say so — the
  last three walk failures were one real product bug, one fixture
  accumulation, and one selector collision. All three verdicts were correct
  and none was guessed.

## Out of scope

`contestWindowOpenWhere` (D49). Registration's oracle (D26). Roster freezing
(D99). The `fe42-*` contest fixtures that grow ~1 per walk run.

## How you work

**The live stack is production**, deployed at `a9c83fc`, CI green, seven
languages, migrations through 0047.

- **Never** run `podman-compose down/up`, `scripts/compose-up.sh` or
  `scripts/deploy.sh`, and **never restart a container**.
- Live database is **read-only**: `SELECT`/`EXPLAIN`.
- **Never** write to `apps/web/dist`. **Do not run the web build.**
- **Never** read, print or commit anything from `.secrets/` — parse it by
  username to authenticate, never echo it.
- Live rows follow **D153** naming; `test.afterAll` in the organiser walk is
  the cleanup pattern.

**Read `CLAUDE.md`.** Run the **full suite of every package you touch** — the
last slot's full api run caught two failures six targeted runs had missed.

**Thermal**: `nice -n 19`; vitest `--no-file-parallelism`; Playwright
`--workers=1`; no load test. **Leave no process running** — this host is
shared with another project.

**Toolchain**: `corepack pnpm`; bare `pnpm` and `gh` are not on PATH.

**Commits**: this clone, current branch, coherent units, real messages, **do
not push**. Stage exact paths, never `git add -A` on a directory.

**Decisions**: **D193** is yours (unused); **D194** after it. Do not go past
D194, do not renumber.

## Report

Write `docs/superpowers/briefs/b34-report.md`. Return only: status, whether a
teacher is affected, the captured evidence, the mechanism, commits, and the
real `N passed` line.
