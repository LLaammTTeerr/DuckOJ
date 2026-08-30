/**
 * Bulk student accounts for a school (D61) — the whole rule, with no
 * framework attached.
 *
 * Framework-free for the same reason `authn/password.hash.ts` is: the
 * operator-facing half of this feature is `corepack pnpm org:import`, which
 * runs against `DATABASE_URL` with no Nest container and no decorator support
 * in `scripts/tsconfig.json`. The HTTP route is `@SessionOnly` — a personal
 * access token is refused by `SessionOnlyGuard` before the handler runs — so
 * "let the script call the API with an admin token" is not available, and the
 * script must reach the database directly, exactly as `bootstrap-admin.ts`
 * does. Two copies of "what makes a roster row acceptable" is precisely the
 * drift that would let the CLI mint accounts the API would have refused, so
 * there is one copy and both callers import it.
 *
 * It lives under `authz/` because it writes `org_members`, and
 * `@duckoj/db/guarded` may only be imported from `apps/api/src/authz/**`
 * (eslint `no-restricted-imports`, runbook "Reading a guarded table"). It is
 * the third file in that directory to touch the organization tables, beside
 * `org.access.ts` and `org.visibility.ts`.
 *
 * Nothing here throws an `AppError` or knows a status code: it raises
 * `ImportValidationError`, and the Nest service that wraps it decides that a
 * validation failure is a 422. The CLI prints the same rows to a terminal.
 */
import { randomInt } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { DisplayName, Username } from '@duckoj/contracts';
import { schema, type Db } from '@duckoj/db';
import { orgMembers } from '@duckoj/db/guarded';
import { hashPassword } from '../authn/password.hash.js';

/**
 * The largest roster one call may carry.
 *
 * A province seats thousands of pupils, and 2,000 is one big school's whole
 * intake — past that the answer is two calls, not a longer one. The bound is
 * not cosmetic: every row costs one argon2id hash at the parameters every
 * other account is held to (19 MiB, 2 passes), so a full import occupies the
 * libuv thread pool for tens of seconds. See `PREPARE_CONCURRENCY`.
 */
export const IMPORT_MAX_ROWS = 2000;

/**
 * How many passwords are hashed at once.
 *
 * `@node-rs/argon2`'s async `hash` runs on the libuv thread pool, which is
 * four threads by default and is shared with every OTHER argon2 call this
 * process makes — every sign-in, every registration. `Promise.all` over two
 * thousand rows would enqueue two thousand 19 MiB jobs ahead of the next
 * person trying to log in. Four keeps the import at the pool's natural
 * throughput without also making it the only thing in the queue, and the
 * one-import-per-org-per-minute meter bounds how often this happens at all.
 */
const PREPARE_CONCURRENCY = 4;

/**
 * The alphabet a generated password is drawn from: no `I`, `L`, `O`, no
 * lowercase `i`, `l`, `o`, no `0`, no `1`.
 *
 * These credentials are read off a printed sheet by a thirteen-year-old and
 * typed into a login box, so the failure mode this exists to prevent is a
 * pupil who cannot sign in because their password contains a character they
 * cannot tell apart from another one. Fifty-four symbols over twelve
 * characters is about 69 bits, which is far more than the accounts need for
 * the days they exist before D61's forced change.
 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 12;

/** One row as it arrives, before anything has been checked. */
export interface ImportRowInput {
  username: string;
  displayName: string;
  email?: string | undefined;
}

/**
 * One thing wrong with one row.
 *
 * `row` is the 1-based index of the DATA row — the same number for a JSON
 * array element and for a CSV line once a header has been dropped — so a
 * teacher looking at a spreadsheet and a developer looking at a request body
 * are told the same thing. `row: 0` means the problem is with the file as a
 * whole (empty, too long, unparseable).
 */
export interface ImportRowError {
  row: number;
  field: 'username' | 'displayName' | 'email' | 'file';
  code: string;
  message: string;
}

/** Raised by `validateImportRows`; the caller decides what status that is. */
export class ImportValidationError extends Error {
  constructor(readonly errors: ImportRowError[]) {
    super(`${String(errors.length)} row(s) failed validation`);
    this.name = 'ImportValidationError';
  }
}

