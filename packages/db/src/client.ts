import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Logger } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * `logger`: opt-in only, and never turned on for a real server — this
 * exists so a test can observe exactly what SQL a call issues (statement
 * count, whether a particular join is present) without every caller of
 * `createDb` picking up a dependency on `postgres` just to build that
 * logger's underlying connection by hand.
 */
export function createDb(url: string, opts?: { logger?: Logger }): { db: Db; close: () => Promise<void> } {
  const sql = postgres(url, { max: 10 });
  return { db: drizzle(sql, { schema, ...(opts?.logger ? { logger: opts.logger } : {}) }), close: () => sql.end({ timeout: 5 }) };
}
