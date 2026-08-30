/**
 * The HTTP half of D61's roster import: who may run one, how often, and what
 * a failure looks like on the wire.
 *
 * Every rule about what a roster row must be lives in `org-import.core.ts`,
 * which knows nothing about Nest or about status codes — see that file for
 * why. This class is the seam between it and the API: the owner check, the
 * meter, the translation of `ImportValidationError` into a 422, and the
 * notification the organization's owners get when it lands.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@duckoj/db';
import type {
  OrgMemberImportPreviewDto,
  OrgMemberImportRequestDto,
  OrgMemberImportResultDto,
} from '@duckoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { RateLimiter } from '../common/rate-limiter.js';
import type { Actor } from './actor.js';
import { OrgAccessService } from './org.access.js';
import {
  ImportValidationError,
  credentialsCsv,
  parseImportCsv,
  prepareAccounts,
  runImport,
  validateImportRows,
  type ImportRowError,
  type ImportRowInput,
} from './org-import.core.js';

/**
 * Ten imports per organization per minute (D61, amended by the F13 owed
 * sweep).
 *
 * It was one per minute, made race-free with `consumeOnce`, when one request
 * carried a whole 2,000-pupil roster. With the 500-row cap a large roster is
 * a SEQUENCE of requests, and a meter of exactly one would refuse the second
 * chunk of every import that needed chunking — so the shape has to change,
 * and `allow` is the shape for a limit above one.
 *
 * Ten × 500 is the same 5,000 rows a minute the old single call could
 * sustain, so nothing is throttled less than it was. Losing `consumeOnce`
 * costs nothing that mattered: what it defended against — the same roster
 * submitted twice at once — is refused anyway by the unique index on
 * `users.username`, inside the one transaction `runImport` writes, which the
 * mid-flight-collision test already pins as a 422 naming the row.
 *
 * Keyed on the organization ID, never the slug: a slug is patchable
 * (`UpdateOrgRequest`), so a meter keyed on one could be reset by renaming
 * the school. A `dryRun` consumes nothing at all.
 */
const IMPORT_PURPOSE = 'org_member_import';
const IMPORT_WINDOW_MS = 60_000;
const IMPORT_LIMIT_PER_WINDOW = 10;

@Injectable()
export class OrgImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OrgAccessService) private readonly orgs: OrgAccessService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  async importMembers(
    actor: Actor,
    slug: string,
    body: OrgMemberImportRequestDto,
  ): Promise<{ created: true; result: OrgMemberImportResultDto } | { created: false; preview: OrgMemberImportPreviewDto }> {
    const org = await this.orgs.loadForOwner(actor, slug);
    const rows = toRows(body);

    // Validated BEFORE the meter is consumed and before a single hash is
    // computed: a rejected file must cost the organization neither its
    // once-a-minute window nor this process any CPU.
    let validated;
    try {
      validated = await validateImportRows(this.db, rows, org.slug);
    } catch (error) {
      throw toValidationFailure(error);
    }
    if (body.dryRun) {
      return { created: false, preview: { rows: validated } };
    }

    // `allow` records the refused attempt too, so a client looping past the
    // limit keeps burning its own window. The seconds for `Retry-After` are
    // read back afterwards; that second call leaves a duplicate refusal
    // marker, the same harmless wart `RateLimiter.retryAfterSeconds` already
    // documents for login's two keys.
    const meterKey = `org:${String(org.id)}`;
    if (
      !(await this.limiter.allow(
        IMPORT_PURPOSE,
        meterKey,
        IMPORT_LIMIT_PER_WINDOW,
        IMPORT_WINDOW_MS,
      ))
    ) {
      const retryAfter = await this.limiter.retryAfterSeconds(
        IMPORT_PURPOSE,
        meterKey,
        IMPORT_LIMIT_PER_WINDOW,
        IMPORT_WINDOW_MS,
      );
      throw new AppError(
        429,
        'member_import_rate_limited',
        'Too many imports for this organization in the last minute.',
        undefined,
        { 'Retry-After': String(retryAfter ?? 1) },
      );
    }

    const prepared = await prepareAccounts(validated);
    try {
      // The owners' notification (D14) is written by `runImport` itself,
      // inside its transaction — see that function for why it is not routed
      // through `NotificationsService` like every other producer.
      await runImport(this.db, org, prepared, actor.userId);
    } catch (error) {
      // Somebody registered one of these usernames during the seconds this
      // call spent hashing. The transaction rolled back, so nothing was
      // created — re-run validation to find out WHICH row, because a Postgres
      // unique violation names the index and never the row.
      if (isUniqueViolation(error)) {
        try {
          await validateImportRows(this.db, rows, org.slug);
        } catch (revalidated) {
          throw toValidationFailure(revalidated);
        }
      }
      throw error;
    }

    const created = prepared.map((account) => ({
      username: account.username,
      displayName: account.displayName,
      password: account.password,
    }));
    return { created: true, result: { created, csv: credentialsCsv(created) } };
  }
}

/**
 * Exactly one of `csv` and `rows`. Neither is the empty request a client
 * sends by mistake; both is a client that does not know which it meant, and
 * silently preferring one would import a roster nobody asked for.
 */
function toRows(body: OrgMemberImportRequestDto): ImportRowInput[] {
  const hasCsv = body.csv !== undefined;
  const hasRows = body.rows !== undefined;
  if (hasCsv === hasRows) {
    throw new AppError(
      422,
      'import_body_invalid',
      'Send exactly one of `csv` and `rows`.',
    );
  }
  if (body.csv !== undefined) return parseImportCsv(body.csv);
  return (body.rows ?? []).map((row) => {
    const out: ImportRowInput = { username: row.username, displayName: row.displayName };
    if (row.email !== undefined) out.email = row.email;
    return out;
  });
}

/**
 * `ImportValidationError` as a 422, with every bad row in `fields`.
 *
 * `fields` is `Record<string, string[]>` — the only structured slot
 * `ProblemDetails` has — so the row number is encoded in the KEY,
 * `rows[<n>].<field>`, with `n` the 1-based data row. That is what lets a
 * client put each message next to the row that caused it without widening
 * the error schema every other endpoint shares. A row can fail on more than
 * one field, and one field can fail twice (invalid AND duplicated), so the
 * values are arrays and are appended to rather than overwritten.
 */
function toValidationFailure(error: unknown): unknown {
  if (!(error instanceof ImportValidationError)) return error;
  const fields: Record<string, string[]> = {};
  for (const row of error.errors as ImportRowError[]) {
    const key = `rows[${String(row.row)}].${row.field}`;
    (fields[key] ??= []).push(row.message);
  }
  return new AppError(
    422,
    'member_import_invalid',
    `${String(error.errors.length)} row(s) cannot be imported; nothing was created.`,
    fields,
  );
}

/** Postgres SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const shape = (value: unknown): boolean =>
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === UNIQUE_VIOLATION;
  if (shape(error)) return true;
  return error instanceof Error && shape(error.cause);
}
