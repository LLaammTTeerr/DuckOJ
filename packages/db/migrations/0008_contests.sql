CREATE TYPE "public"."contest_visibility" AS ENUM('private', 'org', 'public');--> statement-breakpoint
CREATE TABLE "contest_orgs" (
	"contest_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	CONSTRAINT "contest_orgs_contest_id_org_id_pk" PRIMARY KEY("contest_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "contest_participations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contest_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"virtual" integer DEFAULT 0 NOT NULL,
	"is_disqualified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contest_problems" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contest_id" bigint NOT NULL,
	"problem_id" bigint NOT NULL,
	"label" text NOT NULL,
	"points" double precision NOT NULL,
	"partial" boolean DEFAULT true NOT NULL,
	"order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contest_submissions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"participation_id" bigint NOT NULL,
	"contest_problem_id" bigint NOT NULL,
	"submission_id" bigint NOT NULL,
	"points" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"format" text NOT NULL,
	"format_config" jsonb,
	"points_precision" integer DEFAULT 3 NOT NULL,
	"frozen_last_minutes" integer DEFAULT 0 NOT NULL,
	"time_limit_seconds" integer,
	"visibility" "contest_visibility" DEFAULT 'private' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contest_orgs" ADD CONSTRAINT "contest_orgs_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_orgs" ADD CONSTRAINT "contest_orgs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_participations" ADD CONSTRAINT "contest_participations_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_participations" ADD CONSTRAINT "contest_participations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_problems" ADD CONSTRAINT "contest_problems_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_submissions" ADD CONSTRAINT "contest_submissions_participation_id_contest_participations_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."contest_participations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_submissions" ADD CONSTRAINT "contest_submissions_contest_problem_id_contest_problems_id_fk" FOREIGN KEY ("contest_problem_id") REFERENCES "public"."contest_problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_submissions" ADD CONSTRAINT "contest_submissions_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contests" ADD CONSTRAINT "contests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contest_participations_identity_idx" ON "contest_participations" USING btree ("contest_id","user_id","virtual");--> statement-breakpoint
CREATE UNIQUE INDEX "contest_problems_problem_idx" ON "contest_problems" USING btree ("contest_id","problem_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contest_submissions_submission_idx" ON "contest_submissions" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contests_key_lower_idx" ON "contests" USING btree (lower("key"));