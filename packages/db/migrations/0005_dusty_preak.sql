CREATE TYPE "public"."problem_role" AS ENUM('author', 'curator', 'tester');--> statement-breakpoint
ALTER TYPE "public"."case_verdict" ADD VALUE 'CE' BEFORE 'IE';--> statement-breakpoint
CREATE TABLE "problem_members" (
	"problem_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" "problem_role" NOT NULL,
	CONSTRAINT "problem_members_problem_id_user_id_role_pk" PRIMARY KEY("problem_id","user_id","role")
);
--> statement-breakpoint
CREATE TABLE "problem_orgs" (
	"problem_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	CONSTRAINT "problem_orgs_problem_id_org_id_pk" PRIMARY KEY("problem_id","org_id")
);
--> statement-breakpoint
-- Five of the columns this migration adds to `problem_revisions` below
-- (time_ms, memory_kb, test_count, total_points, checker_kind) have no
-- honest backfill: their real values live inside package archives
-- (`manifest.json`), which this migration cannot read — unlike
-- `created_by` further down, there is no defensible "first admin user"
-- equivalent to fall back to. Rather than invent sentinel numbers, refuse
-- outright to run against a `problem_revisions` table that already holds
-- rows. This guard MUST run before any `ALTER TABLE "problem_revisions"`
-- below it — including the `created_by` backfill — so it is the first
-- thing checked against this table, not something reached only after a
-- less informative NOT NULL violation already fired (e.g. `SET NOT NULL`
-- on `created_by` failing outright on a database with `problem_revisions`
-- rows but no admin user to backfill from).
--
-- Every test container and CI run migrates an empty database, so this
-- guard never fires there; it only fires against a stale dev volume seeded
-- before this migration existed — recreate it per docs/runbook.md.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "problem_revisions") THEN
    RAISE EXCEPTION 'Migration 0005 adds NOT NULL columns time_ms/memory_kb/test_count/total_points/checker_kind to problem_revisions with no backfill, because their values live inside package archives this migration cannot read. This database''s problem_revisions table is not empty. Recreate the dev database (see docs/runbook.md) rather than running this migration against existing rows.';
  END IF;
END $$;--> statement-breakpoint
-- `problem_revisions.created_by` and `problems.created_by` may already hold
-- rows written by `scripts/seed-problem.ts` before this migration existed.
-- Added nullable, backfilled to the first admin user, then made NOT NULL,
-- per task-1-brief.md Step 4 — a bare `ADD COLUMN ... NOT NULL` with no
-- default fails outright against any such populated table. Reached only
-- once the guard above has already confirmed `problem_revisions` is empty,
-- so this backfill always operates against zero rows in every case this
-- migration is actually run against.
ALTER TABLE "problem_revisions" ADD COLUMN "created_by" bigint;--> statement-breakpoint
UPDATE "problem_revisions" SET "created_by" = (SELECT "id" FROM "users" WHERE "global_role" = 'admin' ORDER BY "id" ASC LIMIT 1) WHERE "created_by" IS NULL;--> statement-breakpoint
ALTER TABLE "problem_revisions" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_revisions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "problem_revisions" ADD COLUMN "time_ms" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_revisions" ADD COLUMN "memory_kb" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_revisions" ADD COLUMN "test_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_revisions" ADD COLUMN "total_points" double precision NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_revisions" ADD COLUMN "checker_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "created_by" bigint;--> statement-breakpoint
UPDATE "problems" SET "created_by" = (SELECT "id" FROM "users" WHERE "global_role" = 'admin' ORDER BY "id" ASC LIMIT 1) WHERE "created_by" IS NULL;--> statement-breakpoint
ALTER TABLE "problems" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "problem_members" ADD CONSTRAINT "problem_members_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_members" ADD CONSTRAINT "problem_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_orgs" ADD CONSTRAINT "problem_orgs_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_orgs" ADD CONSTRAINT "problem_orgs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_revisions" ADD CONSTRAINT "problem_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "problem_revisions_version_idx" ON "problem_revisions" USING btree ("problem_id","version");
