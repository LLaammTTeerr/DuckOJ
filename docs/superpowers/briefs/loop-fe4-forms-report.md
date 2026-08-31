# loop fe4 — forms and the editor

Every form read against four questions: does a failure keep what was typed, does
validation teach, does the button tell the truth, is the editor usable. **D146**
a 422 reaches the field · **D147** a dirty form warns · **D148** a button is live
unless busy and says what it is doing. Verified against `vite preview` on :4321
— **the live bundle was never rebuilt.**

**Two systemic findings.** The API has always said *which field* it objected to
(`ZodValidationPipe` writes `fields: {"<issue.path>": [...]}` on every 422) and
twelve forms threw all of it away, printing the pipe's one English sentence in a
Vietnamese page beside no field. And `grep beforeunload src/` returned nothing:
nothing here had ever asked "you have unsaved work" — including the form holding
a whole problem statement.

## Fixed (13)

| # | Where | What was wrong |
|---|---|---|
| 1 | register, contest-new/edit | A 422 was a banner; now on the field, with D110's summary taking focus |
| 2 | contest-new/edit | `disabled={key === ''}` — dead button, eleven inputs, no clue which. Live + inline validation |
| 3 | contest-new/edit | End-before-start was `contest_window_invalid` **after** a round trip — a 400 with no attribution. Named on the END box first |
| 4 | problem-edit, contest-new/edit | A route change took the work silently. `useDirtyGuard` = `beforeunload` + router blocker |
| 5 | **submit editor** | **Double submit**: `props.busy` is the parent's state, a render behind — two presses in one tick both sent |
| 6 | submit editor | A 200 MB pick froze the tab: `file.text()` decodes before anything can measure. `file.size` first, exact bound |
| 7 | submit editor | `busy` meant "in flight" *and* "cooling down", so during D80's cooldown the button claimed to be submitting |
| 8 | **login** | **No busy state at all.** Two clicks = two `POST /auth/login`; D16 meters per ACCOUNT, so a pupil could lock themselves out |
| 9 | **org create** | No busy flag **and** no `try/catch`. Two schools attempted; a dead network showed nothing |
| 10 | **/account/password** | Objected every KEYSTROKE — "Ngắn hơn 10 ký tự." on character one of a twelve-character password. Blur or submit now |
| 11 | clarifications ×2 | `failure.detail ?? failure.code` printed `contest_not_running` as the message — two sites D145 missed |
| 12 | settings, tokens, sets | Busy label + `aria-busy` |
| 13 | D110's summary | A copy inside `register.tsx`; a component now, reused by five forms |

**What the mocks could not see.** Every unit test of the guard mocks
`useBlocker`. `e2e/forms.spec.ts` drives the real router and caught a real trap:
without the synchronous `release()`, the guard **blocks the navigation a
successful save makes**. Mutation-checked live. A bug I introduced and caught:
raising the summary on blur steals focus from the box just tabbed into — it is
submit-only, and a test pins it.

**Checked and dismissed.** Seed-clobber sweep over every prefilled form:
`contest-edit`/`problem-edit`/`settings` guard by key; `problem-sets`, `teams`,
`orgs`, `security`, `problem-testdata` have no seed effect. The roster import's
progress is honest. `problem-testdata` needed nothing and is the model — it names
the PHASE (loading/uploading/building) in a `role="status"`. `account-recovery`
already had the `busy`/`disabled` split I copied into `SubmitForm`. The editor at
390px was already sound; the spec is a guard. **Left**: `security.tsx`'s six TOTP
buttons and per-row actions where the row is the context — both named in D148 so
the ledger is not read as app-wide.

## Gate

`typecheck` clean · `lint` clean (`src test e2e`) · `vitest run
--no-file-parallelism` **718 passed (64 files)**, from FE-3's 664 · `vite build`
ok · e2e on the preview build, `editor` + `forms` + `states` + `a11y-axe` +
`a11y-surfaces` + `mobile` in one run: **29 passed (2.5m)**, my two new files 6 of
them. FE-3's flaky `a11y-surfaces` axe sweep passed here (51.5 s, inside its new
timeout). Sixteen mutation checks — red observed, restored.

**Concerns.** (1) `smoke`/`journey`/`features`/`contest-day` still cannot run
against preview (D82 `403 csrf_origin`) and against the live stack would exercise
the OLD bundle — FE-2's concern, unchanged; none was edited, and their locators on
the contest forms still resolve (inputs gained ids, no label text changed).
(2) Two specs asserted the behaviour D148 changes and were **adapted
deliberately**: `org-import`'s "unattended browser must not be one click from a
takeover" keeps its real property — no request is sent — and now also checks the
reason is named; a disabled button never was that defence, since the API refuses
a change with no current password whatever the browser does. (3) Five spec files
gained `useBlocker` to their router mock; a page using the guard now needs one.
(4) D146–D148 verified free at commit time (D142 is a pre-existing gap); worktree
branch, so re-check before merging.
