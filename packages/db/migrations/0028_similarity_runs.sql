CREATE TABLE "similarity_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contest_id" bigint NOT NULL,
	"status" text NOT NULL,
	"threshold" double precision NOT NULL,
	"requested_by" bigint,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"pairs" jsonb,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "similarity_runs" ADD CONSTRAINT "similarity_runs_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "similarity_runs" ADD CONSTRAINT "similarity_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "similarity_runs_contest_idx" ON "similarity_runs" USING btree ("contest_id","started_at");