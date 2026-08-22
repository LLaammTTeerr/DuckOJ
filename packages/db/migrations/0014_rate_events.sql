CREATE TABLE "rate_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_events_lookup_idx" ON "rate_events" USING btree ("purpose","key","created_at");