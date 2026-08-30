# F16 — similarity reaper + student progress page (D83)

**DONE_WITH_CONCERNS.** On `main`, not pushed: `de08363` reaper · `4ec5999` API
+ contracts + SDK · `436248d` web + i18n · D83 + this report. **No migration**
(0031 not needed). Ritual green: typecheck + lint (incl. `:scripts`), **api
905/905 (101 files)**, **web 450/450 (44)** and every other package; regen no
diff; `vite build` OK.

## A — the reaper (F15's first concern)
`apps/api/src/authz/similarity.reaper.ts`, `ExpiredRowsSweeper`'s shape: a
5-minute `unref`'d interval, no sweep at boot, failures are log lines, bounds
injected. A `running` row older than 15 min **or** predating this process's boot
is a candidate; it is marked `failed` / `abandoned` only where
`pg_try_advisory_xact_lock(SIMILARITY_LOCK, contest_id)` succeeds — a live run
holds that lock for its whole transaction, so the lock, not the clock, says
"nobody is running this", and it makes the process-start branch safe on a forked
cluster. One transaction per contest; the UPDATE restates `status = 'running'`
so a run landing mid-sweep is never stamped over.

## B — `/me/progress` and its public half
`ProgressService` (`authz/`, six guarded tables, `ScoreboardCache.through` at
60 s, one key per user per shape). `GET /users/me/progress` — `users:read`, no
`@Public`, mirroring `/users/me` (**this build has no `profile:read` scope**);
`GET /users/{u}/progress` — `@Public` + `users:read`, mirroring the profile; `me`
declared first; tag `Users`. Payload: tag and difficulty bars (per PROBLEM, not
per submission), a 365-day heatmap, and — owner only — streak, last ten
verdicts, open contests, dated homework with completion. Web: `.stat` tiles, an
SVG heatmap in `.grid-scroll` with `tabindex` (m21) and a `<title>` per cell,
SVG bars and a sparkline off the paged rating history, all in `--fg` at five
opacities — no new CSS class, no chart library. "Tiến độ" in **both** navs
(D76); the profile gets bars + calendar only. vi/en, 39 keys each.
**Rulings, in D83.** D49's `contestWindowOpenWhere` is the ONE exclusion for
every outcome (bars, streak) — **not** D23's freeze, which never masks a
submitter from themselves and cannot be cached; it is D35's mask for free. The
heatmap and `recent` are deliberately NOT excluded (existence is public; your
own verdicts are yours). Public counts public problems only, your own page every
problem you submitted to; days bucket in the SUBJECT's zone in SQL (D57, `NULL`
→ ICT); homework completion is D66's pupil view — every AC, late included.

## Tests — 21 api + 9 web, 25 mutants killed
`similarity-reaper.spec.ts` (5) + an end-to-end in `contest-similarity.spec.ts`
(409 → reap → 201), **4 mutants**: lock check · age branch · process-start
branch · the UPDATE's `status` clause. `user-progress.spec.ts` (15,
`testDbUrl()`), **12**: visibility filter · the window exclusion off the
bars and off the streak · the heatmap in UTC · a streak dying at midnight · an
attempt counted as a solve (twice) · per-submission grouping · homework ignoring
WHOSE membership · a passed deadline · a closed window · the owner's object on
the public route. `progress.spec.tsx` (9), **9**: the heatmap
walking only served days · the scroller losing `tabindex` · fetching while
signed out · the panel reading the owner's route · empty-bar copy · a one-point
sparkline · a flat ramp · the nav link gone from either IA.

## Concerns
- **15 minutes is a guess**; the lock is what makes it safe, and a longer run
  is protected only while its transaction lives.
- `/users/me/progress` runs **seven aggregates on a miss**, cached per user — 40
  pupils opening it at once is 40 cold folds. No index added, unmeasured at
  province size, and the heatmap's `at time zone` day is not sargable.
- The streak's "longest" is the longest **within 12 months**, unlabelled; the
  rating shown is the last `rating_event`, not `users.rating`; no Playwright.
