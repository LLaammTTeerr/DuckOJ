/**
 * D61 — bulk student accounts for a school.
 *
 * The properties that carry this file are the ones a happy path cannot see:
 * that a file with ONE bad row creates nothing at all, that "already taken"
 * is decided the way the unique indexes decide it (case-folded, and against
 * the rest of the file as well as against the database), that the meter is
 * spent by a real import and never by a preview, and that an account minted
 * this way cannot be used until its holder has replaced the password that
 * came off the printout.
 */
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { orgMembers, organizations } from '@duckoj/db/guarded';
import { createDb, schema, type Db } from '@duckoj/db';
import { OrgAccessService } from '../src/authz/org.access.js';
import { OrgImportService } from '../src/authz/org.import.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { RateLimiter } from '../src/common/rate-limiter.js';
import { AuthService } from '../src/authn/auth.service.js';
import { PasswordService } from '../src/authn/password.service.js';
import { AppError } from '../src/common/app.error.js';
import { ORG_IMPORT_MAX_ROWS } from '@duckoj/contracts';
import { parseImportCsv, credentialsCsv, runImport } from '../src/authz/org-import.core.js';
import type { Actor } from '../src/authz/actor.js';
import { testDbUrl, withTestDb } from './db.harness.js';
import { insertUser } from './submissions.fixtures.js';

/**
 * Generous, and deliberately so: every account this file creates costs one
 * argon2id hash at production parameters (19 MiB, two passes), and the whole
 * API suite runs its spec files in parallel — so these tests queue behind
 * every other file's hashing on the same four-thread pool. Vitest's 5 s
 * default is a measurement of the machine's load, not of this code.
 */
const IMPORT_TEST_TIMEOUT_MS = 60_000;

function actorFor(userId: number, globalRole: Actor['globalRole'] = 'user'): Actor {
  return { userId, globalRole, via: 'session', scopes: [] };
}

function importService(db: Db): OrgImportService {
  return new OrgImportService(
    db,
    new OrgAccessService(db, new NotificationsService(db)),
    new RateLimiter(db),
  );
}

async function seedOrg(
  db: Db,
  slug: string,
  members: Array<{ userId: number; role: 'owner' | 'admin' | 'member' }>,
  visibility: 'public' | 'private' = 'public',
): Promise<number> {
  const [org] = await db
    .insert(organizations)
    .values({ slug, name: `Trường ${slug}`, visibility })
    .returning({ id: organizations.id });
  for (const member of members) {
    await db.insert(orgMembers).values({ orgId: org!.id, userId: member.userId, role: member.role });
  }
  return org!.id;
}

async function userCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
  return row?.n ?? 0;
}

const ROWS = [
  { username: 'hs001', displayName: 'Nguyễn Văn A' },
  { username: 'hs002', displayName: 'Trần Thị B' },
];

