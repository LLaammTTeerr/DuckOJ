-- F-46 / D169. Pascal and Java, because a province teaches them.
--
-- F-39 (migration 0042) seeded five languages and stopped where the IMAGE
-- stopped: C++ and Python needed no new toolchain, Pascal and Java do.
-- judge/Dockerfile now installs `fp-compiler` and `openjdk-17-jdk-headless`,
-- judge/judge.yml's `runtime:` block is regenerated from that image's own
-- `dmoj-autoconf -V`, and docker-compose.yml's `--only-executors` is widened
-- on BOTH judge services. All four deploy together or not at all: the rows
-- below without the Compose change are two languages nobody can grade (D160),
-- and the Compose change without the image is a judge announcing executors
-- that fail their own self-test.
--
-- Idempotent by key, in 0042's shape: `DO NOTHING`, never `DO UPDATE`, so a
-- re-run neither duplicates a row nor overwrites an operator's later edit to
-- a multiplier.
--
-- The executor names are the ones the image ANNOUNCES, read out of the
-- self-test inside `localhost/duckoj-judge:f46-probe` and not guessed:
--
--   Self-testing JAVA:   Success [0.054s, 39900 KB]  javac 17.0.20.1
--   Self-testing PAS:    Success [0.002s,   196 KB]  fpc 3.2.2
--   AVAILABLE: AWK C C11 CPP03 CPP11 CPP14 CPP17 CPP20 GAS64 JAVA NODEJS PAS
--              PY3 SED TEXT
--
-- Free Pascal is `PAS`, not `PASCAL`. The JDK executor is `JAVA`; `JAVA8`
-- exists in the image and is NOT usable (its autoconf answers "Could not find
-- JVM" — its `jvm_regex` wants a java-8 tree), so nothing maps to it.
--
-- The numbers are measured on that image, under the judge's own sandbox and
-- its own clock, against a C++17 baseline compiled by the same judge. See
-- D169 for the full table and the argument; in short:
--
--   * Pascal 200 %, +0 KB. Native code: 1.05x C++ on a sieve, 1.07x on
--     integer input, 1.07x on a 2e6-element sort, 1.37x on a tight modular
--     arithmetic loop. Its memory FLOOR is 196-204 KB, an order of magnitude
--     BELOW C++'s 1.3 MB, so an addend would invent a cost that does not
--     exist.
--   * Java 300 %, +65536 KB. Java inverts D154's rule: its time cost is
--     dominated by a FIXED 55 ms JVM start (charged to the submission), and
--     its memory cost is PROPORTIONAL — the judge hands `-Xmx<limit>`, and
--     SerialGC's generational split needs 1.57x the live data, measured
--     constant from 3.9 MB to 62.5 MB of array. The schema has a time
--     multiplier and a memory addend, i.e. the wrong instrument in both
--     columns; 300 % and +64 MB are those instruments sized against the
--     limits this deployment actually authors (1000 ms/64 MB on 51 of 70
--     revisions).
INSERT INTO "languages" ("key", "name", "extension", "is_active", "time_multiplier_pct", "memory_extra_kb")
VALUES
  ('pascal', 'Pascal',  'pas',  true, 200, 0),
  ('java',   'Java 17', 'java', true, 300, 65536)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "language_driver_keys" ("language_id", "driver", "executor_key")
SELECT "languages"."id", 'dmoj', v."executor_key"
  FROM (VALUES
    ('pascal', 'PAS'),
    ('java',   'JAVA')
  ) AS v("key", "executor_key")
  JOIN "languages" ON "languages"."key" = v."key"
ON CONFLICT ("language_id", "driver") DO NOTHING;
