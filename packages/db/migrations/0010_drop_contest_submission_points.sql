-- `contest_submissions.points` was denormalised in 0008 and never read: the
-- scoreboard rebuilds every score from `submission_cases` on each read, and
-- `ioi16` ignores a submission's total outright. Phase 4d is the first code
-- that inserts these rows for real, and the column was NOT NULL with no
-- default -- leaving it would mean writing a literal 0 that stays wrong, or a
-- second scoring write-path in `judged` duplicating the scoreboard's own
-- arithmetic. See the 4d design, section 6.
ALTER TABLE "contest_submissions" DROP COLUMN "points";