describe('importing a roster', () => {
  it('creates the accounts, adds them as members, and hands the passwords back once', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      const orgId = await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);

      const outcome = await importService(db).importMembers(actorFor(owner.id), 'thpt-a', {
        rows: ROWS,
        dryRun: false,
      });

      expect(outcome.created).toBe(true);
      if (!outcome.created) return;
      expect(outcome.result.created.map((row) => row.username)).toEqual(['hs001', 'hs002']);
      for (const credential of outcome.result.created) {
        // Twelve characters from the unambiguous alphabet: no I/L/O, no
        // lowercase i/l/o, no 0 and no 1 — these are typed off a printed
        // sheet by a child.
        expect(credential.password).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{12}$/);
      }
      // Every password is distinct: one shared password for a class would
      // make the whole roster one credential.
      expect(new Set(outcome.result.created.map((c) => c.password)).size).toBe(2);
      expect(outcome.result.csv.split('\n')[0]).toBe('username,displayName,password');
      expect(outcome.result.csv).toContain(outcome.result.created[0]!.password);

      const created = await db
        .select()
        .from(schema.users)
        .where(sql`${schema.users.username} in ('hs001','hs002')`);
      expect(created).toHaveLength(2);
      for (const row of created) {
        expect(row.mustChangePassword).toBe(true);
        // No address was given, so the account carries a `.invalid`
        // placeholder and is marked verified (D19's reasoning): no mail can
        // ever be delivered to it, so parking the account behind one would
        // park it forever.
        expect(row.email).toBe(`${row.username}@thpt-a.import.invalid`);
        expect(row.emailVerifiedAt).not.toBeNull();
      }

      const roster = await db.select().from(orgMembers).where(eq(orgMembers.orgId, orgId));
      expect(roster.filter((r) => r.role === 'member')).toHaveLength(2);
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('leaves a supplied address unverified, unlike the placeholder it invents', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);
      await importService(db).importMembers(actorFor(owner.id), 'thpt-a', {
        rows: [{ username: 'hs001', displayName: 'A', email: 'a@example.com' }],
        dryRun: false,
      });
      const [row] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.username, 'hs001'));
      expect(row!.email).toBe('a@example.com');
      // The school asserting a pupil's mailbox is not that mailbox having
      // been confirmed — the ordinary verification flow still applies.
      expect(row!.emailVerifiedAt).toBeNull();
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('creates NOTHING when a single row is unacceptable, and names every bad row', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);
      const before = await userCount(db);

      const failure = await importService(db)
        .importMembers(actorFor(owner.id), 'thpt-a', {
          rows: [
            { username: 'hs001', displayName: 'Ổn' },
            { username: 'x', displayName: 'Quá ngắn' },
            { username: 'hs003', displayName: '   ' },
          ],
          dryRun: false,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AppError);
      const error = failure as AppError;
      expect(error.status).toBe(422);
      expect(error.code).toBe('member_import_invalid');
      expect(Object.keys(error.fields ?? {}).sort()).toEqual([
        'rows[2].username',
        'rows[3].displayName',
      ]);
      // All-or-nothing: the two good rows are not created either.
      expect(await userCount(db)).toBe(before);
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('refuses a username that collides only in case, in the file or in the database', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      await insertUser(db, 'HS001');
      await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);

      const failure = (await importService(db)
        .importMembers(actorFor(owner.id), 'thpt-a', {
          rows: [
            { username: 'hs001', displayName: 'Trùng với người đã có' },
            { username: 'hs002', displayName: 'Lần một' },
            { username: 'HS002', displayName: 'Lần hai' },
          ],
          dryRun: false,
        })
        .catch((error: unknown) => error)) as AppError;

      expect(failure.status).toBe(422);
      // `users_username_lower_idx` is case-insensitive, so these are the same
      // account to the database. A raw-string duplicate check would pass
      // validation here and then fail the INSERT — turning a legible 422 into
      // a rolled-back 500.
      expect(failure.fields?.['rows[1].username']?.[0]).toContain('already has that username');
      expect(failure.fields?.['rows[3].username']?.[0]).toContain('row 2');
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('admits a sequence of chunks and stops at ten a minute, exempting previews', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);
      const service = importService(db);

      // A preview costs nothing: a teacher fixing one bad row and trying
      // again must not be told to come back in a minute.
      for (let i = 0; i < 3; i++) {
        const preview = await service.importMembers(actorFor(owner.id), 'thpt-a', {
          rows: ROWS,
          dryRun: true,
        });
        expect(preview.created).toBe(false);
      }

      // A 2,000-pupil roster is now four requests, not one (D61 amended), so
      // a meter of exactly one per minute would refuse the second chunk of
      // every large import. Ten a minute is the same work per minute the old
      // single 2,000-row call could do.
      for (let i = 0; i < 10; i++) {
        const done = await service.importMembers(actorFor(owner.id), 'thpt-a', {
          rows: [{ username: `hs10${String(i)}`, displayName: `Chunk ${String(i)}` }],
          dryRun: false,
        });
        expect(done.created).toBe(true);
      }

      const refused = (await service
        .importMembers(actorFor(owner.id), 'thpt-a', {
          rows: [{ username: 'hs900', displayName: 'Sau đó' }],
          dryRun: false,
        })
        .catch((error: unknown) => error)) as AppError;

      expect(refused.status).toBe(429);
      expect(refused.code).toBe('member_import_rate_limited');
      expect(Number(refused.headers?.['Retry-After'])).toBeGreaterThan(0);
      // The refusal created nothing.
      const stragglers = await db.select().from(schema.users).where(eq(schema.users.username, 'hs900'));
      expect(stragglers).toHaveLength(0);
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('refuses more than five hundred rows in one request, and says to split the file', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);
      const service = importService(db);

      // 501 rows, validated only — nothing is hashed, so this is cheap.
      const rows = Array.from({ length: ORG_IMPORT_MAX_ROWS + 1 }, (_, i) => ({
        username: `hs${String(i).padStart(4, '0')}`,
        displayName: `Pupil ${String(i)}`,
      }));
      const failure = (await service
        .importMembers(actorFor(owner.id), 'thpt-a', { rows, dryRun: true })
        .catch((error: unknown) => error)) as AppError;

      expect(ORG_IMPORT_MAX_ROWS).toBe(500);
      expect(failure.status).toBe(422);
      expect(failure.fields?.['rows[0].file']?.[0]).toContain('500');
      // The hint is the whole point of the cap: a teacher with a province's
      // worth of pupils has to be told what to do next.
      expect(failure.fields?.['rows[0].file']?.[0]).toMatch(/split|chia/i);
      expect(await userCount(db)).toBe(1);
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('is for an OWNER or a global admin — an organization admin is refused', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      const orgAdmin = await insertUser(db, 'giaovu');
      const stranger = await insertUser(db, 'nguoila');
      const superuser = await insertUser(db, 'quantri', 'admin');
      await seedOrg(db, 'thpt-a', [
        { userId: owner.id, role: 'owner' },
        { userId: orgAdmin.id, role: 'admin' },
      ]);
      const service = importService(db);

      // Minting two thousand accounts on a province's judge is speaking FOR
      // the school, which the rank below owner does not.
      for (const actor of [actorFor(orgAdmin.id), actorFor(stranger.id)]) {
        const refused = (await service
          .importMembers(actor, 'thpt-a', { rows: ROWS, dryRun: true })
          .catch((error: unknown) => error)) as AppError;
        expect(refused.status).toBe(403);
        expect(refused.code).toBe('organization_forbidden');
      }

      const allowed = await service.importMembers(actorFor(superuser.id, 'admin'), 'thpt-a', {
        rows: ROWS,
        dryRun: true,
      });
      expect(allowed.created).toBe(false);
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('answers 404, not 403, for a private organization the caller may not see', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      const stranger = await insertUser(db, 'nguoila');
      await seedOrg(db, 'kin', [{ userId: owner.id, role: 'owner' }], 'private');

      const refused = (await importService(db)
        .importMembers(actorFor(stranger.id), 'kin', { rows: ROWS, dryRun: true })
        .catch((error: unknown) => error)) as AppError;
      expect(refused.status).toBe(404);
      expect(refused.code).toBe('organization_not_found');
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('refuses a body that names neither a csv nor rows, and one that names both', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);
      const service = importService(db);
      for (const body of [{ dryRun: true }, { csv: 'a,b', rows: ROWS, dryRun: true }]) {
        const refused = (await service
          .importMembers(actorFor(owner.id), 'thpt-a', body)
          .catch((error: unknown) => error)) as AppError;
        expect(refused.status).toBe(422);
        expect(refused.code).toBe('import_body_invalid');
      }
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('tells the organization owners that a roster landed (D14)', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      const other = await insertUser(db, 'phohieutruong');
      const plainMember = await insertUser(db, 'hocsinhcu');
      await seedOrg(db, 'thpt-a', [
        { userId: owner.id, role: 'owner' },
        { userId: other.id, role: 'owner' },
        { userId: plainMember.id, role: 'member' },
      ]);
      await importService(db).importMembers(actorFor(owner.id), 'thpt-a', { rows: ROWS, dryRun: false });

      const notes = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, 'org_members_imported'));
      expect(notes.map((n) => n.userId).sort()).toEqual([owner.id, other.id].sort());
      expect(notes[0]!.payload).toMatchObject({ orgSlug: 'thpt-a', count: 2 });
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('accepts a CSV a spreadsheet exported, header or no header', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);

      const preview = await importService(db).importMembers(actorFor(owner.id), 'thpt-a', {
        csv: 'Tên đăng nhập;Họ tên;Email\r\nhs001;"Nguyễn Văn A";\r\nhs002;"Trần ""Bo"" B";b@e.com\r\n',
        dryRun: true,
      });
      expect(preview.created).toBe(false);
      if (preview.created) return;
      expect(preview.preview.rows).toEqual([
        {
          username: 'hs001',
          displayName: 'Nguyễn Văn A',
          email: 'hs001@thpt-a.import.invalid',
          emailProvided: false,
        },
        { username: 'hs002', displayName: 'Trần "Bo" B', email: 'b@e.com', emailProvided: true },
      ]);
    });
  }, IMPORT_TEST_TIMEOUT_MS);
});

