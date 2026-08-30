ALTER TABLE "problems" ADD COLUMN "editorial" text;--> statement-breakpoint
ALTER TABLE "problems" ADD COLUMN "editorial_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_editorial_published_ck" CHECK ("problems"."editorial_published_at" IS NULL OR "problems"."editorial" IS NOT NULL);