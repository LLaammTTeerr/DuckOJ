import { eq } from 'drizzle-orm';
import { languageDriverKeys, languages } from './schema/judging.js';
import type { Db } from './client.js';

/**
 * The two directions of the `languages.key` ↔ driver executor mapping, read
 * out of `language_driver_keys` — the table whose whole reason to exist is
 * that `CPP17`, judge-server's name, must not become our name.
 *
 * They are produced together, from one query, because they must stay
 * inverses: dispatch asks "does this judge have the executor for `python3`"
 * and capability recording asks "what language is `PY3`", and a fleet gets
 * the wrong answer to one of them the moment the pair drifts (D68). Until
 * F-39 the pair was a hard-coded closure in `apps/judged/src/main.ts` whose
 * own comment said a language whose executor is not its key uppercased "must
 * extend BOTH lines here". `python3` → `PY3` is that language, and rather
 * than extend two lines by hand this reads the mapping the migration already
 * had to write anyway.
 */
export interface DriverLanguageMap {
  /** Our language key → this driver's executor key. */
  languageToExecutor(key: string): string;
  /** This driver's executor key → our language key. */
  executorToLanguage(executorKey: string): string;
}

/**
 * Builds the map for one driver from the database.
 *
 * Loaded once, at `judged` startup, and never refreshed: the migration that
 * adds a language row and the `judged` restart that picks it up are the same
 * deploy, so a boot-time snapshot cannot go stale in a way a running process
 * would notice. A judge's executor set is likewise fixed at ITS startup.
 *
 * The fallbacks are the pre-F-39 behaviour, kept deliberately: an executor a
 * judge announces that no row names still resolves to something (lowercased),
 * so an unmapped executor degrades to "a language we do not have a row for"
 * rather than to a crash in the handshake path.
 */
export async function loadDriverLanguageMap(db: Db, driver: string): Promise<DriverLanguageMap> {
  const rows = await db
    .select({ key: languages.key, executorKey: languageDriverKeys.executorKey })
    .from(languageDriverKeys)
    .innerJoin(languages, eq(languages.id, languageDriverKeys.languageId))
    .where(eq(languageDriverKeys.driver, driver));

  const toExecutor = new Map(rows.map((row) => [row.key, row.executorKey]));
  const toLanguage = new Map(rows.map((row) => [row.executorKey, row.key]));

  return {
    languageToExecutor: (key) => toExecutor.get(key) ?? key.toUpperCase(),
    executorToLanguage: (executorKey) => toLanguage.get(executorKey) ?? executorKey.toLowerCase(),
  };
}