/**
 * The other half of all-or-nothing, and the only one `withTestDb` cannot
 * show: an insert failing INSIDE `runImport`, after the writes have started.
 *
 * Every test above proves that a file refused by VALIDATION creates nothing,
 * which it does by never reaching the writes at all. This is the case that
 * actually happens in production — somebody registers one of these usernames
 * during the tens of seconds the call spends hashing, long after validation
 * passed — and it is the one the `isUniqueViolation` branch in
 * `OrgImportService` exists to answer.
 *
 * Two things about the shape, both load-bearing:
 *
 *  - **`testDbUrl()` with real committed rows, not `withTestDb`.** Inside a
 *    harness that wraps everything in one always-rolled-back transaction,
 *    `db.transaction` is a savepoint and "nothing survived" would be true
 *    however `runImport` were written.
 *  - **More rows than `INSERT_CHUNK` (500), with the collision in the SECOND
 *    chunk.** A single multi-row `INSERT` is atomic in Postgres whether or
 *    not anybody opened a transaction, so a two-row version of this test
 *    would pass with the transaction deleted. It takes a first statement
 *    that SUCCEEDS and a second that fails for the rollback to be the only
 *    thing standing between a failed import and five hundred orphaned
 *    accounts.
 *
 * The hashes are fabricated rather than computed: `runImport` stores whatever
 * it is handed, and five hundred real argon2id hashes would buy nothing here
 * but twenty seconds.
 */
