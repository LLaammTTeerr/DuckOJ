# Ledger — the `me` column: best, not latest

Supersedes Phase 3b's R8, which deferred "best" and shipped "latest" with two
disclosed limits. Both are now gone: the column shows the viewer's best result,
computed server-side, with no window.

| Deferred | Ruling |
|---|---|
| No "solved count" or per-problem statistics | Still needs an aggregate the API does not expose. Named in 3b's deferred table and unchanged |
| `me` is not shown on the submissions list | It is per-problem by definition; the submissions list already shows each submission's own verdict |

---

## R1 — the index shipped with the feature, and the suite could not have caught its absence

`submissions` carried **only its primary key**. A per-problem lookup without an
index sequentially scans the whole table once per row of the list — fifty scans
for one page, worsening with every submission the system ever takes.

Every test in this repository runs against a corpus of a dozen rows, so this is
a failure the suite is **structurally incapable** of seeing. The implementer
verified the fix the only way that works: `EXPLAIN` against 2000+ rows, showing
Index Scan and no Sort.

    CREATE INDEX submissions_user_problem_points_idx
      ON submissions (user_id, problem_id, points DESC NULLS LAST, id);

It also found that the lateral's `ORDER BY` had to say `points desc nulls last`
to match drizzle-kit's index default, or Postgres added a Sort despite the
index existing. An index that is present and unused is the most expensive kind.

## R2 — the test that separates correct from plausible

`me.maxPoints` comes from the **submission**, not the problem's current
revision: a submission graded against revision 2 was scored out of revision 2's
total. In every fixture where a problem has one revision the two are equal, so
a wrong implementation passes everything else.

Proved by mutation on a two-revision fixture: reading the current revision's
total (50) instead of the submitting revision's (100) flipped the test.

## R3 — a defect I introduced by omission, and the fix

Excluding CE and IE from "best" candidacy meant a student whose only
submissions were CE saw an **empty cell — identical to never having attempted
the problem**. The column actively misinformed the person it exists for, and
beginners hit CE more than anyone.

`event-writer.ts:69-73` records CE with `points: 0` and no `maxPoints`; the IE
path at :129-132 records neither. So the exclusion was the only thing the
contract allowed, which made it a contract defect rather than a query one.

Both fields are now nullable and every judged submission is a candidate,
ordered `points DESC NULLS LAST, id ASC` — an IE (null points) sorts last and
can never mask a real WA; a CE (points 0) ties with a 0-scoring WA and loses on
the earlier id.

## R4 — the implementer corrected my instruction, and I was wrong twice in it

I wrote "make `maxPoints` nullable; `points` is already nullable for IE."
**It is not.** `event-writer.ts`'s IE path sets neither field, so leaving
`points: z.number()` non-nullable would have made a real IE-only submission
fail response validation at runtime — a 500 on a page that was working.

I also said `apps/web` would need to handle a null `maxPoints` because "the
column shows points as `x/y`". It does not: `problems.tsx` renders only
`me.verdict`. That `x/y` pattern lives on the separate `/submissions` page.

Two wrong claims in one instruction, both about files I had open earlier in the
session. Nineteenth and twentieth across five phases.

## R5 — a claimed diff was verified rather than accepted

The implementer described a ~1100-line `openapi.json` change as "cosmetic path
reordering". I asked for that to be confirmed rather than asserted, because a
content change can wear a reordering's clothes. It sorted both sides' path keys
and diffed by script: **28/28 keys identical**, with real content differences
in exactly `/problems` and `/problems/{code}` — the `me` field. Everything else
was genuinely reordering.

Worth recording as a habit rather than an incident: "it's just formatting" is a
claim, and claims about a 1100-line diff are cheap to check and expensive to be
wrong about.
