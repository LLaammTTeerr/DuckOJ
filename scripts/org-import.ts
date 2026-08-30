/**
 * Create student accounts for a school from a roster file, with no browser:
 *
 *   corepack pnpm org:import <slug> <file.csv> [--dry-run] [--out accounts.csv]
 *
 * **Why this reaches the database directly, like `bootstrap-admin.ts`.**
 * The brief offered two shapes — call the API with an admin token, or go
 * through `DATABASE_URL` — and the first is not available: the route
 * `POST /orgs/{slug}/members/import` is `@SessionOnly`, so a personal access
 * token is refused by `SessionOnlyGuard` with `session_required` before the
 * handler runs. That marker is deliberate (an endpoint that mints credentials
 * for two thousand people and reads their passwords back must not be reachable
 * by a machine credential), so the CLI takes the other door.
 *
 * What it does NOT duplicate is the rule. Validation, the username shape, the
 * case-folded uniqueness, the password alphabet, the transaction and the
 * owners' notification all come from `apps/api/src/authz/org-import.core.ts`
 * — the same module the API runs, imported rather than reimplemented, exactly
 * as this script's neighbour imports `password.hash.ts`. Two copies of "what
 * makes a roster row acceptable" is how a CLI comes to mint accounts the API
 * would have refused.
 *
 * What it deliberately does not enforce is the *authorization*: there is no
 * actor here to be an owner of anything. Reaching `DATABASE_URL` is the
 * authority, the same way it is for `bootstrap:admin`, and the rate limit is
 * skipped for the same reason — a meter exists to stop a web caller hammering
 * a shared thread pool, not to stop the operator who could as easily run SQL.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createDb, type Db } from '@duckoj/db';
import {
  ImportValidationError,
  IMPORT_MAX_ROWS,
  credentialsCsv,
  findOrgBySlug,
  parseImportCsv,
  prepareAccounts,
  runImport,
  validateImportRows,
  type ImportedCredential,
} from '../apps/api/src/authz/org-import.core.js';

export interface OrgImportOptions {
  slug: string;
  file: string;
  dryRun: boolean;
  out?: string | undefined;
}

export interface ParsedArgs extends OrgImportOptions {}

/** `--flag value`, no `--flag=value` form — matching `bootstrap-admin.ts`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let dryRun = false;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--out needs a value');
      out = value;
      i++;
      continue;
    }
    // Unknown flags are refused rather than ignored: a mistyped `--dry-run`
    // that is silently dropped creates two thousand accounts.
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    positional.push(arg);
  }

  if (positional.length !== 2) {
    throw new Error('usage: org:import <slug> <file.csv> [--dry-run] [--out accounts.csv]');
  }
  return { slug: positional[0]!, file: positional[1]!, dryRun, out };
}

export interface OrgImportResult {
  slug: string;
  name: string;
  /** Empty on a dry run — nothing was created, so there is nothing to print. */
  created: ImportedCredential[];
  /** How many rows validated cleanly, whether or not they were created. */
  accepted: number;
  dryRun: boolean;
}

/**
 * The whole run, separated from the CLI shell so it is testable and so a
 * future caller (a provisioning script) can use it without spawning a
 * process. Throws `ImportValidationError` unchanged — the caller decides how
 * to render a bad row.
 */
export async function importRoster(db: Db, opts: OrgImportOptions): Promise<OrgImportResult> {
  const org = await findOrgBySlug(db, opts.slug);
  if (!org) throw new Error(`no such organization: ${opts.slug}`);

  const text = await readFile(opts.file, 'utf8');
  const rows = parseImportCsv(text);
  const validated = await validateImportRows(db, rows, org.slug);
  if (opts.dryRun) {
    return { slug: org.slug, name: org.name, created: [], accepted: validated.length, dryRun: true };
  }

  const prepared = await prepareAccounts(validated);
  // `null` for the actor: nobody signed in did this, and inventing a user id
  // for the notification would name somebody who was not there.
  await runImport(db, org, prepared, null);
  return {
    slug: org.slug,
    name: org.name,
    created: prepared.map((account) => ({
      username: account.username,
      displayName: account.displayName,
      password: account.password,
    })),
    accepted: prepared.length,
    dryRun: false,
  };
}

/** `ImportValidationError` as lines an operator can act on, one per problem. */
export function describeValidationError(error: ImportValidationError): string[] {
  return error.errors.map((row) =>
    row.row === 0 ? `file: ${row.message}` : `row ${String(row.row)} (${row.field}): ${row.message}`,
  );
}

/** See `bootstrap-admin.ts`: `import.meta.main` is Node 24+, this repo is 22. */
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  let opts: ParsedArgs;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { db, close } = createDb(url);
  try {
    const result = await importRoster(db, opts);
    if (result.dryRun) {
      console.log(`${String(result.accepted)} row(s) validated for ${result.name} — nothing created`);
    } else {
      const csv = credentialsCsv(result.created);
      if (opts.out === undefined) {
        // To stdout by default, so `> accounts.csv` works and so the passwords
        // are never written to a file the operator did not ask for.
        process.stdout.write(csv);
      } else {
        await writeFile(opts.out, csv, 'utf8');
        console.log(`wrote ${String(result.created.length)} account(s) to ${opts.out}`);
      }
      console.error(
        `created ${String(result.created.length)} account(s) in ${result.name}. ` +
          'These passwords are stored nowhere else and cannot be recovered; ' +
          'each account must change its password at first sign-in.',
      );
    }
  } catch (err) {
    if (err instanceof ImportValidationError) {
      console.error(`refused: nothing was created (at most ${String(IMPORT_MAX_ROWS)} rows per run)`);
      for (const line of describeValidationError(err)) console.error(`  ${line}`);
      await close();
      process.exit(2);
    }
    console.error(err instanceof Error ? err.message : String(err));
    await close();
    process.exit(1);
  }
  await close();
}
