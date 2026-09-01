import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Logger } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * How many digits Postgres renders a `double precision` with — D175.
 *
 * **Why this is here and not in a query.** Migration 0045 sets the same value
 * with `SET LOCAL` because `to_jsonb(double precision)` at `extra_float_digits
 * = 0` writes too few digits: 48 861 of 50 000 generated values failed to
 * round-trip on the live cluster. B-32 checked the doors around that guard and
 * found the *write* path safe — drizzle's jsonb writer is a client-side
 * `JSON.stringify` the GUC cannot reach — and then found the door still open
 * and recorded it as O1: the sessions that **read** `submission_cases.points`
 * as `float8` over the wire before summing (`EventWriter.writeTerminal`, and
 * the fold's residue read `loadSubtasksFromCases`) inherit whatever the
 * cluster's default is. Safe on *this* cluster, which reports 1. A province's
 * Postgres is not this one, and at 0 a value read back for a fold differs in
 * its last bits from the value the judge wrote — a wrong scoreboard, reported
 * as a right one, on their hardware and not ours.
 *
 * **3, not 1.** Any value above 0 is Postgres's shortest exactly-round-tripping
 * form at >= 12 and 1 would do; 3 is the number migration 0045 already chose,
 * and two different pins for one property is how they come to disagree.
 *
 * **In the startup packet, not a `SET` on connect.** `options.connection` is
 * merged into postgres.js's `StartupMessage` (`src/connection.js`), so:
 *
 *  - **every physical connection carries it**, including one opened to replace
 *    a connection the server dropped — a pool that recycles cannot lose it,
 *    which an `onconnect` hook issuing a `SET` would only cover for as long as
 *    nothing else reconnected;
 *  - **it becomes the session's reset default**, so `RESET ALL` and
 *    `DISCARD ALL` return to 3 rather than to the cluster's value. A `SET`
 *    issued after connecting does not have that property;
 *  - it costs no round trip at all, where a statement per connection costs one
 *    and a statement per query would cost one per query.
 *
 * `packages/db/test/float-digits-pin.spec.ts` asserts all three against a
 * database whose own default has been set to 0, which is also what settles the
 * precedence question — a startup-packet value wins over `ALTER DATABASE …
 * SET` — by measurement rather than by reading the manual.
 *
 * **Not applied to `runMigrations`' pool**, deliberately. A migration that
 * renders a float server-side has to say so itself, as 0045 does: pinning the
 * migrator's connection would make that `SET LOCAL` look like a line somebody
 * could delete, and would silently change how every future migration renders
 * a `float8` with nobody having reviewed it. The mechanism 0045 depends on —
 * drizzle wrapping a migration's statements in one transaction, so `SET LOCAL`
 * survives to the statement below it — is B-32's O3 and is asserted by the
 * same spec.
 */
const EXTRA_FLOAT_DIGITS = '3';

/**
 * `logger`: opt-in only, and never turned on for a real server — this
 * exists so a test can observe exactly what SQL a call issues (statement
 * count, whether a particular join is present) without every caller of
 * `createDb` picking up a dependency on `postgres` just to build that
 * logger's underlying connection by hand.
 */
export function createDb(url: string, opts?: { logger?: Logger }): { db: Db; close: () => Promise<void> } {
  const sql = postgres(url, { max: 10, connection: { extra_float_digits: EXTRA_FLOAT_DIGITS } });
  return { db: drizzle(sql, { schema, ...(opts?.logger ? { logger: opts.logger } : {}) }), close: () => sql.end({ timeout: 5 }) };
}
