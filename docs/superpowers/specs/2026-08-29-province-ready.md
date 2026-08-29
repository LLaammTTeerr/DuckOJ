# Province-ready campaign (2026-08-29, autonomous)

**Directive:** "automate every process including UI and stuff until we got a
fully functional OJ that can be served for at least a province in Vietnam …
never wait for a continue command, loops until you done or limit ran out."
Tool choices are delegated (installing load/e2e tooling is authorised).

**Definition of done — "a province can run on it":**
a school-district admin can stand it up from a clean host, mint the first
admin, import Polygon problems, run rated school contests with a frozen
scoreboard, rejudge after a broken test, handle 2k concurrent students on
contest day, survive a reboot and a disk restore, all in Vietnamese.

## Phases (strike through when its ledger exists)

0. **Availability.** Stack is DOWN (all containers exited 2026-08-25).
   Bring up; make reboot-proof (systemd user unit + linger); verify.
1. **Ops features un-deferred.** Rejudge (`POST /admin/submissions/{id}/rejudge`,
   `POST /admin/problems/{code}/rejudge`); contest edit (`PATCH /contests/{key}`);
   disqualify (`PATCH /contests/{key}/participants/{username}`); login rate
   limiting via `rate_events`; TOTP enrollment UI; scoreboard freeze
   (`freezeMinutes` on contest, hidden after freeze for non-admins);
   float-precision display.
2. **Vietnamese.** UI i18n — `vi` default, `en` toggle, persisted; diacritics
   font check on every screen; statements stay bilingual per D10.
3. **Province-scale ops.** Nightly `pg_dump` + package-store backup with a
   tested restore script; judged concurrency knob; k6 load smoke at 2k VUs
   against the live stack; results recorded.
4. **Bootstrap + content.** `scripts/bootstrap-admin.ts` for the first admin;
   seed 5 demo problems through polygon-import → buildPackage → POST.
5. **Prove it.** Playwright journey (register → login → submit → contest →
   scoreboard → admin rejudge); full verify ritual; whole-branch review;
   redeploy; final report.

Stretch (only if budget remains): contest clarifications/announcements,
problem tags, editorials.

## Stated constraints, not solved here

- **SMTP** is external: env-driven, documented, assumed provided by the
  province's IT. Without it verification/reset mails silently no-op.
- **Zero interaction**: every ambiguity is ruled and ledgered, never asked.
- **Agent budget**: fewer, larger, sequential dispatches; commit after each
  task so a kill costs minutes.

Ledger: `docs/superpowers/ledgers/2026-08-29-province-ready-ledger.md`.
