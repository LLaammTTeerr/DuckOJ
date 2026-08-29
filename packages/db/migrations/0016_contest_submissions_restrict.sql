-- B1 follow-up (final-review.md): a contest submission's link to its contest
-- problem must never vanish silently. The edit path now diffs the problem
-- list (D28) and refuses removals after the start, but ON DELETE cascade
-- would still let the NEXT such bug wipe a scoreboard without a sound.
-- restrict turns it into a loud FK violation instead.
ALTER TABLE "contest_submissions" DROP CONSTRAINT "contest_submissions_contest_problem_id_contest_problems_id_fk";
--> statement-breakpoint
ALTER TABLE "contest_submissions" ADD CONSTRAINT "contest_submissions_contest_problem_id_contest_problems_id_fk" FOREIGN KEY ("contest_problem_id") REFERENCES "public"."contest_problems"("id") ON DELETE restrict ON UPDATE no action;