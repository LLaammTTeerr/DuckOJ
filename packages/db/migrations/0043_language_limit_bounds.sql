-- F-41 / D159. B-30 found there is no CHECK on `time_multiplier_pct`: an
-- operator typo of `0` yields `timeMs: 0`, so every submission in that
-- language TLEs instantly — which is D154's "a zero limit would present the
-- refusal as a TLE, teaching the pupil that their correct program was too
-- slow", arrived at by accident instead of by design. A negative value gives
-- a negative limit. Until this migration the only way to write one of these
-- rows was raw SQL against production, so nothing had ever checked them.
--
-- The rule both floors come from: AN ADJUSTMENT MAY NEVER TAKE AWAY FROM
-- WHAT THE SETTER AUTHORED. In the multiplier's unit that is 100 %; in the
-- addend's it is 0 KB. The ceilings are the denial-of-service bound on a
-- province's single judge and the judge box's own RAM. All four numbers, and
-- the arguments for them, live in `@duckoj/language-limits`; this file is
-- generated from the schema, and `language-limit-bounds.spec.ts` reads them
-- back out of `pg_constraint` so the three layers cannot drift.
--
-- NULL is exempt on `problem_language_limits`, and that exemption is the
-- point rather than an oversight: NULL means "inherit", column by column, so
-- the ordinary row — pin the time, keep the interpreter's memory floor —
-- must stay writable (D154).
--
-- IDEMPOTENT, because Postgres has no `ADD CONSTRAINT IF NOT EXISTS` and a
-- migration that cannot be re-run is a migration nobody dares re-run (D133
-- exists because 0025 was skipped forever). `duplicate_object` is the only
-- error swallowed; a row that actually violates the bound still raises
-- `check_violation` and fails the deploy, deliberately — silently clamping a
-- limit somebody typed would change a verdict without telling anyone.
--
-- Checked against the live database before writing, read-only:
--   languages:               5 rows, time_multiplier_pct 100..300,
--                            memory_extra_kb 0..32768
--   problem_language_limits: 0 rows
-- Every one satisfies every bound, and a fresh install runs 0042 (which
-- seeds exactly those values) immediately before this.
DO $$ BEGIN
  ALTER TABLE "languages" ADD CONSTRAINT "languages_time_multiplier_pct_ck" CHECK ("languages"."time_multiplier_pct" BETWEEN 100 AND 1000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "languages" ADD CONSTRAINT "languages_memory_extra_kb_ck" CHECK ("languages"."memory_extra_kb" BETWEEN 0 AND 1048576);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "problem_language_limits" ADD CONSTRAINT "problem_language_limits_time_multiplier_pct_ck" CHECK ("problem_language_limits"."time_multiplier_pct" IS NULL OR ("problem_language_limits"."time_multiplier_pct" BETWEEN 100 AND 1000));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "problem_language_limits" ADD CONSTRAINT "problem_language_limits_memory_extra_kb_ck" CHECK ("problem_language_limits"."memory_extra_kb" IS NULL OR ("problem_language_limits"."memory_extra_kb" BETWEEN 0 AND 1048576));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
