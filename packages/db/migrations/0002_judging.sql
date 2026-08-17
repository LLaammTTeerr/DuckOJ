CREATE TYPE "public"."grading_job_kind" AS ENUM('submission');--> statement-breakpoint
CREATE TYPE "public"."grading_job_state" AS ENUM('queued', 'leased', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."case_verdict" AS ENUM('AC', 'WA', 'TLE', 'MLE', 'OLE', 'RTE', 'IR', 'IE');--> statement-breakpoint
CREATE TYPE "public"."problem_visibility" AS ENUM('private', 'org', 'public');--> statement-breakpoint
CREATE TYPE "public"."revision_state" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."submission_state" AS ENUM('queued', 'compiling', 'grading', 'done', 'errored');--> statement-breakpoint
CREATE TABLE "grading_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" "grading_job_kind" DEFAULT 'submission' NOT NULL,
	"submission_id" bigint,
	"revision_id" bigint NOT NULL,
	"package_hash" text NOT NULL,
	"state" "grading_job_state" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"worker_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_nodes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"driver" text NOT NULL,
	"capabilities" jsonb,
	"last_seen" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "language_driver_keys" (
	"language_id" bigint NOT NULL,
	"driver" text NOT NULL,
	"executor_key" text NOT NULL,
	CONSTRAINT "language_driver_keys_language_id_driver_pk" PRIMARY KEY("language_id","driver")
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"extension" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"problem_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"package_hash" text NOT NULL,
	"state" "revision_state" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"statement" text NOT NULL,
	"visibility" "problem_visibility" DEFAULT 'public' NOT NULL,
	"current_revision_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_cases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"submission_id" bigint NOT NULL,
	"attempt" integer NOT NULL,
	"group_index" integer NOT NULL,
	"case_index" integer NOT NULL,
	"verdict" "case_verdict",
	"skipped" boolean DEFAULT false NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"time_ms" integer NOT NULL,
	"memory_kb" integer NOT NULL,
	"points" double precision NOT NULL,
	"max_points" double precision NOT NULL,
	"feedback" text
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"problem_id" bigint NOT NULL,
	"revision_id" bigint NOT NULL,
	"language_id" bigint NOT NULL,
	"source" text NOT NULL,
	"state" "submission_state" DEFAULT 'queued' NOT NULL,
	"verdict" "case_verdict",
	"points" double precision,
	"max_points" double precision,
	"time_ms" integer,
	"memory_kb" integer,
	"compile_output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"judged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "grading_jobs" ADD CONSTRAINT "grading_jobs_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grading_jobs" ADD CONSTRAINT "grading_jobs_revision_id_problem_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."problem_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "language_driver_keys" ADD CONSTRAINT "language_driver_keys_language_id_languages_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."languages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_revisions" ADD CONSTRAINT "problem_revisions_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_cases" ADD CONSTRAINT "submission_cases_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_revision_id_problem_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."problem_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_language_id_languages_id_fk" FOREIGN KEY ("language_id") REFERENCES "public"."languages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "judge_nodes_name_idx" ON "judge_nodes" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "judge_nodes_token_idx" ON "judge_nodes" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "languages_key_idx" ON "languages" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "problems_code_lower_idx" ON "problems" USING btree (lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "submission_cases_identity_idx" ON "submission_cases" USING btree ("submission_id","attempt","group_index","case_index");