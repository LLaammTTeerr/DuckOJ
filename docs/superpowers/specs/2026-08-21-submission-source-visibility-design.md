# Submission source visibility: design

**Status:** approved for implementation (user-specified rules).
**Predecessors:** `2026-08-21-phase-3b-surfaces-design.md`.

---

## 1. The problem

`submissions.source` is stored `NOT NULL` and read by exactly one consumer:
`apps/judged`'s job store, handing code to a judge. `SubmissionDetailDto` has
no `source` field, so **nobody can ever see what they submitted** — not the
author, not an admin, not over HTTP at all.

This was never decided. Phase 1 built submit-and-grade and viewing your own
code afterwards was simply not in scope.

## 2. The rules

As specified:

| Viewer | May view |
|---|---|
| The submitter | Their own submissions, always |
| A global admin | All submissions |
| An `author` or `curator` of the problem | All submissions **to that problem** |
| A user with an `AC` on the problem | Others' submissions to it, **only if the problem enables it** |

### 2.1 This widens submission visibility, not just a field

The obvious reading is "add a `source` field with its own rule". That is
wrong. "A curator may view their problem's submissions" means the **submission
itself** becomes visible — its verdict, its timings, its cases. A curator who
can read the source but gets a 404 on the submission is incoherent.

So `canViewSubmission` widens from *"yours or admin"* to the table above, and
`source` rides along on the submission the viewer is already allowed to see.

### 2.2 Testers are excluded, deliberately

`problem_members` has three roles. A `tester` exists to proofread a problem
before it is public — that is a reason to see the *problem*, not a reason to
see other people's *solutions* to it. Only `author` and `curator` are named in
the rules above, and adding `tester` later is a one-line widening; removing it
after testers have read submissions is not.

### 2.3 The per-problem flag

```sql
CREATE TYPE problem_source_access AS ENUM ('private', 'solved');
ALTER TABLE problems
  ADD COLUMN source_access problem_source_access NOT NULL DEFAULT 'private';
```

- `private` — the default. Only the first three rows of the table.
- `solved` — additionally, anyone with an `AC` on this problem.

**Deny by default.** Every existing problem gets `private`, so this migration
cannot widen access to anything that already exists.

A third value `public` (anyone who can see the problem) is **not** added.
Adding an enum member later is cheap and this project has done it once already
(`CE`); granting access that was never asked for is not.

### 2.4 What "has an AC" means

At least one submission by this viewer, on this problem, with
`verdict = 'AC'`. Not "solved the current revision" — a viewer who solved
version 2 keeps access when version 3 publishes. Tying it to a revision would
silently revoke access on every republish, which is worse than the alternative
and would surprise everyone.

---

## 3. The risk that dominates this change

Phase 3b extracted `apps/api/src/authz/submission.visibility.ts` with two
forms of one predicate — `canViewSubmission(actor, ownerId)` for a row in hand
and `visibleSubmissionsWhere(actor)` for a `WHERE` clause — precisely so
`GET /submissions` and `GET /submissions/:id` cannot disagree. That agreement
is pinned by a test asserting the list returns exactly the ids the single read
allows, proved in both directions by mutation.

**Both forms must widen identically.** The row form now needs the problem's
`source_access`, the viewer's roles on that problem, and whether the viewer has
an AC — three facts a `WHERE` clause must express as joins or subqueries. If
the SQL form widens differently from the row form, the agreement property
breaks and the failure is a visibility leak.

The existing bidirectional test must still pass **unchanged in intent**, and
must be extended to cover every new row of the table. If it needs editing to
accommodate the widening, that is a signal the widening is wrong, not that the
test is stale.

## 4. Testing

1. **The list/read agreement, extended.** For a corpus with several users,
   several problems, and a mix of `source_access`, the ids returned by
   `GET /submissions` must equal the ids for which `GET /submissions/:id`
   returns 200 — asserted as one property, for **each** viewer kind in §2's
   table.
2. **`source` is present exactly when the submission is visible.** Not a
   separate rule: if the viewer can see the submission they see the source.
   Assert there is no combination where the submission is 200 and `source` is
   absent or null.
3. **The default is closed.** A problem with no explicit `source_access` must
   not expose source to an AC-holder — proving the migration's default.
4. **A tester is refused**, distinguishing §2.2 from a "any member" reading.
5. **AC on an older revision still grants access** (§2.4), and a `WA`-only
   submitter is refused.
6. Every new test demonstrated to fail against unfixed code.

## 5. Out of scope

Making source visibility settable through the web UI (the API carries it;
`PATCH /problems/:code` gains the field, the authoring screen does not yet
render it) · a `public` source-access value · testcase visibility, which is a
separate DMOJ concept and a separate decision · source visibility during a
contest, which belongs with Phase 4's contest rules and will likely need to
override all of the above.
