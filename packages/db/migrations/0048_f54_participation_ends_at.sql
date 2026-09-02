DROP INDEX "contest_submissions_participation_idx";--> statement-breakpoint
ALTER TABLE "contest_participations" ADD COLUMN "ends_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL;--> statement-breakpoint
--
-- D194. Everything from here to the last `CREATE INDEX` is written by hand
-- beside what `drizzle-kit generate` produced, the way 0045's backfill is:
-- drizzle-kit knows about columns and indexes and nothing about triggers, so
-- the column it adds would be `'epoch'` on every existing row and would stay
-- `'epoch'` on every row written afterwards. `drizzle-kit check` still sees no
-- drift, because the parts it owns are exactly its own output.
--
-- WHAT THIS COLUMN IS. `ends_at` is `participationEndsAtSql()`
-- (apps/api/src/authz/submission.freeze.ts) materialised per row: the instant
-- THIS participation's own window closes, which is the same instant D22
-- unfreezes its board, D27 releases its source and D49 lets its submissions
-- into the statistics. A spectator takes the contest's end; a live entrant is
-- capped by it; a virtual entrant measures the contest's DURATION from their
-- own start, which is how a virtual attempt legitimately outlives the contest
-- and why no constant bound on `contests.end_time` is implied (F-44 tried).
--
-- The `CASE` below is therefore a transcription, and transcriptions of this
-- rule are what D22, D23 and D25 each record paying for. It is pinned two
-- ways rather than trusted: `apps/api/test/participation-ends-at.spec.ts`
-- asserts the stored column equals `participationEndsAtSql()` over every
-- participation shape and after a contest edit that moves each of the three
-- inputs, and `scripts/integrity-check.ts` asks the same question of the live
-- database.
--
-- The backfill. A no-op on the empty database CI migrates.
UPDATE "contest_participations" AS p
   SET "ends_at" = (case
      when p."virtual" = -1 then c."end_time"
      when p."virtual" = 0 then
        case
          when c."time_limit_seconds" is null then c."end_time"
          else least(
            p."start_time" + c."time_limit_seconds" * interval '1 second',
            c."end_time"
          )
        end
      else
        case
          when c."time_limit_seconds" is null
            then p."start_time" + (c."end_time" - c."start_time")
          else p."start_time" + c."time_limit_seconds" * interval '1 second'
        end
    end)
  FROM "contests" AS c
 WHERE c."id" = p."contest_id";--> statement-breakpoint
--
-- The one writer of the column. A TRIGGER and not an application module, which
-- deviates from D100 and D104 ("three writers, one module") deliberately:
-- those tables have a closed writer set, and this column's is open — every
-- fixture in the suite raw-inserts a participation, and a rule the fixtures
-- can skip is a rule the fixtures will eventually disagree with. `BEFORE
-- INSERT OR UPDATE`, so the `'epoch'` default the type needs can never reach
-- the table.
CREATE FUNCTION "contest_participation_ends_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE c "contests"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "contests" WHERE "id" = NEW."contest_id";
  NEW."ends_at" := (case
      when NEW."virtual" = -1 then c."end_time"
      when NEW."virtual" = 0 then
        case
          when c."time_limit_seconds" is null then c."end_time"
          else least(
            NEW."start_time" + c."time_limit_seconds" * interval '1 second',
            c."end_time"
          )
        end
      else
        case
          when c."time_limit_seconds" is null
            then NEW."start_time" + (c."end_time" - c."start_time")
          else NEW."start_time" + c."time_limit_seconds" * interval '1 second'
        end
    end);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "contest_participations_ends_at"
  BEFORE INSERT OR UPDATE ON "contest_participations"
  FOR EACH ROW EXECUTE FUNCTION "contest_participation_ends_at"();--> statement-breakpoint
--
-- The other half, and the half that is easy to forget: D38 leaves a contest's
-- `end_time` editable after it has started, and `time_limit_seconds` and a
-- not-yet-started `start_time` with it. Moving any of the three moves every
-- one of that contest's windows.
--
-- It writes `'epoch'` on purpose. The row trigger above recomputes it from the
-- contest row this statement has already updated, so the value never lands;
-- writing `ends_at = ends_at` would do the same while the trigger exists and
-- would silently leave every window stale if it were ever dropped. This form
-- fails visible, and the integrity audit is what sees it.
CREATE FUNCTION "contests_refresh_participation_ends_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "contest_participations"
     SET "ends_at" = 'epoch'::timestamptz
   WHERE "contest_id" = NEW."id";
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "contests_participation_ends_at"
  AFTER UPDATE OF "start_time", "end_time", "time_limit_seconds" ON "contests"
  FOR EACH ROW
  WHEN (OLD."start_time" IS DISTINCT FROM NEW."start_time"
     OR OLD."end_time" IS DISTINCT FROM NEW."end_time"
     OR OLD."time_limit_seconds" IS DISTINCT FROM NEW."time_limit_seconds")
  EXECUTE FUNCTION "contests_refresh_participation_ends_at"();--> statement-breakpoint
CREATE INDEX "contest_participations_ends_at_idx" ON "contest_participations" USING btree ("ends_at");--> statement-breakpoint
CREATE INDEX "contest_submissions_participation_idx" ON "contest_submissions" USING btree ("participation_id","submission_id");
