CREATE TABLE "contest_problem_solvers" (
	"contest_problem_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	CONSTRAINT "contest_problem_solvers_contest_problem_id_user_id_pk" PRIMARY KEY("contest_problem_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "contest_problem_stats" (
	"contest_problem_id" bigint PRIMARY KEY NOT NULL,
	"submitted" integer DEFAULT 0 NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"solvers" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contest_problem_solvers" ADD CONSTRAINT "contest_problem_solvers_contest_problem_id_contest_problems_id_fk" FOREIGN KEY ("contest_problem_id") REFERENCES "public"."contest_problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problem_solvers" ADD CONSTRAINT "contest_problem_solvers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problem_stats" ADD CONSTRAINT "contest_problem_stats_contest_problem_id_contest_problems_id_fk" FOREIGN KEY ("contest_problem_id") REFERENCES "public"."contest_problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contest_problem_solvers_user_idx" ON "contest_problem_solvers" USING btree ("user_id");--> statement-breakpoint
-- D100 backfill: the counters must describe every contest that has already
-- been run, or the first monitor opened after this deploy reports zeros for a
-- finished contest. `contest_problem_solvers` first, because
-- `contest_problem_stats.solvers` is its cached count and the two are written
-- in that order everywhere else too.
INSERT INTO "contest_problem_solvers" ("contest_problem_id", "user_id")
SELECT cs."contest_problem_id", part."user_id"
  FROM "contest_submissions" cs
  JOIN "submissions" s ON s."id" = cs."submission_id"
  JOIN "contest_participations" part ON part."id" = cs."participation_id"
 WHERE s."verdict" = 'AC'
 GROUP BY cs."contest_problem_id", part."user_id";--> statement-breakpoint
-- A row for EVERY contest problem, including the ones nobody has touched: a
-- read left-joins this table so an absent row is already zero, but a complete
-- backfill is what makes "no row" mean "added after 0037" rather than
-- "possibly missed".
INSERT INTO "contest_problem_stats"
  ("contest_problem_id", "submitted", "accepted", "solvers", "pending")
SELECT cp."id",
       count(cs."id"),
       count(*) FILTER (WHERE s."verdict" = 'AC'),
       count(DISTINCT part."user_id") FILTER (WHERE s."verdict" = 'AC'),
       count(*) FILTER (WHERE cs."id" IS NOT NULL AND s."state" NOT IN ('done', 'errored'))
  FROM "contest_problems" cp
  LEFT JOIN "contest_submissions" cs ON cs."contest_problem_id" = cp."id"
  LEFT JOIN "submissions" s ON s."id" = cs."submission_id"
  LEFT JOIN "contest_participations" part ON part."id" = cs."participation_id"
 GROUP BY cp."id";
