# P1-D — the freeze reaches the submission routes

**DONE_WITH_CONCERNS** — `a5c86bd`. Ruling **D23** (`docs/DECISIONS.md`)
carries the reasoning; D22 stays the scoreboard's.

## Shipped

1. **`apps/api/src/authz/submission.freeze.ts`** (new) — the whole rule, in the
   two forms `canViewSubmission`/`visibleSubmissionsWhere` set the pattern for:
   `isSubmissionFrozen(actor, row, ctx, now)`, taking its window from
   `participationWindow` → `participationEndMs`, and `frozenSubmissionsWhere(
   actor, now)`, the same rule as one SQL boolean over the outer `submissions`
   row. Plus `loadSubmissionFreezeContext`, the `maskFrozen*` projections and a
   clause-for-clause table in the header mapping the forms onto each other.
2. **`submission.access.ts`** — `listVisible` selects the SQL form as a computed
   `frozen` column and masks the summary; `getVisible` masks a fully-built detail
   through the row form. The freeze *filters* in exactly one place, `?verdict=`
   (`not ${frozen}`): nine probes would otherwise read the verdict off the page.
3. **Contracts / SDK** — required `frozen: boolean` on `SubmissionSummary` and
   `SubmissionDetail` (it alone separates "withheld" from "not graded yet"), both
   GET descriptions updated, `openapi.json` + the SDK regenerated, `LIVE`/
   `SPECTATE` now exported from `@duckoj/contest-formats`.
4. **Web** — the list's verdict cell renders `?` (not the pending `—`) with
   `title={t('submission.frozen')}`, keyed in `en.ts` + `vi.ts`, and
   `VerdictPanel` gains a frozen branch *before* its verdict branches: a frozen
   detail arrives with `verdict: null` and would otherwise render nothing.
5. **Untouched, verified rather than assumed** — the realtime push carries
   `{ type: 'submission', id }` and nothing else, its client re-fetching through
   the now-masking `getVisible`; `/contests/{key}/me` returns one participation
   window and no outcome. Both are now pinned by tests on their exact shapes.

## Tests

New `apps/api/test/submission-freeze.spec.ts` (11, on `testDbUrl()`): inside
window masked on both routes · own not masked · admin not masked · creator not
masked · after the participation's end revealed · before the window not masked ·
practice submission untouched · a virtual entrant frozen past the contest's own
`end_time` · the `?verdict=` oracle closed · the `/me` field set · a two-form
**agreement test** over every participation shape (spectating, live ± time limit,
virtual ± time limit, no freeze). New `apps/web/test/submission-frozen.spec.tsx`
(3), and two `realtime.spec.ts` cases now wait on the `subscribed` ack rather
than a `setTimeout(50)` the freeze's extra `getVisible` query outran.

**17 mutants run, 17 killed** — including "own row is masked too", "admins are
masked too", "the freeze never ends", "everything in a frozen contest is masked",
"SQL: a virtual window is the contest's window", "the verdict filter is not
narrowed". Ritual green: **1048 tests, 0 failures**; regen no diff; `vite build` ok.

## Concerns

- **The profile's solved count still ticks during a freeze** —
  `UserAccessService` counts distinct `AC` problems per user. Out of scope, named
  in D23 so it is not rediscovered as a surprise.
- **`source` reaches a rival mid-contest** wherever a problem set
  `source_access = 'solved'` and the rival holds a practice AC. Not D23's.
- **The SQL form is a second derivation of the participation window** — the
  agreement test covers today's shapes; a new `virtual` semantic needs adding by
  hand. Its extra `sql` wrapper is load-bearing too: drizzle strips qualifiers
  from a selected field's top-level `Column` chunks in a single-table query,
  which made `"id"` ambiguous in the `EXISTS`.
