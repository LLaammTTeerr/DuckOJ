# B31 — bug hunt: data integrity (2026-08-31)

First systematic sweep of referential integrity, orphans/invariants and uniqueness. Read the conventions,
D11/D58/D100/D104, every schema file, all 40 migrations, the B-28 report. Two schema bugs fixed (migration 0040,
mutation-checked); a standing audit shipped and run read-only on live.

## Fixed — commits 939da9b, f54641d

1. **A contest delete walked AROUND migration 0016's RESTRICT and emptied the scoreboard (HIGH, latent).** 0016
   made `contest_submissions.contest_problem_id` restrict so a scoreboard "must never vanish silently"; but
   `contest_participations.contest_id` cascaded from `contests` and `contest_submissions.participation_id` cascades
   from the participation, so `DELETE FROM contests` took the second path and removed the children before the
   restrict saw anything. Throwaway: `DELETE 1`, `contest_submissions` left = **0**, no error — history (D11) gone.
   Fix: that key → `restrict`; a contest anybody entered is refused, an unentered one still deletes (both pinned).
   Latent: nothing deletes a contest today — the door is a psql session in an incident.
2. **Whether that RESTRICT fired AT ALL depended on RI-trigger creation order (HIGH, same class).** Found during
   the mutation check: re-adding the participation key as `cascade` made the delete *refuse* — re-adding moved its
   trigger last, letting `contest_problems`' cascade go first. The old behaviour turned on which migration last
   rewrote which constraint; hence fixing (1) at the key rather than leaving it to ordering.
3. **`problems.current_revision_id` had NO foreign key (HIGH).** The one id column in the schema without one, and
   it picks the package that grades a submission: `submission.access.ts:246` loads the revision by this id alone,
   never re-checking whose problem it is, so a crossed pointer grades one problem against another's tests, silently
   and forever. Fix: composite key `(id, current_revision_id) → problem_revisions (problem_id, id)` — the fact
   worth stating is "a revision OF THIS PROBLEM". `MATCH SIMPLE` leaves an unpublished NULL alone, `NO ACTION`
   keeps deletes working; hand-written, as drizzle cannot express a forward composite reference.

Mutations: drop the participation change → contest-delete test red; drop the composite key → crossed-revision test
red; drop the new unique index → the migration itself fails. `packages/db/test/referential-integrity.spec.ts`: 10
tests, 4 red before 0040, all green after. It also pins two literals — all 68 foreign keys with their delete rule
(`pg_constraint`), and every uniqueness rule the product assumes (`pg_get_indexdef`). Plus 0040, comments, **D126**.

`scripts/integrity-check.ts` — 23 checks for what no key can state; one list, two transports (`--url`; `--live` via
`podman exec … psql`, the deployed Postgres publishing no host port), both with `default_transaction_read_only` on:
enforced, not promised (a `CREATE TABLE` through the live path errors). Exit 0/1/2. Its spec drives the CLI as a
subprocess over a fixture planting one violation of **every** check on an FK-satisfying database — a check whose
SQL is wrong would report a clean database forever, which is worse than no check at all.

**Live integrity-check** (read-only, `duckoj_postgres_1`). `23 checks, 0 with violations (high 0, medium 0, low 0)`
over 333 users, 47 problems, 98 contests, 159 participations, 192 seats, 714 submissions, 155 contest submissions,
104 counter rows, 128 solvers, 141 notifications, 15 similarity runs. First production evidence **B-28's counter
fix holds** (stats vs truth and stats.solvers vs the set both exact) and **no seat has drifted since D104**. Also
probed clean: 0 dangling/crossed `current_revision_id`, so 0040 needed no dedupe.

**Cleared, with evidence.** Team disband (FK restrict + pre-check → 409 `team_has_participations`, race caught)
correct, pinned both ways. Every uniqueness rule the product assumes already exists in SQL — usernames, emails,
contest keys, org/team/set slugs and problem codes all `lower()`; one participation per (contest, user, virtual);
one team participation per contest; one seat per (contest, user); one published revision per problem. `tags.slug`
is the only case-SENSITIVE slug and is moot (fixed 0018 vocabulary, no write endpoint, `tag_id` restrict).
`judge_node_id set null` keeps history on retirement (D68); a participation takes its seats with it (D104).

**Concerns.**
- `submissions.user_id`, `problem_comments.author_id` and `contest_clarifications.asked_by` **cascade on `users`**
  — against D11 and the tombstone design, while `similarity_runs.requested_by` chose `set null` ("the run outlives
  the account"). No user-delete path exists, so a booby trap rather than a bug; decide it before a delete-account
  endpoint lands (`parent_id cascade` would also take other authors' replies).
- Removing an org member **leaves their `team_members` rows** (via `DELETE /orgs/:slug/members/:username`). Live
  count 0; made a standing check, not a code change — which way it should resolve is a product question with nobody
  to ask.
- `rating_event` is empty live, so those two checks are wired but unexercised. Throwaway `b31_pg` removed; the
  live stack was never written to, stopped or rebuilt.
