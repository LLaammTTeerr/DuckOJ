ALTER TABLE "submissions" ADD COLUMN "subtask_summary" jsonb;--> statement-breakpoint
-- `extra_float_digits` decides how many digits `to_jsonb(double precision)`
-- writes, and at 0 it writes too few: 48 861 of 50 000 generated values failed
-- to round-trip on this cluster. Anything above 0 is Postgres' shortest
-- exactly-round-tripping form (verified at 1, 2 and 3 on 100 000 values each),
-- and `local` confines the change to this migration's transaction. Without it
-- a backfilled summary would differ from the case rows it summarises in the
-- last bits — a wrong scoreboard, reported as a right one.
SET LOCAL extra_float_digits = 3;--> statement-breakpoint
-- The backfill, over each submission's LATEST attempt only — the same rows,
-- reduced the same way, as the fold used to reduce in JavaScript.
--
-- `sum(... ORDER BY id)` is the whole reason this is a backfill and not the
-- fold's own query. An ordered aggregate sets `numOrderedAggs > 0`, which
-- disables both hash aggregation and parallel aggregation, so per-fold it
-- costs more than the read it was meant to replace (D166 has the measurements)
-- — but it is exactly right run once, because `points` is `double precision`
-- and the fold accumulates the loose group with `+` in `submission_cases.id`
-- order. An unordered `sum` here would be a different number.
UPDATE "submissions" AS s
   SET "subtask_summary" = g.summary
  FROM (
    SELECT c.submission_id,
           jsonb_agg(
             jsonb_build_object(
               'batch',     c.group_index,
               'minPoints', c.min_points,
               'maxTotal',  c.max_total,
               'sumPoints', c.sum_points,
               'sumTotal',  c.sum_total
             )
             ORDER BY c.first_id
           ) AS summary
      FROM (
        SELECT sc.submission_id,
               sc.group_index,
               min(sc.id)                        AS first_id,
               min(sc.points)                    AS min_points,
               max(sc."max_points")              AS max_total,
               sum(sc.points ORDER BY sc.id)     AS sum_points,
               sum(sc."max_points" ORDER BY sc.id) AS sum_total
          FROM "submission_cases" sc
          JOIN (
            SELECT "submission_id", max("attempt") AS a
              FROM "submission_cases"
             GROUP BY "submission_id"
          ) la ON la."submission_id" = sc."submission_id" AND la.a = sc."attempt"
         GROUP BY sc."submission_id", sc."group_index"
      ) c
     GROUP BY c.submission_id
  ) g
 WHERE s.id = g.submission_id
   AND s."state" IN ('done', 'errored');--> statement-breakpoint
-- A submission that finished without grading a single case — a compile error,
-- an internal error before the first test — summarises to the empty list, not
-- to null. Null means "ask the case rows", and asking them forever for a
-- submission that has none is the residue read never emptying.
UPDATE "submissions"
   SET "subtask_summary" = '[]'::jsonb
 WHERE "subtask_summary" IS NULL
   AND "state" IN ('done', 'errored');
