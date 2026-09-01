# B-34 — The team you just made can be edited: report

## No teacher is affected

**The product is not broken on this path.** A teacher who creates a team and
clicks **Sửa** gets a form that loads, seeds with the roster, and saves. That
is not a judgement from reading the code — it is the controller's own failing
trace: the detail request fired on the click and came back **200 in 10.3 ms**,
and the page snapshot taken after the fifteen-second timeout shows the form
mounted and correctly filled.

**Journey 2 was failing because the walk could not see a field that was on
screen.** `getByLabel('Thành viên', { exact: true })` matches the LABEL
ELEMENT'S TEXT, `TeamForm` wraps its control, and React writes a controlled
`<textarea>`'s value into the element's own child text node — so once the box
holds a roster the label's text is `"Thành viên fe42-a1"` and the exact
locator matches nothing. The fix is in the walk. Nothing shipped to the edge;
nothing needs to.

**The brief was wrong about journey 2b, and this matters.** 2b was believed
green, which is what made "a team created in this session" look like the
discriminator. It is not: **2b is red for the identical reason**, measured in
this slot at `e11188d`. Both walks failed the moment they READ a seeded roster
box; the create form's `fill` kept working only because it ran against an
empty one.

## The captured evidence

**1. The controller's own trace** (`test-results/organiser-journey-2-…/`,
`trace.zip` + `error-context.md`), mined rather than re-run:

```
23:21:25.218  POST 201  /api/v1/orgs/fe42-truong/teams                        (create)
23:21:25.236  GET  200  /api/v1/orgs/fe42-truong/teams                        (list refresh)
23:21:25.334  GET  200  /api/v1/orgs/fe42-truong/teams/fe42-moi-1788304883899  time=10.3 ms
```

and the page snapshot attached 15 s later, at the moment of the failure:

```
- heading "Sửa" [level=3]
- paragraph:
  - text: Định danh
  - textbox "Định danh": …
  - text: Tên đội
  - textbox "Tên đội": FE42 Đội mới 1788304883899
  - text: Thành viên
  - textbox "Thành viên": fe42-a1        <- the field the walk called missing
- paragraph:
  - button "Lưu"
  - button "Hủy"
```

The full form, not D183's `common.loading` gate. The request was issued, it
resolved, the query was enabled, and the seed happened — every one of the
brief's four questions answered, and all four the opposite way round from the
hypothesis.

**2. A scratch spec against the live edge** (`page.on('request')` plus a
`page.evaluate` over every `<label>` on the org page; deleted after capture,
its two fixture teams removed by their own DELETE). Four states, one page:

```
### A — edit form on a PRE-EXISTING team (journey 2b's path)
    {"labelTextContent":"Thành viên fe42-a1","wraps":"TEXTAREA",
     "controlChildText":"fe42-a1","controlValue":"fe42-a1","htmlFor":null}
   getByLabel exact=0  getByLabel loose=2  getByRole textbox exact=1

### B0 — CREATE form, boxes still empty
    {"labelTextContent":"Thành viên ","wraps":"TEXTAREA",
     "controlChildText":"","controlValue":"","htmlFor":null}
   getByLabel exact=1  getByLabel loose=2  getByRole textbox exact=1

### B1 — CREATE form, after fill
    {"labelTextContent":"Thành viên fe42-a1", …}
   getByLabel exact=0  getByLabel loose=2  getByRole textbox exact=1

### B2 — EDIT form on the team created moments ago (journey 2's path)
    {"labelTextContent":"Thành viên fe42-a1", …}
   getByLabel exact=0  getByLabel loose=2  getByRole textbox exact=1
   ->  POST /api/v1/orgs/fe42-truong/teams        <-  201
   ->  GET  /api/v1/orgs/fe42-truong/teams        <-  200
   ->  GET  /api/v1/orgs/fe42-truong/teams/fe42-b34-…   <-  200
```

`controlChildText` is the whole finding: the textarea has a **DOM text child**
carrying its own value, and the label that wraps it therefore contains it.
A and B2 are indistinguishable, which is the brief's premise dissolving.

**3. The walk itself, red before and green after** — see Tests below.

## The mechanism

- `TeamForm` (`apps/web/src/routes/teams.tsx:587`) wraps its control:
  `<label>Thành viên <textarea value={membersValue} …/></label>`.
- React 19 mirrors a controlled textarea's value into the element's child text
  content: `initTextarea` runs `element.defaultValue = value` on mount, and
  `updateTextarea` runs it again on every update
  (`react-dom-client.development.js:1842`, `:1855`). The HTML spec makes
  `defaultValue` the setter for a textarea's child text content, so the DOM is
  literally `<label>Thành viên <textarea>fe42-a1</textarea></label>`.