describe('a write that fails part-way through (real committed rows)', () => {
  it('rolls back the chunk that already succeeded', async () => {
    const { db, close } = createDb(await testDbUrl());
    const CHUNK = 500;
    try {
      const owner = await insertUser(db, 'tx-owner');
      const orgId = await seedOrg(db, 'tx-org', [{ userId: owner.id, role: 'owner' }]);
      // Already taken, and deliberately NOT put through `validateImportRows`
      // — this is the state the world reaches between validation and the
      // insert, which no amount of pre-checking can rule out.
      await insertUser(db, 'tx-clash');

      const prepared = Array.from({ length: CHUNK + 1 }, (_, i) => ({
        username: i === CHUNK ? 'tx-clash' : `tx-fine-${String(i)}`,
        displayName: `Học sinh ${String(i)}`,
        email: `tx-${String(i)}@tx.invalid`,
        emailProvided: true,
        password: 'irrelevant',
        passwordHash: '$argon2id$fabricated',
      }));
      await expect(runImport(db, { id: orgId, slug: 'tx-org' }, prepared, owner.id)).rejects.toThrow();

      // The first five hundred were written by a statement that COMMITTED
      // nothing only because the transaction rolled it back.
      const survivors = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.users)
        .where(sql`${schema.users.username} like 'tx-fine-%'`);
      expect(survivors[0]?.n ?? 0).toBe(0);
      const roster = await db.select().from(orgMembers).where(eq(orgMembers.orgId, orgId));
      expect(roster.map((r) => r.role)).toEqual(['owner']);
      // And nobody was told about a roster that does not exist.
      expect(
        await db
          .select()
          .from(schema.notifications)
          .where(eq(schema.notifications.userId, owner.id)),
      ).toHaveLength(0);
    } finally {
      await close();
    }
  }, IMPORT_TEST_TIMEOUT_MS);
});

  /**
   * The same failure seen through the endpoint: a 422 naming the row, not a
   * 500.
   *
   * The race is opened deliberately rather than waited for. `importMembers`
   * validates, then takes the meter, then hashes, then writes — so a proxy
   * that creates the colliding account the first time anything opens a
   * transaction lands it exactly in the window between the check and the
   * write, which is where it lands in production. `onConflictDoNothing` makes
   * the hook idempotent, so it does not matter which of the two transactions
   * fires it.
   *
   * What is being proved is that the caller is TOLD which row. A Postgres
   * unique violation names the index and never the row, so the service
   * re-runs validation on the way out; without that, this is an opaque 500
   * for a condition the client can actually fix.
   */
  it('answers 422 naming the row when the collision appears mid-flight', async () => {
    const { db, close } = createDb(await testDbUrl());
    try {
      const owner = await insertUser(db, 'race-owner');
      await seedOrg(db, 'race-org', [{ userId: owner.id, role: 'owner' }]);

      const racing = new Proxy(db, {
        get(target, prop, receiver): unknown {
          if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
          return async (...args: unknown[]): Promise<unknown> => {
            await db
              .insert(schema.users)
              .values({
                username: 'race-clash',
                email: 'race-clash@race.invalid',
                displayName: 'Người khác đăng ký trước',
                passwordHash: 'x',
              })
              .onConflictDoNothing();
            return (target.transaction as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        },
      }) as Db;

      const service = new OrgImportService(
        racing,
        new OrgAccessService(racing, new NotificationsService(racing)),
        new RateLimiter(racing),
      );
      const failure = (await service
        .importMembers(actorFor(owner.id), 'race-org', {
          rows: [{ username: 'race-clash', displayName: 'Học sinh' }],
          dryRun: false,
        })
        .catch((error: unknown) => error)) as AppError;

      expect(failure).toBeInstanceOf(AppError);
      expect(failure.status).toBe(422);
      expect(failure.code).toBe('member_import_invalid');
      expect(failure.fields?.['rows[1].username']?.[0]).toContain('already has that username');
    } finally {
      await close();
    }
  }, IMPORT_TEST_TIMEOUT_MS);

describe('the CSV reader on its own', () => {
  it('reads a headerless file positionally and never swallows its first pupil', () => {
    expect(parseImportCsv('hs001,Nguyễn Văn A\nhs002,Trần Thị B\n')).toEqual([
      { username: 'hs001', displayName: 'Nguyễn Văn A' },
      { username: 'hs002', displayName: 'Trần Thị B' },
    ]);
  });

  it('drops a header row, tolerates a BOM, and ignores blank lines', () => {
    expect(parseImportCsv('﻿username,name\n\nhs001,A\n\n')).toEqual([
      { username: 'hs001', displayName: 'A' },
    ]);
  });

  it('quotes a password that contains a comma back out of the credential sheet', () => {
    const csv = credentialsCsv([{ username: 'u', displayName: 'Nguyễn, Văn A', password: 'p' }]);
    expect(csv).toBe('username,displayName,password\nu,"Nguyễn, Văn A",p\n');
  });
});

describe('the password an imported account must replace (D61)', () => {
  function auth(db: Db): AuthService {
    return new AuthService(db, new PasswordService());
  }

  it('accepts a new password with no old one while the flag is set, then never again', async () => {
    await withTestDb(async (db) => {
      const owner = await insertUser(db, 'hieutruong');
      await seedOrg(db, 'thpt-a', [{ userId: owner.id, role: 'owner' }]);
      const outcome = await importService(db).importMembers(actorFor(owner.id), 'thpt-a', {
        rows: [{ username: 'hs001', displayName: 'A' }],
        dryRun: false,
      });
      expect(outcome.created).toBe(true);
      const [pupil] = await db.select().from(schema.users).where(eq(schema.users.username, 'hs001'));

      // The password on record was printed on a sheet handed round a
      // classroom — demanding it back would make that sheet the credential
      // that authorises replacing it.
      await auth(db).changePassword(pupil!.id, undefined, 'mot-mat-khau-moi');

      const [after] = await db.select().from(schema.users).where(eq(schema.users.id, pupil!.id));
      expect(after!.mustChangePassword).toBe(false);
      expect(await new PasswordService().verify(after!.passwordHash, 'mot-mat-khau-moi')).toBe(true);

      // The flag is cleared, so the exception is gone with it.
      const refused = (await auth(db)
        .changePassword(pupil!.id, undefined, 'mot-mat-khau-khac')
        .catch((error: unknown) => error)) as AppError;
      expect(refused.status).toBe(422);
      expect(refused.code).toBe('current_password_required');
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('requires the current password from an ordinary account, and checks it', async () => {
    await withTestDb(async (db) => {
      const passwords = new PasswordService();
      const [user] = await db
        .insert(schema.users)
        .values({
          username: 'binhthuong',
          email: 'b@e.com',
          displayName: 'Bình thường',
          passwordHash: await passwords.hash('mat-khau-cu-cua-toi'),
        })
        .returning();

      const wrong = (await auth(db)
        .changePassword(user!.id, 'sai-mat-khau', 'mat-khau-moi-day')
        .catch((error: unknown) => error)) as AppError;
      expect(wrong.status).toBe(401);
      expect(wrong.code).toBe('invalid_credentials');

      await auth(db).changePassword(user!.id, 'mat-khau-cu-cua-toi', 'mat-khau-moi-day');
      const [after] = await db.select().from(schema.users).where(eq(schema.users.id, user!.id));
      expect(await passwords.verify(after!.passwordHash, 'mat-khau-moi-day')).toBe(true);
    });
  }, IMPORT_TEST_TIMEOUT_MS);

  it('ends every other session and token the account holds', async () => {
    await withTestDb(async (db) => {
      const passwords = new PasswordService();
      const [user] = await db
        .insert(schema.users)
        .values({
          username: 'binhthuong',
          email: 'b@e.com',
          displayName: 'Bình thường',
          passwordHash: await passwords.hash('mat-khau-cu-cua-toi'),
        })
        .returning();
      await db.insert(schema.sessions).values({
        userId: user!.id,
        tokenHash: 'phien-cu',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await db.insert(schema.accessTokens).values({
        userId: user!.id,
        name: 'ci',
        tokenHash: 'token-cu',
        scopes: [],
      });

      await auth(db).changePassword(user!.id, 'mat-khau-cu-cua-toi', 'mat-khau-moi-day');

      expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, user!.id))).toHaveLength(0);
      expect(
        await db.select().from(schema.accessTokens).where(eq(schema.accessTokens.userId, user!.id)),
      ).toHaveLength(0);
    });
  }, IMPORT_TEST_TIMEOUT_MS);
});
