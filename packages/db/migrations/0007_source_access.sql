CREATE TYPE "public"."problem_source_access" AS ENUM('private', 'solved');--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "source_access" "problem_source_access" DEFAULT 'private' NOT NULL;