- Playwright's `elementText()` walks a node's text children
  (`playwright-core/lib/coreBundle.js`), so the label reads as
  `"Thành viên fe42-a1"` and `getByLabel('Thành viên', { exact: true })`
  matches zero elements. The failure surfaces as `element(s) not found`, which
  is exactly the shape D183's gate would also produce — which is why the brief
  read it as B-33 recurring.
- `<input>` is immune: an input's value is a property with no child text, so
  `Định danh` and `Tên đội` beside it never broke. The trap is a `<label>`
  that WRAPS a `<textarea>`. Every other textarea in the app — `problem-edit`,
  `problem-testdata`, `orgs`, and `MemberFinder` in this same file — is
  associated by `htmlFor`/`id`, so no other spec in `e2e/` can hit this.
- **`exact: true` at `e11188d` was still the right call**, and this is not a
  revert: the loose locator matched two controls (the roster textarea and the
  org roster's own `Tìm thành viên` search box — `loose=2` above, a
  strict-mode violation). `exact` traded that collision for a locator that only
  ever matches an EMPTY box. `getByRole('textbox', { name, exact })` answers
  both at once: it is `1` in all four states, because the accname algorithm
  leaves an embedded control's own value out of its own name — and it is what
  a screen reader announces, so a walk asserting on it asserts on what the
  reader is told.

**The app is deliberately not changed.** The wrapping label is valid HTML, the
accessible name is correct, and no reader is affected. Making the three fields
`htmlFor`/`id`-associated like every other form in the codebase would also fix
`getByLabel` and would be a tidy consistency win — but it is a change to a live
form with no user-visible benefit, it could not ship without a web build this
slot must not run, and the deployed bundle would still need the role locator.
Left for a slot that is shipping web anyway.

## Commits (this clone, `main`, not pushed)

| | |
| --- | --- |
| `30e8715` | `test(e2e): the roster box is found by role, because a label that wraps a textarea carries its value` — `apps/web/e2e/organiser.spec.ts` |
| this commit | `docs(D193): the locator that could not see a field that was on screen, and the bytes that proved it` — `docs/DECISIONS.md`, this report, the brief |

## Tests

**The browser walk is the instrument for both halves here**, because the
deployed bundle is unchanged — nothing was built, nothing was restarted, and
the "before" and the "after" run against the same live edge at `a9c83fc`.

Red, with the walk fix stashed (`-g "journey 2b"`, the journey the brief
believed was passing):

```
  1 failed
    [chromium] › e2e/organiser.spec.ts:660:1 › journey 2b — the panel shows the added pupil with no reload

  > 680 |   await expect(page.getByLabel('Thành viên', { exact: true })).toHaveValue('fe42-a1');
```

Green, after (`--workers=1`, the whole file):

```
  ✓  1 [chromium] › journey 1 — the monitor’s numbers are the API’s numbers, and the feed is live (44.7s)
  ✓  2 [chromium] › journey 2 — a teacher assembles a team in the form, and the one-seat rule names the pupil (3.3s)
  ✓  3 [chromium] › journey 2b — the panel shows the added pupil with no reload (1.2s)

  3 passed (50.2s)
```

**Full `@duckoj/web` suite** (`corepack pnpm --filter @duckoj/web test --
--no-file-parallelism`) — the only package this slot touched:

```
 Test Files  75 passed (75)
      Tests  792 passed (792)
```

`typecheck` and `lint` clean for `@duckoj/web`. No jsdom pin was added: the
defect was in the walk, and a vitest spec asserting that React puts a
textarea's value in its child text node would be a test of React, not of this
app. D183's own pin (`test/teams-edit-seed-race.spec.tsx`) is untouched and
still green — it is in the 75 above.

## Left standing

- **B-33's product fix IS on the edge — its report's "the deployed bundle is
  still defective" is closed.** `fa2bd11` is an ancestor of `a9c83fc`, and
  `apps/web/dist` was rebuilt at 06:11 today, so D183's gate is live. Nothing
  outstanding from that slot. (The gate is not what journey 2 hit: a pre-D183
  bundle would have failed the same assertion the same way, because the exact
  locator matches an empty box and stops matching the instant the seed writes
  the roster into the label's text.)
- **`fe42-truong` fixture accumulation is fixed at its source.** The stable
  `fe42-doi-a`/`fe42-doi-b` pair landed before this slot; the walk now leaves
  nothing behind but them. The 32 historical `fe42-alpha-*`/`fe42-bravo-*`
  rows from before that change are still there, undeletable by D101, and are
  still the reason the teams list is past its page size.
- **Prettier drift in `apps/web/e2e/organiser.spec.ts` remains** — four hunks,
  all on lines this slot did not write, all pre-existing (B-33 saw the same and
  left them). CI does not run a format check. Left alone rather than mixed into
  a diff about a locator.
- **The general trap is recorded as D193**, not just fixed: the next agent who
  reaches for `getByLabel` on a wrapped textarea will find the reason it does
  not work written down, with the measurement beside it.
