# Loop F35 — printable seat slips (D129)

## Shipped
`GET /contests/{key}/seats.pdf` (tag `Contests`, `contests:read`, no `@Public`):
eight cards to an A4 portrait sheet on dashed cut lines — contest name, display
name, account (a team lists every member, D99), the window in the caller's
timezone, `PUBLIC_ORIGIN`, a blank rule for room/seat. Reuses D71's path:
`escapeText`, `canRunContest`, the 60 s content-addressed cache
(`X-Seats-Cache`, `duckoj:seats:v1:`), 501 with no typst, authz before render.

Files (under `apps/api/src` unless noted): `statements/seats.ts` (new builder),
`statements/results.cache.ts`, `statements/markdown-to-typst.ts` (D64's
`resolveZone`/`offsetLabel` exported), `authz/contest.access.ts`
(`readerTimeZone` public), `contests/results.service.ts`,
`contests/contests.controller.ts`, `app.setup.ts`;
`packages/contracts/src/contests.ts` + regen artifacts;
`apps/web/src/routes/contests.tsx` + `contest.seats` in `i18n/{vi,en}.ts`.

## Rulings (D129 in docs/DECISIONS.md)
No password, ever — D61's import returns credentials once and keeps only hashes,
so nothing re-derivable exists to print. Link gated on `canEdit` ALONE, not
`phase === 'finished'`: slips are cut the night before, so D71's clock gate
would hide the feature for its whole useful life. Virtual replays dropped
(no desk); a disqualified row kept (a seat was still allocated). Cards ordered
by display name in `vi` collation — the pre-gun board order is incidental and a
document that reorders never hits its own cache. The caller's timezone IS the
organiser's (`canRunContest` refused everyone else). Fixed 6.4 cm rows so a cut
stack lines up. No school, rank or score on a card.

## Tests
`apps/api/test/contest-seats.spec.ts` (20) — 11 builder, 2 typst-compile (worst
case: full sheet + team of three + a name of pure typst syntax), 7 route on
`testDbUrl()`: 401 anon, 404 invisible / 403 non-runner with the renderer
untouched, 501 with no typst, pre-start sheet with cache miss→hit, one card per
team, organiser timezone, hostile name on the wire. Web spec +3.
Red→green: builder written against a missing module; `cors-exposed-headers`
red on `x-seats-cache` before `app.setup.ts` grew it. Mutations, each seen red
then restored — dropped `escapeText` (3 red), removed `sortRows` (1), removed
the `virtual === 0` filter (1), hardcoded the timezone (1), added
`phase === 'finished'` to the web gate (1).

## Left out / concerns
Nothing from the brief. One flake, not reproduced: `apps/web`'s `submit.spec.tsx`
failed once under that package's parallel `test` script, then passed on a full
rerun (604/604) and alone. Unrelated to this work.
