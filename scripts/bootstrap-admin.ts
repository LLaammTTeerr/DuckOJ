/**
 * Mint (or promote) the first admin on a database:
 *
 *   corepack pnpm bootstrap:admin <username> [--email e] [--password p]
 *
 * `PATCH /admin/users/:username` can grant `admin`, but only to a caller who
 * is already one, so it has no path to the *first* admin on a fresh
 * database — see docs/runbook.md, "Bootstrapping the first admin". This
 * replaces the manual `UPDATE users SET global_role = 'admin'` that step
 * used to prescribe; the SQL remains documented there as the recovery
 * fallback for a database this script cannot reach.
 *
 * Deliberately a CLI against `DATABASE_URL`, not an endpoint: an HTTP route
 * that can create an admin is a permanent hole that only has to be reachable
 * once to be a breach, and it would have to be authenticated by something —
 * which is the very thing that does not exist yet at bootstrap time.
 *
 * The password is hashed by `apps/api/src/authn/password.hash.ts`, the same
 * module `AuthService.register` goes through. The parameters are imported,
 * never restated: an admin hashed at weaker settings than every other
 * account still verifies (argon2's encoding carries its own parameters), so
 * a drifted copy would be invisible rather than loud.
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema, type Db } from '@duckoj/db';
import { hashPassword } from '../apps/api/src/authn/password.hash.js';

/**
 * Matches `Password` in `packages/contracts/src/auth.ts`. The brief only
 * requires refusing an *empty* password; refusing a short one too keeps the
 * one account that can do everything from being the one account exempt from
 * the rule every registered user is held to.
 */
const MIN_PASSWORD_LENGTH = 10;

export interface BootstrapAdminOptions {
  username: string;
  email?: string | undefined;
  password?: string | undefined;
}

export interface BootstrapAdminResult {
  action: 'created' | 'promoted';
  username: string;
  email: string;
  /** Set only when this run generated one — it is printed exactly once. */
  generatedPassword?: string;
  /** True when the row was already `admin` and this run changed nothing. */
  alreadyAdmin: boolean;
}

/**
 * 24 base64url characters ≈ 144 bits. Long enough that printing it once and
 * expecting the operator to paste it into a password manager is reasonable;
 * `base64url` so nothing in it needs shell quoting.
 */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Creates the user if absent and makes them an admin; otherwise **only**
 * promotes. Re-running this against a real, in-use account must never reset
 * that account's password or rewrite its address — a "bootstrap" command
 * that quietly does either is a foot-gun aimed at the one account with the
 * most to lose.
 */
export async function bootstrapAdmin(db: Db, opts: BootstrapAdminOptions): Promise<BootstrapAdminResult> {
  const username = opts.username.trim();
  if (username === '') throw new Error('username is required');

  const existing = (
    await db
      .select()
      .from(schema.users)
      // `lower(...)` to match `users_username_lower_idx`: usernames are
      // unique case-insensitively, so a case-sensitive lookup here would
      // "not find" Alice and then fail the insert on the unique index.
      .where(sql`lower(${schema.users.username}) = lower(${username})`)
  )[0];

  if (existing) {
    if (existing.globalRole === 'admin') {
      return { action: 'promoted', username: existing.username, email: existing.email, alreadyAdmin: true };
    }
    await db
      .update(schema.users)
      .set({ globalRole: 'admin', updatedAt: new Date() })
      .where(eq(schema.users.id, existing.id));
    return { action: 'promoted', username: existing.username, email: existing.email, alreadyAdmin: false };
  }

  const generated = opts.password === undefined ? generatePassword() : undefined;
  const password = opts.password ?? generated!;
  if (password.length === 0) throw new Error('refusing an empty password');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`refusing a password shorter than ${String(MIN_PASSWORD_LENGTH)} characters`);
  }

  // A placeholder rather than a prompt: this command runs unattended in
  // provisioning scripts, and a required flag would make it fail there for
  // a field the admin can change from their own profile screen afterwards.
  const email = opts.email ?? `${username}@bootstrap.local`;

  const [created] = await db
    .insert(schema.users)
    .values({
      username,
      email,
      displayName: username,
      passwordHash: await hashPassword(password),
      globalRole: 'admin',
      // The brief's `email_verified=true`. The column is a timestamp
      // (`packages/db/src/schema/identity.ts`), and a fresh install has no
      // SMTP server configured, so leaving it null would park the first
      // admin behind a mail that will never arrive.
      emailVerifiedAt: new Date(),
    })
    .returning();

  const result: BootstrapAdminResult = {
    action: 'created',
    username: created!.username,
    email: created!.email,
    alreadyAdmin: false,
  };
  if (generated !== undefined) result.generatedPassword = generated;
  return result;
}

interface ParsedArgs {
  username: string;
  email?: string | undefined;
  password?: string | undefined;
}

/** Exported for the CLI only; `--flag value`, no `--flag=value` form. */
export function parseArgs(argv: string[]): ParsedArgs {
  let username: string | undefined;
  let email: string | undefined;
  let password: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--email' || arg === '--password') {
      const value = argv[i + 1];
      // `--password` with nothing after it is a typo, not an empty
      // password; treating it as one would create an unloggable admin.
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--email') email = value;
      else password = value;
      i++;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    if (username !== undefined) throw new Error(`unexpected extra argument: ${arg}`);
    username = arg;
  }

  if (username === undefined) throw new Error('usage: bootstrap-admin <username> [--email e] [--password p]');
  return { username, email, password };
}

/**
 * `import.meta.main` is Node 24+; this repo is on Node 22, and the script is
 * also imported by tests for `bootstrapAdmin`, so the CLI half is guarded by
 * an explicit argv comparison instead.
 */
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
    const result = await bootstrapAdmin(db, opts);
    if (result.action === 'created') {
      console.log(`created ${result.username} <${result.email}> as global_role=admin, email verified`);
      if (result.generatedPassword !== undefined) {
        console.log(`generated password: ${result.generatedPassword}`);
        console.log('This is printed once. Store it now — nothing can recover it later.');
      }
    } else if (result.alreadyAdmin) {
      console.log(`${result.username} was already global_role=admin — nothing to do`);
    } else {
      console.log(`promoted ${result.username} to global_role=admin (password and email untouched)`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    await close();
    process.exit(1);
  }
  await close();
}
