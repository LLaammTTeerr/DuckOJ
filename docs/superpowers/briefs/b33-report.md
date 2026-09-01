# B-33 — The roster edit that saves nothing: report

## A teacher loses typed work on a realistic path, and nothing tells them

**This comes first because the controller said it would revert on it.** The
defect is live. On any path where the team-detail request has not answered
before the teacher starts typing — a provincial link, a loaded API, a browser
that just cold-started — the sequence is:

1. the teacher clicks **Sửa** and gets a form with three editable, empty boxes
   and no notice that they are provisional;
2. they type the roster, including the pupil they came to add;
3. the `GET /orgs/{slug}/teams/{teamSlug}` lands and **silently replaces what
   they typed with the pre-edit roster** — no banner, no conflict, nothing;
4. they press **Lưu**; the PATCH carries the roster the server already had and
   comes back **200**;
5. the panel refreshes and shows the team exactly as it was. The pupil is not
   on it. Nobody was told.

Observed on the live edge, not inferred. Test B below typed
`fe42-a1, fe42-a2, fe42-c1` into the box, watched it read back as
`fe42-a1, fe42-a2` four seconds later, and found no `editConflict.reseeded`
notice on screen (the only `role="status"` present was the unrelated
locked-contest banner).

Worse, in the faithful-timing run (test A) the box still **read** the typed
roster at the moment Save was pressed, while the body carried the old one —
so even a teacher watching the screen has no cue.

The fix is a local commit. **The deployed bundle stays defective until it is
rebuilt and shipped**, which this slot does not do (no web build, no restart).

## The captured request body

