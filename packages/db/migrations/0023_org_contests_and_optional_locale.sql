ALTER TABLE "users" ALTER COLUMN "timezone" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "timezone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "locale" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "locale" DROP NOT NULL;--> statement-breakpoint
-- Backfill (hand-written, D57): every stored value equal to the old
-- DEFAULT was written BY that default, because nothing in the product
-- could set either column until this release — PATCH /users/me validated
-- them but no screen sent them. So the old defaults are 'not chosen', and
-- NULL is what that means from here on. A value someone set through the
-- API that happens to equal the old default is lost with them; a value
-- that differs is kept, which is the half worth keeping.
UPDATE "users" SET "timezone" = NULL WHERE "timezone" = 'Asia/Ho_Chi_Minh';--> statement-breakpoint
UPDATE "users" SET "locale" = NULL WHERE "locale" = 'vi';--> statement-breakpoint
CREATE INDEX "contest_orgs_org_idx" ON "contest_orgs" USING btree ("org_id");