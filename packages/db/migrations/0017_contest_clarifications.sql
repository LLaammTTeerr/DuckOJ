CREATE TYPE "public"."clarification_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "contest_clarifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contest_id" bigint NOT NULL,
	"problem_id" bigint,
	"asked_by" bigint NOT NULL,
	"question" text,
	"answer" text,
	"answered_by" bigint,
	"answered_at" timestamp with time zone,
	"visibility" "clarification_visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contest_clarifications_text_ck" CHECK ("contest_clarifications"."question" IS NOT NULL OR "contest_clarifications"."answer" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "contest_clarifications" ADD CONSTRAINT "contest_clarifications_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_clarifications" ADD CONSTRAINT "contest_clarifications_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_clarifications" ADD CONSTRAINT "contest_clarifications_asked_by_users_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_clarifications" ADD CONSTRAINT "contest_clarifications_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contest_clarifications_contest_idx" ON "contest_clarifications" USING btree ("contest_id","id");