`page.on('request')` + `request.postData()` inside a scratch spec against the
live edge (`http://localhost:8080`, F-50's bundle). Typed:
`fe42-a1, fe42-a2, fe42-c1`.

```
### A — faithful journey-2 timing (goto, click Sửa, fill, save)
PATCH /api/v1/orgs/fe42-truong/teams/fe42-b33a-1788290216569
{"name":"FE42 B33 A 1788290216569","members":["fe42-a1","fe42-a2"],
 "slug":"fe42-b33a-1788290216569",
 "expectedVersion":"83b9995d264a55a8b6af9ee07c0308c44603ec77f60a21717b314cbb37e674a6"}
status 200   (textarea at save time still read "fe42-a1, fe42-a2, fe42-c1")

### B — the same edit with the detail GET delayed 3 s (a slow link)
box while loading:        ""          (editable, no notice)
box just after typing:    "fe42-a1, fe42-a2, fe42-c1"
box 4 s later:            "fe42-a1, fe42-a2"     <- silently reseeded
role=status on screen:    only the locked-contest banner; no reseed notice
PATCH /api/v1/orgs/fe42-truong/teams/fe42-b33b-1788290216569
{"name":"FE42 B33 B 1788290216569","members":["fe42-a1","fe42-a2"],
 "slug":"fe42-b33b-1788290216569",
 "expectedVersion":"35a721667f49c2e8b2a7470b915a4a14c73758fc4ea754edb93fda116c57d232"}
status 200
```

The brief's reading was right: **what the teacher typed did not reach the
request.** The scratch spec was deleted after capture; its two fixture teams
were removed by its own `afterAll`.

## The mechanism

`TeamForm` (`apps/web/src/routes/teams.tsx`):

- clicking **Sửa** mounts the form and fires `GET
  /orgs/{slug}/teams/{teamSlug}`;
- while that is in flight, `loaded === null` — the seed effect returns early,
  but the **render did not**, so all three fields were on screen, editable and
  empty;
- when the response lands, the effect runs with `first = seededFrom !== key`
  **true**, and the `first` branch overwrites `slugValue`/`nameValue`/
  `membersValue` **regardless of `dirty`**. That is deliberate and must stay:
  `loadNewer()` reopens the guard by clearing `seededFrom`, and *that* reseed
  is D161's admin explicitly choosing the newer roster;
- `setReseeded(true)` is guarded by `if (!first)`, so this seed announces
  nothing;
- `save()` builds the body from `membersValue`, which is now the server's own
  list, so the API answers 200 with nothing to change — exactly what the brief
  observed.

**F-50 did not write the bug; it removed what was hiding it.** Before `94e0838`
(D182), `TeamMembers` fetched every visible row's detail under the *same*
`['org-team', slug, teamSlug]` key. The cache was therefore warm before anyone
clicked Sửa, `loaded` was non-null on the form's first render, and the seed was
effectively synchronous. Deleting that N+1 was right, and it deleted an
accidental prefetch with it — which is how a performance fix became a silent
write of stale data. Fourth visit to this same loss: F-42's stale prefill,
B-31's seed-once forms, F-48's five forms, now the window before the first
seed. `be67161` (useInfiniteQuery) is not implicated; no remount occurs.

**The fix (D183).** The form renders no editable field until it has been
seeded *from this team*: `if (teamSlug !== undefined && seededFrom !== teamSlug)`
returns the heading, `common.loading` and Huỷ — mirroring the branch already
there for a load that *failed*, whose own comment gives the reason (`members`
REPLACES the whole roster, so an empty box is a saved change). The gate is
"seeded from THIS team" rather than "the query answered" because between the
response landing and the effect committing there is one paint where the boxes
are mounted and still empty — enough for a keystroke already in flight, and
enough to make a browser walk flaky rather than wrong. The seed effect itself
is untouched.

**The walk was also wrong, separately.** Journey 2's second edit typed straight
after the click while its first edit waited for the prefill. The wait is now on
both, commented as *not* the fix.

## Commits (this clone, `main`, not pushed)

| | |
| --- | --- |
| `fa2bd11` | `fix(web): the team edit form offers no field until it holds the roster it edits (D183)` — `apps/web/src/routes/teams.tsx`, `apps/web/test/teams-edit-seed-race.spec.tsx` |
| `124c134` | `test(e2e): journey 2 waits for the prefill it types over, and 2b stops claiming it is red` — `apps/web/e2e/organiser.spec.ts` |
| `(follow-up)` | `test(web,e2e): 2b's title stops saying it is red, and the team form's reload button gets pressed` — `apps/web/e2e/organiser.spec.ts`, `apps/web/test/edit-form-conflict.spec.tsx` |
| (this commit) | `docs(D183)` — `docs/DECISIONS.md`, this report, the brief |

## Tests

**The regression pin, red then green.** `apps/web/test/teams-edit-seed-race.spec.tsx`
holds the detail response open, types into whatever box the form offers, lets
the roster land, and asserts the PATCH body carries what was typed.

```
# against the deployed code (fix stashed)
 Test Files  1 failed (1)
      Tests  2 failed (2)
AssertionError: the save carried the roster the form seeded over the typing:
  expected [ 'an', 'binh' ] to deeply equal [ 'an', 'binh', 'chi' ]

# after the fix
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

**Full `@duckoj/web` suite** (`corepack pnpm --filter @duckoj/web test`):

```
 Test Files  73 passed (73)
      Tests  783 passed (783)
```

**The browser walk**, `--workers=1`, against the live edge:

```
  ✓  1 journey 1 — the monitor’s numbers are the API’s numbers, and the feed is live (44.7s)
  ✓  2 journey 2 — a teacher assembles a team in the form, and the one-seat rule names the pupil (2.9s)
  ✓  3 journey 2b — the panel shows the added pupil with no reload (1.2s)

  3 passed (50.0s)
```

**The D161 reload path, exercised rather than reasoned about.** The gate closes
when `loadNewer()` clears `seededFrom`, so `edit-form-conflict.spec.tsx`'s team
case now presses the reload button instead of only asserting it is on screen:
it moves the server's roster to `an, binh, chi` at `v2`, clicks, and asserts
the form comes back seeded from the newer roster and that the next save carries
`expectedVersion: 'v2'` with all three pupils. It was the one D176/D161 flow
this change touches that nothing clicked.

**Read this honestly:** the edge serves the pre-fix bundle and this slot builds
none, so the green walk proves the **walk** fix, not the product fix. The
product fix is proved by the jsdom pin (red before, green after) and by the
captured bytes above. `typecheck` and `lint` clean for `@duckoj/web`.

## Left standing

- **The deployed bundle is still defective.** Reverting F-50's web half would
  restore the accidental prefetch and hide it again; shipping `fa2bd11` is the
  real close. Either is a decision for the controller.
- `fe42-truong` now holds **30 teams** (26 when this slot opened; the two walk
  runs added two pairs). Journey 2's `alpha`/`bravo` teams are seeded into
  contests and refuse deletion, so `afterAll` cannot clear them and every run
  adds two. Teams list newest-first (D177) so the walk's own rows stay on page
  one, but the count is past the page size and growing.
- `apps/web/e2e/organiser.spec.ts` has pre-existing Prettier drift on lines
  unrelated to this change; left alone rather than mixed into the diff.
