CREATE TABLE "problem_comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"problem_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"parent_id" bigint,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "problem_comments_body_len_ck" CHECK (char_length("problem_comments"."body") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "problem_comments" ADD CONSTRAINT "problem_comments_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problems"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_comments" ADD CONSTRAINT "problem_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_comments" ADD CONSTRAINT "problem_comments_parent_id_problem_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."problem_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "problem_comments_problem_idx" ON "problem_comments" USING btree ("problem_id","id");--> statement-breakpoint
CREATE INDEX "problem_comments_parent_idx" ON "problem_comments" USING btree ("parent_id");