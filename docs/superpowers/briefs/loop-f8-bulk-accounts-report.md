# F8 — bulk student accounts for a school (2026-08-29 feature/bug loop)

Five commits, one migration (0024), **D61**. Ritual green: typecheck (incl.
scripts), lint, **1570 tests / 184 files**, regen no-diff, `vite build`.
Twenty-nine mutants applied, **twenty-nine killed**. Not pushed.

## Shipped
**`POST /orgs/{slug}/members/import`** (`Organizations`, `@SessionOnly`). CSV
or JSON, ≤ 2000 rows. Validates first; one bad row ⇒ **422
`member_import_invalid`, nothing created**, every failure in `fields` keyed
`rows[<n>].<field>`. Otherwise accounts with 12-char generated passwords (no
`I L O i l o 0 1`), `must_change_password`, added as `member`; passwords
returned once as an array **and** a `csv`. `dryRun` previews, consuming no
meter; a real import is one per org per minute (`consumeOnce`, keyed on org
**id** — a slug is patchable). **`POST /auth/password/change`** — there was
none: `currentPassword` required except while flagged; clears it, kills every
session and token, re-issues a cookie. `mustChangePassword` joins `MeResponse`
(`syntheticMe` → `false`, D26). **Web:** "Nhập danh sách học sinh" for an
owner/global admin — file or textarea → **check** (`dryRun`) → row-by-row
errors or preview → **create** → credentials as a `@media print` table + a
`download` link + a copyable textarea (each of the three fails somewhere);
`/account/password`; `PasswordGate` swapping `<Outlet />` while flagged; vi/en.
Plus **`corepack pnpm org:import <slug> <file.csv> [--dry-run] [--out f]`**.

## Rulings (all recorded in D61)
- **The CLI goes through the DB, not the API** — the route is `@SessionOnly`,
  so the brief's "admin token" option does not exist. Not a second copy: the
  rule is `apps/api/src/authz/org-import.core.ts`, framework-free because
  `scripts/tsconfig.json` has no decorators (`password.hash.ts`'s precedent).
  It writes the owners' notification itself — `NotificationsService` is
  `@Injectable`, so routing it there would mean the CLI silently sent none.
- **Owner or global admin, NOT an org `admin`** (`loadForOwner`, new).
  **Placeholder `<user>@<slug>.import.invalid`, marked verified** (D19's
  reason); a *supplied* address stays unverified. **A taken address is named
  in the 422** — a recorded narrowing of D26 in one owner-gated, session-only,
  metered place. **The flag is enforced by the web, not the API.**
- **The 100 KB JSON limit stays everywhere but this path**, which gets 2 MB
  from a parser mounted ahead of the default; a global raise would undo the
  `413` the smoke spec pins.

## Tests (green, then mutated)
`apps/api/test/org-member-import.spec.ts` (16, `testDbUrl()`), 15 killed —
duplicate check and taken-lookup not case-folded · validation non-fatal ·
dryRun burning the meter · org admin admitted · 403 before 404 · flag not set ·
verification marker inverted · current password never required · flag never
cleared · sessions surviving · notification fanned to every member · first
record always a header · sheet never quoting · `csv`+`rows` preferring one.
`app.smoke.spec.ts` +2, both killed — dropping the explicit default parser
fails **the existing 413 test too**, which is what proved Nest skips its own
parser once one is named. Web (8), 9 killed; the CLI (4, subprocess), 5.

## Concerns
**Wall time.** 2000 rows ≈ 2000 argon2id hashes: ~18–25 s measured here, at
concurrency 4 on a shared libuv pool. Bounded and metered, but a full import is
a slow request and a proxy or browser timeout would strand it — accounts
created, passwords lost. Not exercised at 2000 against the live stack.
A racing unique violation **after** `consumeOnce` still spends the minute.
`@duckoj/contracts` is now a root dependency so the shared core resolves from
`scripts/` (`pnpm-lock.yaml` moved). An imported `email` is never nullable, so
a real address learned later is edited through the profile.
