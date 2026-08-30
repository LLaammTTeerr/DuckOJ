CREATE TABLE "problem_set_items" (
	"set_id" bigint NOT NULL,
	"problem_id" bigint NOT NULL,
	"order" integer NOT NULL,
	"points" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "problem_set_items_set_id_problem_id_pk" PRIMARY KEY("set_id","problem_id")
);
--> statement-breakpoint
CREATE TABLE "problem_sets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"deadline" timestamp with time zone,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "problem_set_items" ADD CONSTRAINT "problem_set_items_set_id_problem_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."problem_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_set_items" ADD CONSTRAINT "problem_set_items_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_sets" ADD CONSTRAINT "problem_sets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_sets" ADD CONSTRAINT "problem_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "problem_set_items_order_idx" ON "problem_set_items" USING btree ("set_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "problem_sets_org_slug_lower_idx" ON "problem_sets" USING btree ("org_id",lower("slug"));