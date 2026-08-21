# The `me` column: best verdict, server-side

**Status:** approved for implementation (user-directed).
**Supersedes:** Phase 3b ledger R8, which deferred "best" and shipped "latest".

---

## 1. What is wrong today

The problem list's `me` column is derived **client-side** from one
`GET /submissions?user=<self>&limit=100` per page render. Two consequences,
both user-visible:

- It shows the **latest** verdict, not the best. Solve a problem, submit junk
  afterwards, and the list says `WA`.
- A problem outside the viewer's most recent 100 submissions shows **nothing**,
  even when they solved it.

The second gets worse the more a user submits, which is exactly backwards.

## 2. The change

`me` moves onto `ProblemSummary` and `ProblemDetail`, computed server-side:

```ts
me: { verdict: Verdict; points: number; maxPoints: number } | null
```

`null` for an anonymous caller and for a problem the viewer has never
submitted to — those are the same thing to a reader and need not be
distinguished.

The web app then drops its `GET /submissions?user=` call entirely. One request
becomes zero, and the 100-row window disappears rather than being widened.

## 3. What "best" means

**Maximum `points`. Ties broken by the earliest submission.**

Not "AC if any AC exists" — with partial scoring an accepted submission already
holds maximum points, so max-points yields `AC` whenever one exists, without a
special case. A rule with no special case is one fewer thing to get wrong.

Earliest-on-tie matters: a viewer who scores 60 twice should see the first, so
the column is stable as they keep submitting.

**`maxPoints` comes from the same submission**, not from the problem's current
revision. A submission graded against revision 2 was scored out of revision 2's
total, and showing it against revision 3's total would misreport history —
this is the same reasoning that pins `submissions.revisionId`.

## 4. The index is not optional

`submissions` today carries **only its primary key** (verified against the live
database). A per-problem lookup would therefore sequentially scan the whole
table once per row in the list — 50 scans for one page, worsening with every
submission the system ever takes.

```sql
CREATE INDEX submissions_user_problem_points_idx
  ON submissions (user_id, problem_id, points DESC, id);
```

`id` last so the earliest-on-tie ordering is served by the index rather than a
sort.

**Ship the index in the same migration as the feature.** A correlated lookup
added without it is a latent outage that only appears under real data, which is
the failure mode this project has least ability to see — every test runs
against a corpus of a dozen rows.

## 5. Implementation shape

A `LEFT JOIN LATERAL` per problem, scoped to the viewer, inside the existing
list query — **not** a second round trip and not a per-row query. The list must
remain one statement.

For an anonymous caller the lateral is omitted entirely rather than joined
against a null user id: a query that filters on `user_id = NULL` returns no
rows but still costs the join.

## 6. Testing

1. **Best, not latest** — AC then WA on the same problem shows `AC`. This is
   the whole point and must fail against the current implementation.
2. **Beyond the window** — a viewer with more than 100 submissions still sees a
   verdict on their oldest solved problem. This is the bug the client-side
   version cannot fix at any limit.
3. **Ties take the earliest.**
4. **`maxPoints` follows the submission**, not the problem's current revision:
   solve against revision 1, publish revision 2 with a different total, assert
   the reported `maxPoints` is still revision 1's.
5. **Anonymous gets `null`**, and the query plan omits the lateral.
6. **One statement.** Assert the list issues a single query regardless of page
   size — a regression to per-row lookups is invisible to every other test.
7. Every new test demonstrated to fail against unfixed code.

## 7. Risk

**Test 4 is the one most likely to be got wrong**, because in every fixture
where a problem has one revision, the submission's `maxPoints` and the
problem's current total are equal — so a wrong implementation passes. It needs
a fixture with two revisions of differing totals, and that fixture is the only
thing separating a correct implementation from a plausible one.
