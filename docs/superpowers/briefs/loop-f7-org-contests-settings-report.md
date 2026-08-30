# F7 — org-restricted contests + user settings (2026-08-29 feature/bug loop)

Six commits, one migration (0023). Ritual green: **1513 tests / 181 files**,
regen with no diff, `vite build`. **D56** rules the contests, **D57** the
settings; twenty mutants run, nineteen killed, one equivalent (below).

## A — organisation-restricted contests (D56)
`contest_orgs` meant only "who may SEE an `org`-visible contest" since 4c, so
attaching one to a PUBLIC contest — the case a school wants — meant nothing.
It restricts entry now too. Rulings:
- **403 `contest_org_required`, not 404** — no exception to 404-over-403:
  `loadVisible` has already shown this caller the contest and every response
  names the orgs restricting it, so nothing is left to conceal and a 404 reads
  as "the contest is gone". The old 400 is `contest_org_missing`.
- **The gate sits AFTER the idempotent live short-circuit**: only CREATING a
  participation is refused, so a school removing a pupil mid-contest does not
  delete it from under them. Admins exempt, the creator NOT — running a
  contest is not competing in it, so a setter can 403 on their own.
- **Attaching needs owner/admin of the org**, not membership — speaking for a
  school, which a pupil on its roster does not (problems keep the looser
  rule); already-attached ids exempt, or the edit form's resubmission of the
  stored list refuses every save. It also PUBLISHES the org's name, private
  ones included: a refusal that cannot name the school is unreadable.
- `orgSlugs` became editable (`PATCH` had none, so orgs were fixed for life);
  `?org=` on the list answers an empty page, never 404, for a slug naming
  nothing; `OrgSummary.myRole` so the forms offer only what the API accepts.
  Web: a shared `OrgPicker` keeps a slug this caller could not have added
  ticked AND visible, so an edit cannot drop it; badges on page and list.

## B — user settings (D57)
- **0023 makes `locale`/`timezone` nullable**, backfilling the old defaults to
  NULL. Under `NOT NULL DEFAULT 'vi'` there is no "has not chosen", so a
  server preference beating the browser would force vi onto every
  English-browser visitor and ICT onto everybody, undoing D18 for anyone who
  never opened a settings screen. "Follow my browser" sends `null`.
- **Adopted when the stored VALUE changes** — not per render (the bell
  refetches `['me']` each minute and would undo the `VI | EN` toggle), not per
  identity (which swallows the save just made).
- **Both recovery mails come in vi/en**, by prefix, NULL → vi, as whole
  paragraphs rather than catalogue keys (`syntheticMe` nulls both, D26). Every
  absolute formatter takes the zone and `null` passes no `Intl` option, so
  nothing shifts for anyone who has not asked.

## Tests (red → green, then mutated) and concerns
`contest-orgs.spec.ts` (8, `testDbUrl()`) + `user-settings.spec.ts` (5), 12
killed: gate never fires · gate before the short-circuit · membership as
authority · merged check on the stored set · org edit inserting without
removing · `?org=` ignored · summaries with no restriction · no
already-attached exemption · 0023 leaving `locale NOT NULL DEFAULT 'vi'` ·
mail locale ignored, and matched exactly not by prefix · `null` as absent.
Web (18 tests), 7 killed: picker offering every org · create not sending
`orgSlugs` · edit not seeding them · badges hidden · a cleared preference
omitted not nulled · zone ignored · sync keyed on identity.

**Concerns.** The survivor is *equivalent*: dropping `PreferenceSync`'s
applied-signature ref changes nothing observable — react-query's structural
sharing already keeps `me.data` stable across a no-change refetch; kept, with
a comment. Four web contest fixtures gained `orgs: []` (hand-built partials,
so tsc could not catch the new required field). Three api specs failed once
under load and passed alone — F6's flake. Not pushed.
