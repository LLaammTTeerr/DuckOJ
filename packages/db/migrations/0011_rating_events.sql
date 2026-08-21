CREATE TABLE "rating_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"contest_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"rating_before" integer NOT NULL,
	"rd_before" double precision NOT NULL,
	"volatility_before" double precision NOT NULL,
	"rating_after" integer NOT NULL,
	"rd_after" double precision NOT NULL,
	"volatility_after" double precision NOT NULL,
	"rank" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contests" ADD COLUMN "is_rated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rating_event" ADD CONSTRAINT "rating_event_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_event" ADD CONSTRAINT "rating_event_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rating_event_identity_idx" ON "rating_event" USING btree ("contest_id","user_id");