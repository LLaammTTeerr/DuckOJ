CREATE TABLE "contest_seats" (
	"contest_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"participation_id" bigint NOT NULL,
	CONSTRAINT "contest_seats_contest_id_user_id_pk" PRIMARY KEY("contest_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "contest_seats" ADD CONSTRAINT "contest_seats_contest_id_contests_id_fk" FOREIGN KEY ("contest_id") REFERENCES "public"."contests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_seats" ADD CONSTRAINT "contest_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contest_seats" ADD CONSTRAINT "contest_seats_participation_id_contest_participations_id_fk" FOREIGN KEY ("participation_id") REFERENCES "public"."contest_participations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contest_seats_participation_idx" ON "contest_seats" USING btree ("participation_id");;--> statement-breakpoint
-- D104 backfill: every contest already run, and every one running right now,
-- has to be seated — a table that only describes participations minted after
-- this deploy would let a pupil already on one board be put on a second.
--
-- Two populations, one statement each, because a team row seats its whole
-- roster and an individual row seats one person.
--
-- `ON CONFLICT DO NOTHING` on both, and it is a ruling rather than caution.
-- The defect this table closes has been reachable since D99 shipped, so a
-- live judge MAY already hold the double seat, and `runMigrations` runs at
-- boot: a UNIQUE violation here would take the API down at start rather than
-- report a data problem. So the backfill seats the first row it finds and
-- leaves the second unseated; the app-level checks (`assertMembersFree`,
-- `assertAddedMembersFree`) go on refusing that pupil everywhere else in the
-- contest, and an operator repairing the duplicate afterwards gets the seat
-- for free on the next write. Stated here so nobody reads the table as a
-- proof about history.
INSERT INTO "contest_seats" ("contest_id", "user_id", "participation_id")
SELECT part."contest_id", part."user_id", part."id"
  FROM "contest_participations" part
 WHERE part."virtual" = 0
   AND part."team_id" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "contest_seats" ("contest_id", "user_id", "participation_id")
SELECT part."contest_id", tm."user_id", part."id"
  FROM "contest_participations" part
  JOIN "team_members" tm ON tm."team_id" = part."team_id"
 WHERE part."virtual" = 0
   AND part."team_id" IS NOT NULL
ON CONFLICT DO NOTHING;
