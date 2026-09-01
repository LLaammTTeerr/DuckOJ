import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { searchFold } from '@duckoj/db';

/**
 * "Find this person", written once (D185).
 *
 * Two rules, and both exist because of how Vietnamese names are read and
 * typed.
 *
 * **1. Diacritics are folded on BOTH sides.** The haystack is
 * `users.search_fold`, a stored generated column; the needle is folded here by
 * the same `searchFold()` that generated it. So `nguyen` finds `Nguyễn`,
 * `Nguyễn` finds `Nguyễn`, `NGUYEN` finds `Nguyễn`, and `do` finds `Đỗ`. A
 * search that made the reader produce the accents would be a search for people
 * who already know how the account was spelled, which is nobody who needs to
 * search.
 *
 * **2. The match is a WORD prefix, not a string prefix.** Vietnamese puts the
 * family name first and the given name last, and a person is addressed and
 * looked for by the LAST word: *Nguyễn Văn An* is "An" to their teacher. A
 * plain `LIKE 'an%'` over the whole name cannot find him. So the pattern is
 * matched at the start of the string OR immediately after a space — and
 * `search_fold` has already turned `-`, `_` and `.` into spaces, which is what
 * makes `nguyen` find the account `hs-nguyen-van-an` too.
 *
 * It is deliberately NOT a substring match. `%an%` would return every *Hoàng*,
 * *Lan*, *Trang* and *Thanh* in the province — a hit on the middle of a
 * syllable is noise in a language whose syllables are its words — and it
 * cannot run at province size without a `pg_trgm` index that migration 0047
 * measured and refused.
 *
 * **The needle is escaped AFTER it is folded**, in SQL, for the same
 * single-definition reason: a percent sign and a backslash are the only LIKE
 * metacharacters that survive the fold (`_` and `.` have already become
 * spaces), and a caller who types `%` means the character, not "everything".
 *
 * **`(select …)` around the needle is load-bearing, not noise.** `q` arrives
 * as a bind parameter, and postgres.js prepares its statements: once Postgres
 * settles on a GENERIC plan it can no longer fold `$1` at plan time, and the
 * whole fold-and-escape expression is then re-evaluated once per row. Measured
 * on the 25 000-account province copy with `plan_cache_mode =
 * force_generic_plan`, on the worst case (a query matching nothing):
 *
 *   inline, generic plan            47.9 ms
 *   wrapped in a scalar subquery     7.8 ms
 *
 * A scalar subquery over no table becomes an InitPlan, which Postgres runs
 * exactly once. Removing the parentheses is a six-fold regression that no
 * test would notice and no plan printed from a literal would show.
 */
export function nameSearchWhere(haystack: SQLWrapper, raw: string): SQL {
  const folded = searchFold(sql`${raw}`);
  const needle = sql`replace(replace(${folded}, '\\', '\\\\'), '%', '\\%')`;
  const once = sql`(select ${needle})`;
  return sql`(${haystack} like ${once} || '%' or ${haystack} like '% ' || ${once} || '%')`;
}
