CREATE TABLE "problem_language_limits" (
	"problem_id" bigint NOT NULL,
	"language_id" bigint NOT NULL,
	"time_multiplier_pct" integer,
	"memory_extra_kb" integer,
	"allowed" boolean DEFAULT true NOT NULL,
	CONSTRAINT "problem_language_limits_problem_id_language_id_pk" PRIMARY KEY("problem_id","language_id")
);
--> statement-breakpoint
ALTER TABLE "languages" ADD COLUMN "time_multiplier_pct" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "languages" ADD COLUMN "memory_extra_kb" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_language_limits" ADD CONSTRAINT "problem_language_limits_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_language_limits" ADD CONSTRAINT "problem_language_limits_language_id_languages_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."languages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- F-39 / D154. The judge has run since 2026-08-20 with exactly one language
-- row, `cpp17`. Schools in this province teach Python first and C++ second,
-- so a pupil who only knows Python could not submit at all.
--
-- Idempotent by key, because this is a seed and not a fact about the schema:
-- re-running it must not duplicate `cpp17` (which predates this migration and
-- keeps its id, and therefore its `submissions.language_id` references), and
-- must not overwrite an operator's later edit to a multiplier. `DO NOTHING`,
-- never `DO UPDATE`.
--
-- The executor names are NOT the ones the brief guessed. They are the ones
-- the live judge's own self-test announces, read out of
-- `dmoj/executors/*.py` in the running image:
--   * there is no `C17` executor. `C` compiles `-std=c99` and `C11` compiles
--     `-std=c11`; nothing in the image compiles C17. The row is therefore
--     named `c11` and maps to `C11` — a language key named `c17` that
--     compiled C11 would be precisely the lie `language_driver_keys` exists
--     to prevent.
--   * `python3` maps to `PY3`, which is the first key whose executor is not
--     simply its own name uppercased.
INSERT INTO "languages" ("key", "name", "extension", "is_active", "time_multiplier_pct", "memory_extra_kb")
VALUES
  ('cpp17',   'C++17',    'cpp', true, 100, 0),
  ('cpp20',   'C++20',    'cpp', true, 100, 0),
  ('cpp14',   'C++14',    'cpp', true, 100, 0),
  ('c11',     'C11',      'c',   true, 100, 0),
  -- 300 % and +32 MB. Measured on this judge's own image: a tight arithmetic
  -- loop costs 1.322 s in CPython 3.11.16 against 0.012 s in g++ 12 -O2
  -- (110×), and CPython's resident floor before the solution allocates
  -- anything is 15044 KB. See D154 for why the multiplier is 3 and not 110.
  ('python3', 'Python 3', 'py',  true, 300, 32768)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "language_driver_keys" ("language_id", "driver", "executor_key")
SELECT "languages"."id", 'dmoj', v."executor_key"
  FROM (VALUES
    ('cpp17',   'CPP17'),
    ('cpp20',   'CPP20'),
    ('cpp14',   'CPP14'),
    ('c11',     'C11'),
    ('python3', 'PY3')
  ) AS v("key", "executor_key")
  JOIN "languages" ON "languages"."key" = v."key"
ON CONFLICT ("language_id", "driver") DO NOTHING;
