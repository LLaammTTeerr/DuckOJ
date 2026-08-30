CREATE INDEX "contest_submissions_contest_problem_idx" ON "contest_submissions" USING btree ("contest_problem_id","id");--> statement-breakpoint
CREATE INDEX "contest_submissions_participation_idx" ON "contest_submissions" USING btree ("participation_id");
