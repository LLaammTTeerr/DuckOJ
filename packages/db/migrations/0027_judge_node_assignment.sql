ALTER TABLE "grading_jobs" ADD COLUMN "judge_node_id" bigint;--> statement-breakpoint
ALTER TABLE "grading_jobs" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "grading_jobs" ADD CONSTRAINT "grading_jobs_judge_node_id_judge_nodes_id_fk" FOREIGN KEY ("judge_node_id") REFERENCES "public"."judge_nodes"("id") ON DELETE set null ON UPDATE no action;