/** A validated row, with the address the account will actually carry. */
export interface ValidatedRow {
  username: string;
  displayName: string;
  email: string;
  /** False when `email` is the placeholder this module synthesised. */
  emailProvided: boolean;
}

/** A validated row plus the credential nobody will be able to recover later. */
export interface PreparedAccount extends ValidatedRow {
  password: string;
  passwordHash: string;
}

/** What a completed import hands back — once. */
export interface ImportedCredential {
  username: string;
  displayName: string;
  password: string;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 with the concessions a spreadsheet export actually needs: CRLF or
 * LF, `""` for a literal quote inside a quoted field, and a trailing newline
 * that does not invent an empty final row.
 *
 * Hand-written rather than a dependency because the whole grammar is thirty
 * lines and the alternative is a parser with its own options, its own
 * type-coercion opinions and its own idea of what a header is — three things
 * that would each need pinning down here anyway.
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ',' || ch === ';' || ch === '\t') {
      record.push(field);
      field = '';
      sawAnyChar = true;
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      record.push(field);
      if (sawAnyChar || record.some((cell) => cell.trim() !== '')) records.push(record);
      record = [];
      field = '';
      sawAnyChar = false;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }
  record.push(field);
  if (sawAnyChar || record.some((cell) => cell.trim() !== '')) records.push(record);
  return records;
}

/**
 * Header names this recognises, in both languages a teacher's spreadsheet is
 * likely to be in. A file with none of them is read positionally
 * (`username, displayName, email`), which is what a file pasted out of a
 * mail merge looks like.
 */
const HEADER_ALIASES: Record<string, 'username' | 'displayName' | 'email'> = {
  username: 'username',
  user: 'username',
  tendangnhap: 'username',
  taikhoan: 'username',
  displayname: 'displayName',
  display_name: 'displayName',
  name: 'displayName',
  fullname: 'displayName',
  hoten: 'displayName',
  email: 'email',
  mail: 'email',
  thudientu: 'email',
};

/** Lowercased, stripped of spaces, punctuation and Vietnamese diacritics. */
function headerKey(cell: string): string {
  return cell
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z_]/g, '');
}

/**
 * A CSV roster as `ImportRowInput[]`.
 *
 * The header row is optional and is detected rather than assumed: a file
 * whose first record names at least a username column is a header, anything
 * else is data. Assuming one would silently swallow the first pupil of every
 * headerless file; requiring one would refuse the file a teacher typed by
 * hand.
 */
