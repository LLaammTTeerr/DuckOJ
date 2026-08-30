CREATE INDEX "grading_jobs_active_idx" ON "grading_jobs" USING btree ("state") WHERE "grading_jobs"."state" <> 'done';--> statement-breakpoint
CREATE INDEX "grading_jobs_submission_idx" ON "grading_jobs" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "submissions_failed_idx" ON "submissions" USING btree ("id" DESC NULLS LAST) WHERE "submissions"."verdict" = 'IE' or "submissions"."state" = 'errored';--> statement-breakpoint
CREATE INDEX "submissions_judged_at_idx" ON "submissions" USING btree ("judged_at");