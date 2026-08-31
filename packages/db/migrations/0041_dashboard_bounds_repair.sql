CREATE INDEX IF NOT EXISTS "grading_jobs_active_idx" ON "grading_jobs" USING btree ("state") WHERE "grading_jobs"."state" <> 'done';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grading_jobs_submission_idx" ON "grading_jobs" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submissions_failed_idx" ON "submissions" USING btree ("id" DESC NULLS LAST) WHERE "submissions"."verdict" = 'IE' or "submissions"."state" = 'errored';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submissions_judged_at_idx" ON "submissions" USING btree ("judged_at");--> statement-breakpoint
INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
SELECT '2a587463ac0f1bf988dd67599fd343679a05f5ea0ff43d7d7e80b1450a305ac5', 1788078255700
 WHERE NOT EXISTS (
   SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1788078255700
 );