export function parseImportCsv(text: string): ImportRowInput[] {
  const records = parseCsvRecords(text.replace(/^\ufeff/, ''));
  if (records.length === 0) return [];

  let columns: Array<'username' | 'displayName' | 'email' | null> = ['username', 'displayName', 'email'];
  let body = records;
  const first = records[0]!.map((cell) => HEADER_ALIASES[headerKey(cell)] ?? null);
  if (first.includes('username')) {
    columns = first;
    body = records.slice(1);
  }

  return body.map((record) => {
    const cell = (want: 'username' | 'displayName' | 'email'): string => {
      const at = columns.indexOf(want);
      return at === -1 ? '' : (record[at] ?? '').trim();
    };
    const email = cell('email');
    const row: ImportRowInput = { username: cell('username'), displayName: cell('displayName') };
    if (email !== '') row.email = email;
    return row;
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The address an account gets when the roster does not name one.
 *
 * A school hands out accounts to pupils who have no school mailbox, and
 * `users.email` is `NOT NULL` and uniquely indexed, so something has to go
 * there. It is derived from the username, which is itself unique
 * case-insensitively, so the placeholders cannot collide with each other; the
 * `.import.invalid` suffix is under the reserved TLD of RFC 2606, so it can
 * never be delivered to and can never be somebody's real address.
 */
export function placeholderEmail(username: string, orgSlug: string): string {
  return `${username.toLowerCase()}@${orgSlug.toLowerCase()}.import.invalid`;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Every row checked, against the rules and against each other and against the
 * database — and then, if anything at all failed, nothing is created.
 *
 * All-or-nothing is the product decision, not an implementation convenience.
 * A partial import leaves a teacher holding a printout that is right for some
 * of their class and silently wrong for the rest, with no way to tell which
 * without reading every line; and the natural repair — run it again — then
 * trips over the accounts the first run did create. One refusal listing every
 * bad row is a file they can fix and resubmit.
 */
export async function validateImportRows(
  db: Db,
  rows: ImportRowInput[],
  orgSlug: string,
): Promise<ValidatedRow[]> {
  const errors: ImportRowError[] = [];
  if (rows.length === 0) {
    errors.push({ row: 0, field: 'file', code: 'import_empty', message: 'The list is empty.' });
    throw new ImportValidationError(errors);
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    errors.push({
      row: 0,
      field: 'file',
      code: 'import_too_many_rows',
      message: `At most ${String(IMPORT_MAX_ROWS)} rows may be imported at once; this list has ${String(rows.length)}.`,
    });
    throw new ImportValidationError(errors);
  }

  const validated: ValidatedRow[] = [];
  // Case-folded, because `users_username_lower_idx` and `users_email_lower_idx`
  // are: two rows differing only in case are ONE account to the database, and
  // a duplicate check that compared raw strings would pass validation and then
  // fail the insert — turning a legible 422 into a rolled-back 500.
  const seenUsernames = new Map<string, number>();
  const seenEmails = new Map<string, number>();

  rows.forEach((raw, index) => {
    const row = index + 1;
    const username = raw.username.trim();
    const usernameCheck = Username.safeParse(username);
    if (!usernameCheck.success) {
      errors.push({
        row,
        field: 'username',
        code: 'username_invalid',
        message:
          'A username is 3 to 32 characters of letters, digits, dot, underscore or hyphen (D8 — it can never be changed).',
      });
    }
    const displayCheck = DisplayName.safeParse(raw.displayName);
    if (!displayCheck.success) {
      errors.push({
        row,
        field: 'displayName',
        code: 'display_name_invalid',
        message: 'A display name is 1 to 100 characters that are not all whitespace.',
      });
    }

    const given = raw.email?.trim();
    if (given !== undefined && given !== '' && (!EMAIL_SHAPE.test(given) || given.length > 254)) {
      errors.push({ row, field: 'email', code: 'email_invalid', message: 'That is not an email address.' });
    }
    if (!usernameCheck.success || !displayCheck.success) return;

    const emailProvided = given !== undefined && given !== '' && EMAIL_SHAPE.test(given) && given.length <= 254;
    const email = emailProvided ? given : placeholderEmail(username, orgSlug);

    const usernameKey = username.toLowerCase();
    const first = seenUsernames.get(usernameKey);
    if (first !== undefined) {
      errors.push({
        row,
        field: 'username',
        code: 'username_duplicate',
        message: `This username also appears on row ${String(first)} — usernames differing only in case are the same account.`,
      });
    } else {
      seenUsernames.set(usernameKey, row);
    }

    const emailKey = email.toLowerCase();
    const firstEmail = seenEmails.get(emailKey);
    if (firstEmail !== undefined) {
      errors.push({
        row,
        field: 'email',
        code: 'email_duplicate',
        message: `This address also appears on row ${String(firstEmail)}.`,
      });
    } else {
      seenEmails.set(emailKey, row);
    }

    validated.push({ username, displayName: displayCheck.data, email, emailProvided });
  });

  // One query for the whole file rather than one per row: a two-thousand-row
  // roster is two thousand round trips otherwise, before a single account has
  // been created.
  const taken = await takenIdentities(db, [...seenUsernames.keys()], [...seenEmails.keys()]);
  for (const [key, row] of seenUsernames) {
    if (taken.usernames.has(key)) {
      errors.push({
        row,
        field: 'username',
        code: 'username_taken',
        message: 'Somebody already has that username.',
      });
    }
  }
  for (const [key, row] of seenEmails) {
    if (taken.emails.has(key)) {
      errors.push({
        row,
        field: 'email',
        code: 'email_taken',
        message: 'Somebody already has that address.',
      });
    }
  }

  if (errors.length > 0) {
    errors.sort((a, b) => a.row - b.row);
    throw new ImportValidationError(errors);
  }
  return validated;
}

/** Which of these case-folded usernames and addresses already exist. */
async function takenIdentities(
  db: Db,
  usernames: string[],
  emails: string[],
): Promise<{ usernames: Set<string>; emails: Set<string> }> {
  const result = { usernames: new Set<string>(), emails: new Set<string>() };
  const conditions = [
    usernames.length > 0 ? inArray(sql`lower(${schema.users.username})`, usernames) : undefined,
    emails.length > 0 ? inArray(sql`lower(${schema.users.email})`, emails) : undefined,
  ].filter((c) => c !== undefined);
  if (conditions.length === 0) return result;
  const rows = await db
    .select({ username: schema.users.username, email: schema.users.email })
    .from(schema.users)
    .where(or(...conditions));
  for (const row of rows) {
    result.usernames.add(row.username.toLowerCase());
    result.emails.add(row.email.toLowerCase());
  }
  return result;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export function generatePassword(): string {
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

/**
 * Generates and hashes one password per row — the expensive half, kept
 * deliberately OUTSIDE the transaction `runImport` opens.
 *
 * Two thousand argon2id hashes is tens of seconds of CPU. Doing that inside
 * the transaction would hold a write transaction (and its share of the
 * connection pool) open for the whole of it, on a database also serving a
 * live contest.
 */
export async function prepareAccounts(rows: ValidatedRow[]): Promise<PreparedAccount[]> {
  const prepared: PreparedAccount[] = new Array<PreparedAccount>(rows.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const row = rows[index];
      if (row === undefined) return;
      const password = generatePassword();
      prepared[index] = { ...row, password, passwordHash: await hashPassword(password) };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PREPARE_CONCURRENCY, rows.length) }, () => worker()),
  );
  return prepared;
}

/** Rows per INSERT. Postgres caps a statement at 65,535 bound parameters. */
const INSERT_CHUNK = 500;

/**
 * Creates every account and every membership, or none of them.
 *
 * `emailVerifiedAt` follows D19's ruling for `bootstrap-admin`, for D19's
 * reason and only where that reason holds: an account whose address this
 * module invented is marked verified, because the alternative parks it behind
 * a mail that can never be delivered to a `.invalid` domain. An account whose
 * address the ROSTER supplied is left unverified and goes through the
 * ordinary verification flow — the school asserting a pupil's real mailbox is
 * not the same thing as that mailbox having been confirmed.
 *
 * A unique violation here means somebody registered one of these usernames
 * during the seconds this call spent hashing. The transaction rolls back, and
 * the caller re-runs validation to say which row it was — `constraint_name`
 * names the index, never the row.
 */
export async function runImport(
  db: Db,
  org: { id: number; slug: string },
  prepared: PreparedAccount[],
  onOwnersNotified?: (tx: Db, ownerIds: number[], created: number) => Promise<void>,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const userIds: number[] = [];
    for (let at = 0; at < prepared.length; at += INSERT_CHUNK) {
      const chunk = prepared.slice(at, at + INSERT_CHUNK);
      const inserted = await tx
        .insert(schema.users)
        .values(
          chunk.map((account) => ({
            username: account.username,
            email: account.email,
            displayName: account.displayName,
            passwordHash: account.passwordHash,
            mustChangePassword: true,
            emailVerifiedAt: account.emailProvided ? null : now,
          })),
        )
        .returning({ id: schema.users.id });
      for (const row of inserted) userIds.push(row.id);
    }
    for (let at = 0; at < userIds.length; at += INSERT_CHUNK) {
      await tx.insert(orgMembers).values(
        userIds.slice(at, at + INSERT_CHUNK).map((userId) => ({
          orgId: org.id,
          userId,
          role: 'member' as const,
        })),
      );
    }
    if (onOwnersNotified) {
      const owners = await tx
        .select({ userId: orgMembers.userId, role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.role, 'owner')));
      await onOwnersNotified(
        tx as unknown as Db,
        owners.map((o) => o.userId),
        prepared.length,
      );
    }
  });
}

/**
 * The credential sheet, as a CSV a teacher can open in a spreadsheet.
 *
 * Built here rather than in the browser because the CLI needs the same bytes,
 * and because a printed sheet that disagrees with the file a school archives
 * is the one thing nobody can debug afterwards.
 */
export function credentialsCsv(created: ImportedCredential[]): string {
  const escape = (value: string): string =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines = ['username,displayName,password'];
  for (const row of created) {
    lines.push([row.username, row.displayName, row.password].map(escape).join(','));
  }
  return `${lines.join('\n')}\n`;
}
